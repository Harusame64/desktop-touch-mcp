use crossbeam_channel::{bounded, Receiver, Sender};
use std::{mem, slice, thread};

use windows::Win32::{
    Foundation::RECT,
    Graphics::Dxgi::{
        DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    },
};

use super::device::{create_context, DuplicationContext};
use super::types::{DirtyRect, DuplicationError, OutputBounds};

pub enum DuplicationCmd {
    Next {
        timeout_ms: u32,
        reply: Sender<Result<Vec<DirtyRect>, DuplicationError>>,
    },
    Stop,
}

pub struct DuplicationHandle {
    pub tx: Sender<DuplicationCmd>,
    pub bounds: OutputBounds,
}

pub fn spawn(output_index: u32) -> Result<DuplicationHandle, DuplicationError> {
    // Bootstrap channel to propagate init success/failure back to the caller.
    let (boot_tx, boot_rx) = bounded::<Result<OutputBounds, DuplicationError>>(1);
    let (cmd_tx, cmd_rx) = bounded::<DuplicationCmd>(32);

    thread::Builder::new()
        .name(format!("desktop-dup-{output_index}"))
        .spawn(move || {
            // Desktop Duplication API requires a COM-initialized thread.
            unsafe {
                use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }

            let mut ctx = match create_context(output_index) {
                Ok(c) => {
                    let _ = boot_tx.send(Ok(c.bounds.clone()));
                    c
                }
                Err(e) => {
                    let _ = boot_tx.send(Err(e));
                    return;
                }
            };

            run_loop(&mut ctx, cmd_rx, output_index);
        })
        .map_err(|e| DuplicationError::InitFailed(format!("thread spawn: {e}")))?;

    let bounds = boot_rx
        .recv()
        .map_err(|e| DuplicationError::InitFailed(format!("boot recv: {e}")))??;

    Ok(DuplicationHandle { tx: cmd_tx, bounds })
}

fn run_loop(ctx: &mut DuplicationContext, rx: Receiver<DuplicationCmd>, output_index: u32) {
    while let Ok(cmd) = rx.recv() {
        match cmd {
            DuplicationCmd::Stop => break,
            DuplicationCmd::Next { timeout_ms, reply } => {
                let result = acquire_dirty_rects(ctx, timeout_ms);
                // On ACCESS_LOST, attempt to re-create the context on this thread.
                let result = match result {
                    Err(DuplicationError::AccessLost) => {
                        match create_context(output_index) {
                            Ok(new_ctx) => {
                                *ctx = new_ctx;
                                // Signal the TS side to retry; it will call next() again.
                                Err(DuplicationError::AccessLost)
                            }
                            Err(e) => Err(e),
                        }
                    }
                    other => other,
                };
                let _ = reply.send(result);
            }
        }
    }
}

fn acquire_dirty_rects(
    ctx: &DuplicationContext,
    timeout_ms: u32,
) -> Result<Vec<DirtyRect>, DuplicationError> {
    unsafe {
        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource = None;

        let hr = ctx.duplication.AcquireNextFrame(timeout_ms, &mut frame_info, &mut resource);
        match hr {
            Ok(()) => {}
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(Vec::new()),
            Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST  => return Err(DuplicationError::AccessLost),
            Err(e) => return Err(DuplicationError::Other(format!("AcquireNextFrame: {e}"))),
        }

        let dirty_rects = if frame_info.TotalMetadataBufferSize == 0 {
            Vec::new()
        } else {
            let buf_size = frame_info.TotalMetadataBufferSize as usize;
            let mut buf = vec![0u8; buf_size];
            let mut required: u32 = 0;

            let dr = ctx.duplication.GetFrameDirtyRects(
                buf_size as u32,
                buf.as_mut_ptr() as *mut RECT,
                &mut required,
            );

            match dr {
                Ok(()) => {
                    let count = required as usize / mem::size_of::<RECT>();
                    let rect_ptr = buf.as_ptr() as *const RECT;
                    let native_rects = slice::from_raw_parts(rect_ptr, count);
                    native_rects
                        .iter()
                        .filter(|r| r.right > r.left && r.bottom > r.top)
                        .map(|r| DirtyRect {
                            // Translate from output-local to desktop coordinates.
                            x:      r.left   + ctx.bounds.x,
                            y:      r.top    + ctx.bounds.y,
                            width:  r.right  - r.left,
                            height: r.bottom - r.top,
                        })
                        .collect()
                }
                Err(_) => Vec::new(),
            }
        };

        // ReleaseFrame must always be called after a successful AcquireNextFrame.
        let _ = ctx.duplication.ReleaseFrame();

        Ok(dirty_rects)
    }
}
