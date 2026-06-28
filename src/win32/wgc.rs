//! ADR-027 — Windows.Graphics.Capture (WGC) capture layer.
//!
//! Captures the *real* pixels of a window from the DWM composition surface,
//! filling the structural gap left by PrintWindow (returns black for GPU-
//! composited windows: Chrome / Electron / WinUI3) and BitBlt (can only read
//! on-screen, non-occluded windows). WGC reads what the compositor actually
//! shows, so it works for occluded and GPU-composited windows.
//!
//! ## Threading (ADR-027 D2 / §6.2)
//! A single dedicated worker thread (the `desktop-wgc` thread, same shape as
//! the Desktop Duplication worker in `src/duplication/thread.rs`) owns the
//! D3D11 device + immediate context + WinRT `IDirect3DDevice` and reuses them
//! across captures (R2/AC2). It is required — not merely convenient — because
//! windows-rs 0.62 raw COM interface wrappers (`ID3D11Device`, …) are **not**
//! `Send`/`Sync`, so they cannot be shared through a `Mutex`/`OnceLock`. The
//! napi `AsyncTask` (a libuv worker) marshals a capture *request*
//! (`hwnd` as `usize` + opts) over a crossbeam channel and blocks on the reply
//! (`Result<WgcFrame, String>` — `Vec<u8>` is `Send`, no COM crosses threads).
//!
//! Frame pool is `CreateFreeThreaded` (no message pump / `DispatcherQueue`
//! needed — proven by the Phase 0 spike, OQ5), drained by polling
//! `TryGetNextFrame`.
//!
//! ## Pixel contract (ADR-027 D4)
//! Output is RGBA, top-down, opaque alpha, cropped to the frame's `ContentSize`
//! (NOT the frame-pool surface size, which may be padded). The returned buffer
//! always satisfies `data.len() == width * height * 4`.

#![cfg(windows)]

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Sender};
use napi::bindgen_prelude::{AsyncTask, BigInt, Buffer};
use napi::{Env, Task};
use napi_derive::napi;

use windows::core::Interface;
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::types::{NativeWgcCaptureOptions, NativeWgcResult};

// ─── Public value types ──────────────────────────────────────────────────────

/// Failure modes for a WGC capture attempt. Every variant means "WGC could not
/// produce a trustworthy frame; the TS ladder should fall to the next rung
/// (PrintWindow / BitBlt)".
#[derive(Debug)]
pub enum WgcError {
    /// `GraphicsCaptureSession::IsSupported()` is false (WGC needs Win10 1903+).
    Unsupported,
    /// `CreateForWindow` failed — window is gone or not capturable.
    InvalidWindow,
    /// No frame arrived within the timeout (idle / never-composited window).
    NoFrame,
    /// A windows-rs / COM call failed (device-level; the worker drops its
    /// cached device so the next call rebuilds it).
    Win(windows::core::Error),
    /// Any other invariant violation (e.g. zero-sized content).
    Other(String),
}

impl std::fmt::Display for WgcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WgcError::Unsupported => write!(f, "WGC unsupported on this OS"),
            WgcError::InvalidWindow => write!(f, "WGC CreateForWindow failed"),
            WgcError::NoFrame => write!(f, "WGC produced no frame within timeout"),
            WgcError::Win(e) => write!(f, "WGC win32 error: {e}"),
            WgcError::Other(s) => write!(f, "WGC error: {s}"),
        }
    }
}

impl From<windows::core::Error> for WgcError {
    fn from(e: windows::core::Error) -> Self {
        WgcError::Win(e)
    }
}

/// A captured frame: RGBA, top-down, `data.len() == width * height * 4`.
pub struct WgcFrame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Per-capture knobs (Copy — cheap to thread through the channel and reuse).
#[derive(Clone, Copy)]
pub struct WgcCaptureOptions {
    /// Include the mouse cursor in the capture (default false).
    pub include_cursor: bool,
    /// Suppress the yellow capture border (Win11 ≥ 20348 only; best-effort —
    /// silently ignored on older builds, ADR-027 D5).
    pub remove_border: bool,
    /// Total time to wait for a fresh frame before giving up.
    pub timeout_ms: u32,
}

impl Default for WgcCaptureOptions {
    fn default() -> Self {
        WgcCaptureOptions {
            include_cursor: false,
            remove_border: true,
            timeout_ms: 1500,
        }
    }
}

impl From<Option<NativeWgcCaptureOptions>> for WgcCaptureOptions {
    fn from(opts: Option<NativeWgcCaptureOptions>) -> Self {
        let d = WgcCaptureOptions::default();
        match opts {
            None => d,
            Some(o) => WgcCaptureOptions {
                include_cursor: o.include_cursor.unwrap_or(d.include_cursor),
                remove_border: o.remove_border.unwrap_or(d.remove_border),
                timeout_ms: o.timeout_ms.unwrap_or(d.timeout_ms),
            },
        }
    }
}

/// Whether WGC is available on this OS at all (Win10 1903+). Must be called on
/// a COM-initialised thread (the worker is MTA-initialised).
fn is_supported() -> bool {
    GraphicsCaptureSession::IsSupported().unwrap_or(false)
}

// ─── Reusable device bundle (lives on the worker thread only) ─────────────────

/// D3D11 device + immediate context + WinRT device, created once and reused
/// across captures. Never crosses a thread boundary (raw COM is not `Send`).
struct WgcDevice {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    rt_device: IDirect3DDevice,
}

fn build_device() -> Result<WgcDevice, WgcError> {
    unsafe {
        // BGRA support is mandatory for the WinRT D3D interop. Default hardware
        // adapter (null adapter → DriverType HARDWARE), matching the WGC sample.
        let mut device_opt: Option<ID3D11Device> = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device_opt),
            None,
            None,
        )?;
        let device = device_opt.ok_or_else(|| WgcError::Other("D3D11 device null".into()))?;
        let context: ID3D11DeviceContext = device.GetImmediateContext()?;
        let dxgi_device: IDXGIDevice = device.cast()?;
        let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)?;
        let rt_device: IDirect3DDevice = inspectable.cast()?;
        Ok(WgcDevice {
            device,
            context,
            rt_device,
        })
    }
}

/// Capture `hwnd` using an already-built device. Runs entirely on the worker
/// thread. Per-call frame pool + session (cheap); device/context are reused.
fn capture_with_device(
    dev: &WgcDevice,
    hwnd: HWND,
    opts: WgcCaptureOptions,
) -> Result<WgcFrame, WgcError> {
    unsafe {
        // 1. GraphicsCaptureItem for this window (per-window — never locks the
        //    whole output, so it doesn't collide with DXGI duplication, §4).
        let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        let item: GraphicsCaptureItem = interop
            .CreateForWindow(hwnd)
            .map_err(|_| WgcError::InvalidWindow)?;
        let item_size = item.Size()?;
        if item_size.Width <= 0 || item_size.Height <= 0 {
            return Err(WgcError::Other(format!(
                "WGC item size invalid: {}x{}",
                item_size.Width, item_size.Height
            )));
        }

        // 2. Free-threaded frame pool (no message pump needed) + session.
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &dev.rt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            item_size,
        )?;
        let session = pool.CreateCaptureSession(&item)?;

        // Feature-detect knobs (ADR-027 D5): both exist in the API surface but
        // may throw on older builds — ignore failures and degrade.
        if !opts.include_cursor {
            let _ = session.SetIsCursorCaptureEnabled(false);
        }
        if opts.remove_border {
            let _ = session.SetIsBorderRequired(false);
        }

        session.StartCapture()?;

        // 3. Drain. The first frame after StartCapture can be stale; poll until
        //    a frame appears, then wait briefly and take the freshest buffered
        //    frame. `TryGetNextFrame` returns Err when the pool is momentarily
        //    empty (null → E_POINTER), which we treat as "not ready yet".
        let deadline = Instant::now() + Duration::from_millis(opts.timeout_ms as u64);
        let mut latest: Option<Direct3D11CaptureFrame> = None;
        loop {
            while let Ok(f) = pool.TryGetNextFrame() {
                latest = Some(f);
            }
            if latest.is_some() {
                std::thread::sleep(Duration::from_millis(20));
                while let Ok(f) = pool.TryGetNextFrame() {
                    latest = Some(f);
                }
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let frame = match latest {
            Some(f) => f,
            None => {
                let _ = session.Close();
                let _ = pool.Close();
                return Err(WgcError::NoFrame);
            }
        };

        // 4. Content size (real captured pixels) — NOT item.Size(), which can
        //    be padded (ADR-027 D4).
        let content = frame.ContentSize()?;

        // 5. Frame surface → ID3D11Texture2D via the DXGI interface-access shim.
        let surface = frame.Surface()?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
        let texture: ID3D11Texture2D = access.GetInterface()?;

        // 6. Staging copy so the CPU can read it.
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        let surface_w = desc.Width;
        let surface_h = desc.Height;
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        let mut staging_opt: Option<ID3D11Texture2D> = None;
        dev.device
            .CreateTexture2D(&desc, None, Some(&mut staging_opt))?;
        let staging = staging_opt.ok_or_else(|| WgcError::Other("staging texture null".into()))?;

        dev.context.CopyResource(&staging, &texture);

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        dev.context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;

        // 7. Crop to content size, BGRA → RGBA, opaque alpha (top-down).
        let content_w = (content.Width.max(0) as u32).min(surface_w);
        let content_h = (content.Height.max(0) as u32).min(surface_h);
        if content_w == 0 || content_h == 0 {
            dev.context.Unmap(&staging, 0);
            let _ = frame.Close();
            let _ = session.Close();
            let _ = pool.Close();
            return Err(WgcError::Other("WGC content size zero".into()));
        }
        let row_pitch = mapped.RowPitch as usize;
        let src = mapped.pData as *const u8;
        let mut out = vec![0u8; content_w as usize * content_h as usize * 4];
        for y in 0..content_h as usize {
            let src_row = src.add(y * row_pitch);
            let dst_off = y * content_w as usize * 4;
            for x in 0..content_w as usize {
                let s = src_row.add(x * 4);
                let b = *s;
                let g = *s.add(1);
                let r = *s.add(2);
                let o = dst_off + x * 4;
                out[o] = r;
                out[o + 1] = g;
                out[o + 2] = b;
                out[o + 3] = 255;
            }
        }
        dev.context.Unmap(&staging, 0);

        // 8. Tear down the per-call WGC objects (device/context are reused).
        let _ = frame.Close();
        let _ = session.Close();
        let _ = pool.Close();

        debug_assert_eq!(out.len(), content_w as usize * content_h as usize * 4);
        Ok(WgcFrame {
            data: out,
            width: content_w,
            height: content_h,
        })
    }
}

// ─── Dedicated worker thread ──────────────────────────────────────────────────

enum WgcCmd {
    Capture {
        hwnd_raw: usize,
        opts: WgcCaptureOptions,
        reply: Sender<Result<WgcFrame, String>>,
    },
}

struct WgcWorker {
    tx: Sender<WgcCmd>,
}

static WGC_WORKER: OnceLock<WgcWorker> = OnceLock::new();

/// Lazily spawn (once) and return the process-wide WGC worker. The thread is
/// idle (blocked on `recv`) when no capture is in flight, like the duplication
/// thread.
fn worker() -> &'static WgcWorker {
    WGC_WORKER.get_or_init(|| {
        let (tx, rx) = bounded::<WgcCmd>(32);
        let spawned = std::thread::Builder::new()
            .name("desktop-wgc".into())
            .spawn(move || {
                // WGC / WinRT activation needs a COM-initialised thread. MTA
                // matches the free-threaded frame pool (no message pump).
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }
                let mut dev: Option<WgcDevice> = None;
                while let Ok(cmd) = rx.recv() {
                    match cmd {
                        WgcCmd::Capture {
                            hwnd_raw,
                            opts,
                            reply,
                        } => {
                            // Defensive: a panic in capture (a bug) must not
                            // permanently wedge the worker. catch_unwind keeps
                            // the thread alive; the cached device is dropped
                            // since its state is unknown after an unwind. Same
                            // boundary philosophy as napi_safe_call for sync
                            // exports.
                            let result = match std::panic::catch_unwind(
                                std::panic::AssertUnwindSafe(|| {
                                    run_capture(&mut dev, hwnd_raw, opts)
                                }),
                            ) {
                                Ok(r) => r,
                                Err(_) => {
                                    dev = None;
                                    Err("WGC capture panicked".to_string())
                                }
                            };
                            let _ = reply.send(result);
                        }
                    }
                }
            });
        if let Err(e) = spawned {
            // Spawn failure is extraordinary; surface it on the first capture
            // via a closed channel (recv error → "worker unavailable").
            eprintln!("[wgc] worker thread spawn failed: {e}");
        }
        WgcWorker { tx }
    })
}

/// Worker-thread capture body: ensure a device (rebuild if a prior device-level
/// error invalidated it), capture, and stringify the error for the channel.
fn run_capture(
    dev: &mut Option<WgcDevice>,
    hwnd_raw: usize,
    opts: WgcCaptureOptions,
) -> Result<WgcFrame, String> {
    if !is_supported() {
        return Err(WgcError::Unsupported.to_string());
    }
    if dev.is_none() {
        match build_device() {
            Ok(d) => *dev = Some(d),
            Err(e) => return Err(e.to_string()),
        }
    }
    let d = dev.as_ref().expect("device just ensured");
    let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
    match capture_with_device(d, hwnd, opts) {
        Ok(f) => Ok(f),
        Err(e) => {
            // A device-level COM error (e.g. device removed / reset) means the
            // cached device may be dead — drop it so the next call rebuilds.
            // InvalidWindow / NoFrame / Other keep the (healthy) device.
            if matches!(e, WgcError::Win(_)) {
                *dev = None;
            }
            Err(e.to_string())
        }
    }
}

/// Send a capture request to the worker and block for the reply. Called from a
/// libuv worker thread (inside `AsyncTask::compute`), so blocking is fine.
pub fn capture_via_worker(hwnd_raw: usize, opts: WgcCaptureOptions) -> Result<WgcFrame, String> {
    let (reply_tx, reply_rx) = bounded::<Result<WgcFrame, String>>(1);
    worker()
        .tx
        .send(WgcCmd::Capture {
            hwnd_raw,
            opts,
            reply: reply_tx,
        })
        .map_err(|_| "WGC worker unavailable".to_string())?;
    // Bound the wait so a wedged capture can't pin the libuv worker forever.
    // The worker serialises captures, so allow for one in-flight capture ahead
    // of us plus our own (2× drain budget) + a fixed slack.
    let wait = Duration::from_millis(opts.timeout_ms as u64 * 2 + 3000);
    match reply_rx.recv_timeout(wait) {
        Ok(r) => r,
        Err(_) => Err("WGC worker timed out".to_string()),
    }
}

// ─── napi surface ─────────────────────────────────────────────────────────────

pub struct Win32WgcCaptureTask {
    hwnd_raw: usize,
    opts: WgcCaptureOptions,
}

impl Task for Win32WgcCaptureTask {
    type Output = NativeWgcResult;
    type JsValue = NativeWgcResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let frame = capture_via_worker(self.hwnd_raw, self.opts)
            .map_err(napi::Error::from_reason)?;
        Ok(NativeWgcResult {
            data: Buffer::from(frame.data),
            width: frame.width,
            height: frame.height,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Capture a window via Windows.Graphics.Capture. Returns a Promise; the
/// capture runs on the dedicated `desktop-wgc` worker thread (device reused),
/// dispatched from a libuv worker so the V8 main thread is never blocked.
///
/// Rejects (napi error, reason string) when WGC can't produce a trustworthy
/// frame — the TS capture ladder interprets the reason and falls back to
/// PrintWindow / BitBlt.
#[napi]
pub fn win32_wgc_capture_window(
    hwnd: BigInt,
    opts: Option<NativeWgcCaptureOptions>,
) -> AsyncTask<Win32WgcCaptureTask> {
    let (_sign, val, _lossless) = hwnd.get_u64();
    AsyncTask::new(Win32WgcCaptureTask {
        hwnd_raw: val as usize,
        opts: opts.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The capture path itself needs a live GPU desktop (non-hermetic — CI is
    // 2-core headless), so it is validated by the Phase 0 spike + the napi
    // dogfood, not here. CI compiles this module (check:rs-test-compile). These
    // tests pin the pure option-mapping contract that the napi entry depends on.

    #[test]
    fn options_default_when_none() {
        let o: WgcCaptureOptions = None.into();
        assert!(!o.include_cursor);
        assert!(o.remove_border);
        assert_eq!(o.timeout_ms, 1500);
    }

    #[test]
    fn options_partial_override_keeps_other_defaults() {
        let o: WgcCaptureOptions = Some(NativeWgcCaptureOptions {
            include_cursor: Some(true),
            remove_border: None,
            timeout_ms: None,
        })
        .into();
        assert!(o.include_cursor); // overridden
        assert!(o.remove_border); // default kept
        assert_eq!(o.timeout_ms, 1500); // default kept
    }

    #[test]
    fn options_full_override() {
        let o: WgcCaptureOptions = Some(NativeWgcCaptureOptions {
            include_cursor: Some(false),
            remove_border: Some(false),
            timeout_ms: Some(500),
        })
        .into();
        assert!(!o.include_cursor);
        assert!(!o.remove_border);
        assert_eq!(o.timeout_ms, 500);
    }
}
