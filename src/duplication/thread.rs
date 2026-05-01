use crossbeam_channel::{bounded, Receiver, Sender};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::{mem, slice, thread};

use windows::Win32::{
    Foundation::RECT,
    Graphics::Dxgi::{
        DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    },
};

use super::device::{create_context, DuplicationContext};
use super::types::{DirtyRect, DuplicationError, OutputBounds};

// P5c-2: L1 ring emit. `build_event` / `make_failure_event` /
// `encode_payload` / `EventKind` / `DirtyRectPayload` are crate-private
// helpers; `EventRing` is `pub` re-exported. The narrow `Arc<EventRing>`
// borrow keeps L1Inner privacy clean (P5c-1 same shape, see
// `src/uia/event_handlers/focus.rs:41-44`).
use crate::l1_capture::{
    build_event, encode_payload, ensure_l1, make_failure_event, DirtyRectPayload, EventKind,
    EventRing,
};

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
    /// Toggles the L1 ring emit fork in [`acquire_dirty_rects`]. Default is
    /// `true`; tests and graceful-disable paths flip it via
    /// [`DuplicationHandle::set_l1_emit_enabled`]. Storing the `Arc` on the
    /// handle (with another clone living on the duplication thread) keeps
    /// the toggle reachable from the napi side without exposing the field
    /// through `DirtyRectSubscription` (P5c-2 sub-plan §3.1: napi expose
    /// は変えない、internal API).
    pub enable_l1_emit: Arc<AtomicBool>,
}

impl DuplicationHandle {
    /// Internal-only toggle for the L1 ring emit fork. Used by Rust
    /// integration tests and by graceful-disable paths to mute emit
    /// without tearing the duplication thread down. Not exposed through
    /// the napi `DirtyRectSubscription` surface.
    #[allow(dead_code)] // wired up by tests + future graceful-disable callers
    pub fn set_l1_emit_enabled(&self, enabled: bool) {
        self.enable_l1_emit.store(enabled, Ordering::Relaxed);
    }
}

pub fn spawn(output_index: u32) -> Result<DuplicationHandle, DuplicationError> {
    // Bootstrap channel to propagate init success/failure back to the caller.
    let (boot_tx, boot_rx) = bounded::<Result<OutputBounds, DuplicationError>>(1);
    let (cmd_tx, cmd_rx) = bounded::<DuplicationCmd>(32);

    // P5c-2: L1 ring emit setup. The ring is shared with every other
    // emitter (P5c-1 focus / future P5c-3/4) via the global L1 slot.
    // `enable_l1_emit` and `frame_index` are owned by this duplication
    // thread; `enable_l1_emit` also lives on the returned `DuplicationHandle`
    // so callers can flip it without touching the thread directly.
    let ring = ensure_l1().ring.clone();
    let enable_l1_emit = Arc::new(AtomicBool::new(true));
    let frame_index = Arc::new(AtomicU64::new(0));

    let ring_for_thread = Arc::clone(&ring);
    let enable_l1_emit_for_thread = Arc::clone(&enable_l1_emit);
    let frame_index_for_thread = Arc::clone(&frame_index);

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
                    // P5c-2: graceful disable on DXGI unavailable. Push exactly
                    // one Failure event before the thread exits — the boot
                    // channel signals the caller, but the L1 ring is the
                    // observability surface for the perception pipeline.
                    let reason = format!("{:?}", e);
                    let event = make_failure_event(
                        "duplication",
                        "create_context",
                        &reason,
                        None,
                    );
                    ring_for_thread.push(event);

                    let _ = boot_tx.send(Err(e));
                    return;
                }
            };

            run_loop(
                &mut ctx,
                cmd_rx,
                output_index,
                ring_for_thread,
                enable_l1_emit_for_thread,
                frame_index_for_thread,
            );
        })
        .map_err(|e| DuplicationError::InitFailed(format!("thread spawn: {e}")))?;

    let bounds = boot_rx
        .recv()
        .map_err(|e| DuplicationError::InitFailed(format!("boot recv: {e}")))??;

    Ok(DuplicationHandle {
        tx: cmd_tx,
        bounds,
        enable_l1_emit,
    })
}

fn run_loop(
    ctx: &mut DuplicationContext,
    rx: Receiver<DuplicationCmd>,
    output_index: u32,
    ring: Arc<EventRing>,
    enable_l1_emit: Arc<AtomicBool>,
    frame_index: Arc<AtomicU64>,
) {
    // P5c-2: AccessLost spam suppression. Push exactly one Failure event
    // when DXGI's access-lost cycle exceeds 5 consecutive failures, then
    // stay quiet until a successful frame resets the counter. Mirrors the
    // P5c-1 focus handler's "log once, recover quietly" pattern (sub-plan
    // §3.2 / R4).
    let mut access_lost_count: u32 = 0;

    while let Ok(cmd) = rx.recv() {
        match cmd {
            DuplicationCmd::Stop => break,
            DuplicationCmd::Next { timeout_ms, reply } => {
                let result = acquire_dirty_rects(
                    ctx,
                    timeout_ms,
                    &ring,
                    &enable_l1_emit,
                    &frame_index,
                );
                // On ACCESS_LOST, attempt to re-create the context on this thread.
                let result = match result {
                    Err(DuplicationError::AccessLost) => {
                        // Spam suppression lives in a pure helper so the unit
                        // test in `mod tests` can hit the 5th-call threshold
                        // without spinning up a real DXGI duplication context.
                        record_access_lost(&mut access_lost_count, &ring);
                        match create_context(output_index) {
                            Ok(new_ctx) => {
                                *ctx = new_ctx;
                                // Signal the TS side to retry; it will call next() again.
                                Err(DuplicationError::AccessLost)
                            }
                            Err(e) => Err(e),
                        }
                    }
                    Ok(rects) => {
                        access_lost_count = 0;
                        Ok(rects)
                    }
                    other => other,
                };
                let _ = reply.send(result);
            }
        }
    }
}

/// Increment the AccessLost counter and push exactly one Failure event
/// to the L1 ring on the 5th consecutive AccessLost. Subsequent calls
/// (counter > 5) advance the counter but stay quiet — the caller is
/// expected to reset `*counter` to 0 on the next successful frame.
///
/// Pure helper so [`tests::access_lost_5th_call_pushes_exactly_one_failure`]
/// can hit the threshold without constructing a `DuplicationContext`
/// (which holds a DXGI interface and can't be mocked without hardware).
fn record_access_lost(counter: &mut u32, ring: &Arc<EventRing>) {
    *counter = counter.saturating_add(1);
    if *counter == 5 {
        let event = make_failure_event(
            "duplication",
            "AcquireNextFrame",
            "AccessLost: 5 consecutive failures",
            None,
        );
        ring.push(event);
    }
}

fn acquire_dirty_rects(
    ctx: &DuplicationContext,
    timeout_ms: u32,
    ring: &Arc<EventRing>,
    enable_l1_emit: &Arc<AtomicBool>,
    frame_index: &Arc<AtomicU64>,
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

        // P5c-2: emit fork. One `EventKind::DirtyRect` envelope per rect,
        // all sharing the same `frame_index` so the D2-C
        // `dirty_rects_aggregate` view can group them per frame
        // (views-catalog §3.2 `summary { count, total_area }`). `monitor_index`
        // is hard-coded to 0 — secondary monitors stay carry-over per
        // sub-plan §10 OQ #3.
        if enable_l1_emit.load(Ordering::Relaxed) && !dirty_rects.is_empty() {
            let frame_idx = frame_index.fetch_add(1, Ordering::Relaxed);
            for r in &dirty_rects {
                let payload = DirtyRectPayload {
                    rect: [r.x, r.y, r.width, r.height],
                    monitor_index: 0,
                    frame_index: frame_idx,
                };
                let event = build_event(
                    EventKind::DirtyRect as u16,
                    encode_payload(&payload),
                    None,
                    None,
                );
                ring.push(event);
            }
        }

        Ok(dirty_rects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::l1_capture::EventRing;
    use std::time::{Duration, Instant};

    /// Test 3 (sub-plan §3.3) — AccessLost spam suppression.
    ///
    /// `record_access_lost` is the pure helper extracted from `run_loop`'s
    /// AccessLost branch. We can't construct a real `DuplicationContext`
    /// without DXGI hardware, so the spam-suppression invariant
    /// (exactly 1 Failure event per 5 consecutive AccessLost calls) is
    /// pinned at the helper level instead. The integration in `run_loop`
    /// is a single line call site, so the helper test fully covers the
    /// behaviour the sub-plan §3.2 requires.
    #[test]
    fn access_lost_5th_call_pushes_exactly_one_failure() {
        let ring = Arc::new(EventRing::new(1024));
        let mut counter = 0u32;

        // Calls 1..=4: counter increments, no push.
        for _ in 0..4 {
            record_access_lost(&mut counter, &ring);
        }
        assert_eq!(counter, 4);
        let after_4 = ring.poll(0, 16);
        assert_eq!(
            after_4.len(),
            0,
            "no Failure event expected before the 5th call"
        );

        // Call 5: counter == 5 → exactly one Failure event.
        record_access_lost(&mut counter, &ring);
        assert_eq!(counter, 5);
        let after_5 = ring.poll(0, 16);
        assert_eq!(after_5.len(), 1);
        assert_eq!(after_5[0].kind, EventKind::Failure as u16);

        // Calls 6..=10: counter keeps incrementing but the helper stays
        // quiet — the caller is the one that resets the counter on a
        // successful frame.
        for _ in 0..5 {
            record_access_lost(&mut counter, &ring);
        }
        assert_eq!(counter, 10);
        let after_10 = ring.poll(0, 16);
        assert_eq!(
            after_10.len(),
            0,
            "drained to 0 by the after_5 poll, no further pushes expected"
        );
    }

    /// Test 1+2 (sub-plan §3.3) — emit fork enable / disable round-trip
    /// against real DXGI hardware. Skipped (returns early) on hosts where
    /// `spawn(0)` fails (RDP, headless CI, no GPU output, …) so the suite
    /// still passes off-host.
    ///
    /// Subscribes to the L1 ring **before** calling `Next` so we observe
    /// only the events emitted by this duplication thread. Other parallel
    /// tests pushing to the same global ring are filtered out via the
    /// `EventKind::DirtyRect` kind check; we never assert on absolute
    /// counts of unrelated event kinds.
    #[test]
    #[cfg(target_os = "windows")]
    fn dxgi_emit_fork_enable_disable_roundtrip() {
        // 1) Try to spawn — skip the test entirely if DXGI is unavailable.
        let handle = match spawn(0) {
            Ok(h) => h,
            Err(_) => {
                eprintln!(
                    "skipping dxgi_emit_fork_enable_disable_roundtrip: \
                     no DXGI output available (likely RDP / headless / no GPU)"
                );
                return;
            }
        };

        // 2) Subscribe to the global ring so we see events without
        //    competing with any other consumer that polls.
        let ring = ensure_l1().ring.clone();
        let sub = ring.subscribe(4096);

        // 3) Drain any pre-existing snapshots (other tests, P5c-1
        //    focus events from session start, etc.).
        while sub.try_recv().is_ok() {}

        // ── Emit ON (default) ────────────────────────────────────────
        // Issue a Next cmd, capture its rect-count reply, and count the
        // DirtyRect events that landed in our subscription within a
        // short drain window. The two should match.
        let (reply_tx, reply_rx) = bounded(1);
        handle
            .tx
            .send(DuplicationCmd::Next {
                timeout_ms: 100,
                reply: reply_tx,
            })
            .expect("send Next while DXGI thread is alive");
        let returned = reply_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("DXGI thread reply within 2s");
        let returned_count = match returned {
            Ok(rects) => rects.len(),
            Err(_) => {
                // AcquireNextFrame on an idle desktop legitimately
                // returns errors (TIMEOUT, ACCESS_LOST). Don't fail
                // the test on these; just skip.
                eprintln!("skipping enable-half: DXGI Next returned Err");
                return;
            }
        };

        // Drain the subscription for ~250ms — enough for the emit fork
        // to have completed for this Next call.
        let drain_until = Instant::now() + Duration::from_millis(250);
        let mut emit_count_enabled = 0;
        while Instant::now() < drain_until {
            match sub.recv_timeout(Duration::from_millis(20)) {
                Ok(env) if env.kind == EventKind::DirtyRect as u16 => emit_count_enabled += 1,
                Ok(_) => {} // unrelated event from another emitter
                Err(_) => break,
            }
        }
        assert_eq!(
            emit_count_enabled, returned_count,
            "with emit enabled, every returned rect should produce one DirtyRect envelope"
        );

        // ── Emit OFF ─────────────────────────────────────────────────
        handle.set_l1_emit_enabled(false);
        let (reply_tx2, reply_rx2) = bounded(1);
        handle
            .tx
            .send(DuplicationCmd::Next {
                timeout_ms: 100,
                reply: reply_tx2,
            })
            .expect("send second Next while DXGI thread is alive");
        let _ = reply_rx2
            .recv_timeout(Duration::from_secs(2))
            .expect("DXGI thread reply within 2s");

        // Drain again — there must be zero DirtyRect events even if the
        // frame produced rects.
        let drain_until2 = Instant::now() + Duration::from_millis(250);
        let mut emit_count_disabled = 0;
        while Instant::now() < drain_until2 {
            match sub.recv_timeout(Duration::from_millis(20)) {
                Ok(env) if env.kind == EventKind::DirtyRect as u16 => emit_count_disabled += 1,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        assert_eq!(
            emit_count_disabled, 0,
            "with emit disabled, no DirtyRect envelopes should land on the ring"
        );

        // Stop the duplication thread cleanly so the test process tears
        // down without a lingering background loop.
        let _ = handle.tx.send(DuplicationCmd::Stop);
    }
}
