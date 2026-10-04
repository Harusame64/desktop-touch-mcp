//! Window capture for the Mac port (M1), through ScreenCaptureKit.
//!
//! Spike round 2 (Swift): SCK captured a shown or covered window as it is
//! now (128 ms) and failed with -3811 (`SCStreamErrorInternalError`) for a
//! minimised window and for one on another Space. M1 (this code,
//! 2026-10-04) captured a minimised TextEdit window *with* text written
//! into it while minimised, so the minimised case is not settled; one app,
//! one window. Whatever SCK refuses comes back `ok: false` with SCK's error
//! code and text, never an older image, and `on_screen` says whether the
//! window was on screen.
//! SCK draws the cursor unless told not to, and needs CoreGraphics
//! initialised in the process first (`NSApplication.shared`), which only the
//! main thread may do — [`ensure_app_initialised`] runs on the JS thread.
//! Called from a Node worker thread it cannot, and says so (`app_init`).

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{AnyThread, MainThreadMarker};
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{CGColorSpace, CGContext, CGImage};
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow,
};

use super::ax::MacRect;

static APP_INITIALISED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Call on the main (JS) thread before the first capture. Idempotent.
pub(crate) fn ensure_app_initialised() {
    if let Some(mtm) = MainThreadMarker::new() {
        let _ = objc2_app_kit::NSApplication::sharedApplication(mtm);
        APP_INITIALISED.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[napi_derive::napi(object)]
#[derive(Clone, Debug, Default)]
pub struct MacCaptureOptions {
    pub window_id: u32,
    /// Pixels per point (default: the window's display scale as SCK reports it).
    pub scale: Option<f64>,
    /// For the whole capture, lookup included (default 5000).
    pub timeout_ms: Option<u32>,
}

#[napi_derive::napi(object)]
pub struct MacCaptureResult {
    pub ok: bool,
    /// `window_not_found`, `timeout`, `app_init` (no main-thread init yet),
    /// or `sck_error <code>: <text>`.
    pub reason: Option<String>,
    /// RGBA, top-down, opaque; `data.len() == width * height * 4`.
    pub data: Option<napi::bindgen_prelude::Buffer>,
    pub width: u32,
    pub height: u32,
    /// The window's frame in points (top-left origin) when SCK listed it.
    pub frame: Option<MacRect>,
    pub on_screen: Option<bool>,
    pub elapsed_ms: f64,
}

fn failed(reason: impl Into<String>, t0: std::time::Instant) -> MacCaptureResult {
    MacCaptureResult {
        ok: false,
        reason: Some(reason.into()),
        data: None,
        width: 0,
        height: 0,
        frame: None,
        on_screen: None,
        elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0,
    }
}

fn guarded<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|_| Err("panic".to_string()))
}

fn sck_error(e: &NSError) -> String {
    format!("sck_error {}: {}", e.code(), e.localizedDescription())
}

fn find_window(window_id: u32, timeout: Duration) -> Result<Retained<SCWindow>, String> {
    let (tx, rx) = mpsc::channel::<Result<Retained<SCWindow>, String>>();
    let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        // Runs on SCK's queue, outside napi_safe_call: a panic here would
        // cross the block's C boundary and abort.
        let r = guarded(|| if let Some(content) = unsafe { content.as_ref() } {
            let windows = unsafe { content.windows() };
            windows
                .iter()
                .find(|w| unsafe { w.windowID() } == window_id)
                .ok_or_else(|| "window_not_found".to_string())
        } else if let Some(e) = unsafe { error.as_ref() } {
            Err(sck_error(e))
        } else {
            Err("no_shareable_content".to_string())
        });
        let _ = tx.send(r);
    });
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true, false, &block,
        )
    };
    rx.recv_timeout(timeout).map_err(|_| "timeout".to_string())?
}

unsafe extern "C" {
    fn CGBitmapContextCreate(
        data: *mut c_void,
        width: usize,
        height: usize,
        bits_per_component: usize,
        bytes_per_row: usize,
        space: *const CGColorSpace,
        bitmap_info: u32,
    ) -> *mut CGContext;
}

/// kCGImageAlphaNoneSkipLast | kCGBitmapByteOrder32Big: R,G,B,x in memory.
const RGBX_BIG: u32 = 5 | (4 << 12);

fn to_rgba(image: &CGImage) -> Option<(Vec<u8>, u32, u32)> {
    let w = CGImage::width(Some(image));
    let h = CGImage::height(Some(image));
    if w == 0 || h == 0 {
        return None;
    }
    let mut buf = vec![0u8; w * h * 4];
    let space = CGColorSpace::new_device_rgb()?;
    let ctx = unsafe {
        CGBitmapContextCreate(buf.as_mut_ptr().cast(), w, h, 8, w * 4, &*space, RGBX_BIG)
    };
    let ctx: CFRetained<CGContext> = unsafe { CFRetained::from_raw(NonNull::new(ctx)?) };
    let rect = CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: w as f64, height: h as f64 } };
    CGContext::draw_image(Some(&ctx), rect, Some(image));
    drop(ctx);
    for px in buf.chunks_exact_mut(4) {
        px[3] = 255;
    }
    Some((buf, w as u32, h as u32))
}

pub(crate) fn capture_window(opts: &MacCaptureOptions) -> MacCaptureResult {
    let t0 = std::time::Instant::now();
    if !APP_INITIALISED.load(std::sync::atomic::Ordering::Relaxed) {
        return failed("app_init", t0);
    }
    let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(5000) as u64);
    let window = match find_window(opts.window_id, timeout) {
        Ok(w) => w,
        Err(e) => return failed(e, t0),
    };
    let wf = unsafe { window.frame() };
    let frame = MacRect { x: wf.origin.x, y: wf.origin.y, width: wf.size.width, height: wf.size.height };
    let on_screen = unsafe { window.isOnScreen() };

    let filter = unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window) };
    let scale = opts
        .scale
        .unwrap_or_else(|| unsafe { SCShareableContent::infoForFilter(&filter).pointPixelScale() } as f64)
        .clamp(0.25, 4.0);
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth((frame.width * scale).round().max(1.0) as usize);
        config.setHeight((frame.height * scale).round().max(1.0) as usize);
        config.setShowsCursor(false);
        config.setIgnoreShadowsSingleWindow(true);
    }

    let (tx, rx) = mpsc::channel::<Result<(Vec<u8>, u32, u32), String>>();
    let block = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        let r = guarded(|| if let Some(image) = unsafe { image.as_ref() } {
            to_rgba(image).ok_or_else(|| "empty_image".to_string())
        } else if let Some(e) = unsafe { error.as_ref() } {
            Err(sck_error(e))
        } else {
            Err("no_image".to_string())
        });
        let _ = tx.send(r);
    });
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &config, Some(&block))
    };
    // One budget for the whole capture: what the lookup used is gone.
    match rx.recv_timeout(timeout.saturating_sub(t0.elapsed())) {
        Ok(Ok((pixels, width, height))) => MacCaptureResult {
            ok: true,
            reason: None,
            data: Some(pixels.into()),
            width,
            height,
            frame: Some(frame),
            on_screen: Some(on_screen),
            elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0,
        },
        Ok(Err(e)) => MacCaptureResult { frame: Some(frame), on_screen: Some(on_screen), ..failed(e, t0) },
        Err(_) => MacCaptureResult { frame: Some(frame), on_screen: Some(on_screen), ..failed("timeout", t0) },
    }
}
