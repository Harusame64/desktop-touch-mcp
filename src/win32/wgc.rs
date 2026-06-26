//! WGC (Windows.Graphics.Capture) window capture via napi-rs.
//!
//! Uses `IGraphicsCaptureItemInterop::CreateForWindow` to create a capture item
//! from a raw HWND, bypassing the interactive `GraphicsCapturePicker`.
//!
//! Data source: DWM composition surface (D3D11 texture) → IDXGISurface → RGBA.
//! Unlike PrintWindow, this works for ANY window including taskmgr (which
//! ignores `WM_PRINT`).
//!
//! When WGC is unavailable (no D3D11, RDP/headless, pre-1809), the caller
//! falls through to PrintWindow → BitBlt.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use super::safety::napi_safe_call;
use windows::Win32::Foundation::HWND;

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

/// Capture result returned to TypeScript, structurally identical to
/// `printWindowToBuffer`'s return so callers can treat them interchangeably.
#[napi(object)]
#[derive(Clone)]
pub struct WgcCaptureResult {
    /// RGBA pixel buffer, width × height × 4 bytes.
    pub data: Buffer,
    /// Image width in pixels.
    pub width: i32,
    /// Image height in pixels.
    pub height: i32,
}

/// Capture a window using Windows.Graphics.Capture (DWM composition surface).
///
/// Returns `Err` when WGC is unsupported (no D3D11 device, RDP, pre-1809, or
/// the HWND is invalid). The caller should fall through to PrintWindow.
#[napi]
pub fn capture_window_wgc(hwnd: BigInt) -> Result<WgcCaptureResult> {
    use wgc::WgcSettings;

    napi_safe_call("capture_window_wgc", || {
        // WGC WinRT API requires COM on the calling thread. napi-rs worker threads
        // may not have it — initialise STA (preferred for WinRT). If already in
        // MTA (e.g. from UIA), CoInitializeEx returns RPC_E_CHANGED_MODE which is
        // harmless — WGC works in MTA on modern Windows.
        let _com = init_com();

        let hwnd = hwnd_from_bigint(hwnd);

        // Step 1: Create GraphicsCaptureItem from HWND (bypasses picker)
        let item = wgc::new_item_from_hwnd(hwnd).map_err(|e| {
            napi::Error::from_reason(format!("WGC: CreateForWindow failed: {e}"))
        })?;
        let size = item.Size().map_err(|e| {
            napi::Error::from_reason(format!("WGC: Size() failed: {e}"))
        })?;
        let frame_width = size.Width.max(0) as u32;
        let frame_height = size.Height.max(0) as u32;

        if frame_width == 0 || frame_height == 0 {
            return Err(napi::Error::from_reason(
                "WGC: zero-size capture item (window may be minimized or cloaked)",
            ));
        }

        // Step 2: WGC settings — border OFF, cursor OFF
        let settings = WgcSettings {
            frame_queue_length: 2,
            display_border: Some(false),
            capture_cursor: Some(false),
            ..Default::default()
        };

        // Step 3: Create capture session & grab one frame
        let capture = wgc::Wgc::new(item, settings).map_err(|e| {
            napi::Error::from_reason(format!("WGC: session creation failed: {e}"))
        })?;

        let frame = capture
            .take(1)
            .next()
            .ok_or_else(|| napi::Error::from_reason("WGC: no frame captured (empty iterator)"))?
            .map_err(|e| napi::Error::from_reason(format!("WGC: frame error: {e}")))?;

        let pixels = frame.read_pixels(None).map_err(|e| {
            napi::Error::from_reason(format!("WGC: read_pixels failed: {e}"))
        })?;

        Ok(WgcCaptureResult {
            data: pixels.into(),
            width: frame_width as i32,
            height: frame_height as i32,
        })
    })
}

/// Initialise COM on the calling thread (STA preferred for WinRT interop).
/// Silently handles RPC_E_CHANGED_MODE (already in MTA from UIA).
/// Returns a RAII guard that calls CoUninitialize on drop.
fn init_com() -> ComGuard {
    let r = unsafe {
        windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
        )
    };
    ComGuard(r.is_ok())
}

/// RAII guard for CoUninitialize.
struct ComGuard(bool);

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                windows::Win32::System::Com::CoUninitialize();
            }
        }
    }
}
