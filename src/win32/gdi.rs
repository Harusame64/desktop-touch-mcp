//! GDI capture (ADR-007 P2) — `print_window_to_buffer`.
//! GDI capture (ADR-031) — `capture_screen_region`.
//!
//! Replaces the koffi-driven sequence in `printWindowToBuffer`:
//!   GetWindowRect → GetDC(NULL) → CreateCompatibleDC → CreateCompatibleBitmap
//!   → SelectObject → PrintWindow → GetDIBits → reshape BGRA→RGBA → cleanup.
//!
//! `win32_capture_screen_region` runs the same sequence with `BitBlt` in place
//! of `PrintWindow`, reading straight from the screen DC — which covers the
//! whole virtual desktop, so a monitor placed left of or above the primary one
//! is addressed by a negative origin rather than being out of range.
//!
//! Every Win32 handle is owned by a small RAII guard. The let-binding order
//! in `print_window_to_buffer` therefore matters: `screen_dc` lives longest,
//! then `mem_dc`, then `bitmap`, then `select_guard`. drop order is LIFO, so
//! the SelectObject undo runs first, then DeleteObject(bitmap), then
//! DeleteDC(mem_dc), then ReleaseDC(NULL, screen_dc) — matching the Win32
//! lifecycle invariant ("unselect before destroy").
//!
//! drop order is LIFO; select must unwind before bitmap is destroyed,
//! bitmap before its memory DC, memory DC before its source screen DC.

use napi::bindgen_prelude::{BigInt, Buffer};
use napi_derive::napi;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
    HGDIOBJ, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

use super::safety::napi_safe_call;
use super::types::{NativeCaptureRegionResult, NativePrintWindowResult};

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

// ── RAII guards ──────────────────────────────────────────────────────────────

/// Releases either a window-DC (`ReleaseDC(target, dc)`) or a memory-DC
/// (`DeleteDC(dc)`) on Drop, depending on `is_mem`.
struct DcGuard {
    target: Option<HWND>,
    dc: HDC,
    is_mem: bool,
}
impl Drop for DcGuard {
    fn drop(&mut self) {
        unsafe {
            if self.is_mem {
                let _ = DeleteDC(self.dc);
            } else {
                ReleaseDC(self.target, self.dc);
            }
        }
    }
}

struct BitmapGuard(HBITMAP);
impl Drop for BitmapGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(self.0 .0));
        }
    }
}

/// Restores the previously-selected GDI object on Drop. `old = None` when
/// the original `SelectObject` returned NULL (= failure) — in that case we
/// have nothing to restore, so Drop is a no-op (Opus review §11.2).
struct SelectGuard {
    dc: HDC,
    old: Option<HGDIOBJ>,
}
impl Drop for SelectGuard {
    fn drop(&mut self) {
        if let Some(old) = self.old.take() {
            unsafe {
                let _ = SelectObject(self.dc, old);
            }
        }
    }
}

// ── Public entry point ──────────────────────────────────────────────────────

/// Capture `hwnd` via PrintWindow into an RGBA top-down buffer.
///
/// `flags` matches the Win32 `PRINT_WINDOW_FLAGS` values (0 = default,
/// 2 = `PW_RENDERFULLCONTENT`, 3 = client-only + RENDERFULLCONTENT).
/// Returns `Err` for unrecoverable failures (window gone, all DCs failed);
/// returns the buffer even when `PrintWindow` itself returns FALSE because
/// some windows partially render in that case (legacy TS behavior).
#[napi]
pub fn win32_print_window_to_buffer(
    hwnd: BigInt,
    flags: u32,
) -> napi::Result<NativePrintWindowResult> {
    napi_safe_call("win32_print_window_to_buffer", || {
        let target = hwnd_from_bigint(hwnd);

        // 1. Resolve client size.
        let mut rect = RECT::default();
        unsafe { GetWindowRect(target, &mut rect) }
            .map_err(|e| napi::Error::from_reason(format!("GetWindowRect failed: {e}")))?;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return Err(napi::Error::from_reason(format!(
                "Invalid window dimensions: {width}x{height}"
            )));
        }

        // 2. Acquire the screen DC. `screen_dc` is dropped LAST among the
        //    guards declared below (LIFO drop order), satisfying the Win32
        //    invariant that mem_dc / bitmap / select must all be cleaned up
        //    before ReleaseDC on the source DC.
        let screen_dc_raw = unsafe { GetDC(None) };
        if screen_dc_raw.0.is_null() {
            return Err(napi::Error::from_reason("GetDC failed"));
        }
        let screen_dc = DcGuard {
            target: None,
            dc: screen_dc_raw,
            is_mem: false,
        };

        // 3. Memory DC compatible with the screen.
        let mem_dc_raw = unsafe { CreateCompatibleDC(Some(screen_dc.dc)) };
        if mem_dc_raw.0.is_null() {
            return Err(napi::Error::from_reason("CreateCompatibleDC failed"));
        }
        let mem_dc = DcGuard {
            target: None,
            dc: mem_dc_raw,
            is_mem: true,
        };

        // 4. Bitmap big enough for the window contents.
        let bitmap_raw = unsafe { CreateCompatibleBitmap(screen_dc.dc, width, height) };
        if bitmap_raw.0.is_null() {
            return Err(napi::Error::from_reason("CreateCompatibleBitmap failed"));
        }
        let _bitmap = BitmapGuard(bitmap_raw);

        // 5. Bind bitmap to the memory DC; the previous selection is
        //    restored on drop (skipped when SelectObject returned NULL).
        let prev = unsafe { SelectObject(mem_dc.dc, HGDIOBJ(bitmap_raw.0 as *mut _)) };
        let _select_guard = SelectGuard {
            dc: mem_dc.dc,
            old: if prev.0.is_null() { None } else { Some(prev) },
        };

        // 6. PrintWindow. We tolerate FALSE because some windows still
        //    render partially — the legacy TS behavior was to fall through
        //    to GetDIBits and let the caller use whatever was produced.
        let _ = unsafe { PrintWindow(target, mem_dc.dc, PRINT_WINDOW_FLAGS(flags)) };

        // 7. Pull the DIB into a CPU buffer (32bpp top-down BI_RGB).
        let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // negative = top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..unsafe { std::mem::zeroed() }
        };
        let pixel_count = (width as usize) * (height as usize);
        let mut pixels: Vec<u8> = vec![0u8; pixel_count * 4];
        let scanlines = unsafe {
            GetDIBits(
                mem_dc.dc,
                bitmap_raw,
                0,
                height as u32,
                Some(pixels.as_mut_ptr() as *mut std::ffi::c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            )
        };
        if scanlines == 0 {
            return Err(napi::Error::from_reason("GetDIBits returned 0 scanlines"));
        }

        // 8. BGRA → RGBA + opaque alpha. `chunks_exact_mut(4)` lets the
        //    autovectorizer collapse the swap into a couple of pshufb-style
        //    instructions on x86_64; explicit SIMD is deferred to P5a per
        //    Opus review §11.7 / scope creep list.
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }

        Ok(NativePrintWindowResult {
            data: Buffer::from(pixels),
            width: width as u32,
            height: height as u32,
        })
    })
}

// ── ADR-031: absolute-coordinate screen / region capture ────────────────────

/// Byte length of the RGBA buffer for a `width` × `height` capture, or an
/// error describing why those dimensions cannot be captured.
///
/// Split out from the napi entry point because it is the only part of the
/// capture that does not depend on the machine's monitor geometry, and CI is
/// single-monitor: the geometry-dependent behaviour (negative origins, a
/// region spanning two monitors) is covered by the multi-monitor E2E and the
/// dogfood checklist instead (ADR-031 §4.3).
fn capture_buffer_len(width: u32, height: u32) -> napi::Result<usize> {
    // An empty rect is a caller bug, not a capture: CreateCompatibleBitmap
    // would hand back a 1x1 monochrome stub and the caller would decode it as
    // a real frame.
    if width == 0 || height == 0 {
        return Err(napi::Error::from_reason(format!(
            "Invalid capture dimensions: {width}x{height}"
        )));
    }
    // BitBlt / CreateCompatibleBitmap take i32 extents; anything past that
    // would wrap to a negative width when cast.
    if width > i32::MAX as u32 || height > i32::MAX as u32 {
        return Err(napi::Error::from_reason(format!(
            "Capture dimensions exceed the Win32 limit: {width}x{height}"
        )));
    }
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| {
            napi::Error::from_reason(format!(
                "Capture buffer size overflows: {width}x{height}"
            ))
        })
}

/// Capture a rectangle of the virtual desktop into an RGBA top-down buffer.
///
/// `x` / `y` are **signed virtual-screen pixels** — the same coordinate space
/// `win32EnumMonitors` reports and dot-by-dot screenshots hand back — so a
/// monitor left of or above the primary one is addressed with negative values.
/// The screen DC returned by `GetDC(None)` spans the entire virtual desktop,
/// which is what makes that work.
///
/// The raster op is `SRCCOPY` only. `CAPTUREBLT` would pull layered windows
/// (tooltips, IME candidate popups) into the frame and make consecutive
/// captures differ for reasons the caller did not cause, which breaks the
/// frame-diff comparisons downstream (ADR-031 §4.2).
///
/// Guard order matches `win32_print_window_to_buffer` above and the lifecycle
/// invariant in this file's header: `screen_dc` lives longest, then `mem_dc`,
/// then `bitmap`, then `select_guard`.
#[napi]
pub fn win32_capture_screen_region(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> napi::Result<NativeCaptureRegionResult> {
    napi_safe_call("win32_capture_screen_region", || {
        let buffer_len = capture_buffer_len(width, height)?;
        let w = width as i32;
        let h = height as i32;

        // 1. Screen DC — covers the whole virtual desktop, negative origins
        //    included. Dropped LAST (LIFO) so everything selected into it is
        //    already gone by then.
        let screen_dc_raw = unsafe { GetDC(None) };
        if screen_dc_raw.0.is_null() {
            return Err(napi::Error::from_reason("GetDC failed"));
        }
        let screen_dc = DcGuard {
            target: None,
            dc: screen_dc_raw,
            is_mem: false,
        };

        // 2. Memory DC compatible with the screen.
        let mem_dc_raw = unsafe { CreateCompatibleDC(Some(screen_dc.dc)) };
        if mem_dc_raw.0.is_null() {
            return Err(napi::Error::from_reason("CreateCompatibleDC failed"));
        }
        let mem_dc = DcGuard {
            target: None,
            dc: mem_dc_raw,
            is_mem: true,
        };

        // 3. Bitmap the size of the requested region. Compatible with the
        //    SCREEN dc, not the memory dc — a memory DC starts out holding a
        //    1x1 monochrome bitmap, so asking it for a compatible bitmap
        //    yields a monochrome one.
        let bitmap_raw = unsafe { CreateCompatibleBitmap(screen_dc.dc, w, h) };
        if bitmap_raw.0.is_null() {
            return Err(napi::Error::from_reason("CreateCompatibleBitmap failed"));
        }
        let _bitmap = BitmapGuard(bitmap_raw);

        // 4. Bind the bitmap; the previous selection is restored on drop.
        let prev = unsafe { SelectObject(mem_dc.dc, HGDIOBJ(bitmap_raw.0 as *mut _)) };
        let _select_guard = SelectGuard {
            dc: mem_dc.dc,
            old: if prev.0.is_null() { None } else { Some(prev) },
        };

        // 5. Copy the requested rectangle out of the screen DC. Unlike
        //    PrintWindow above, a FALSE here means no pixels were produced at
        //    all, so it is an error rather than something to fall through.
        unsafe { BitBlt(mem_dc.dc, 0, 0, w, h, Some(screen_dc.dc), x, y, SRCCOPY) }
            .map_err(|e| napi::Error::from_reason(format!("BitBlt failed: {e}")))?;

        // 6. Pull the DIB into a CPU buffer (32bpp top-down BI_RGB).
        let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // negative = top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..unsafe { std::mem::zeroed() }
        };
        let mut pixels: Vec<u8> = vec![0u8; buffer_len];
        let scanlines = unsafe {
            GetDIBits(
                mem_dc.dc,
                bitmap_raw,
                0,
                height,
                Some(pixels.as_mut_ptr() as *mut std::ffi::c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            )
        };
        if scanlines == 0 {
            return Err(napi::Error::from_reason("GetDIBits returned 0 scanlines"));
        }

        // 7. BGRA → RGBA + opaque alpha (GDI leaves the alpha byte as garbage
        //    for a screen BitBlt, so it is forced rather than trusted).
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }

        Ok(NativeCaptureRegionResult {
            data: Buffer::from(pixels),
            width,
            height,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Only the geometry-independent half of the capture is unit-testable here:
    // CI runs a single headless monitor, so negative origins and cross-monitor
    // regions are pinned by the multi-monitor E2E and the dogfood checklist
    // (ADR-031 §4.3). What these pin is the argument contract the napi entry
    // relies on before it touches any Win32 handle.

    #[test]
    fn buffer_len_is_four_bytes_per_pixel() {
        assert_eq!(capture_buffer_len(1, 1).unwrap(), 4);
        assert_eq!(capture_buffer_len(1920, 1080).unwrap(), 1920 * 1080 * 4);
    }

    #[test]
    fn empty_dimensions_are_rejected() {
        for (w, h) in [(0u32, 1080u32), (1920, 0), (0, 0)] {
            let err = capture_buffer_len(w, h).unwrap_err();
            assert!(
                err.reason.contains("Invalid capture dimensions"),
                "unexpected reason: {}",
                err.reason
            );
        }
    }

    #[test]
    fn dimensions_past_the_win32_extent_limit_are_rejected() {
        let err = capture_buffer_len(i32::MAX as u32 + 1, 1).unwrap_err();
        assert!(
            err.reason.contains("exceed the Win32 limit"),
            "unexpected reason: {}",
            err.reason
        );
        let err = capture_buffer_len(1, u32::MAX).unwrap_err();
        assert!(
            err.reason.contains("exceed the Win32 limit"),
            "unexpected reason: {}",
            err.reason
        );
    }

    // The largest pair that clears the extent check still multiplies out to
    // more than usize::MAX on a 32-bit target; on 64-bit it simply succeeds.
    // Either way the calculation must not wrap silently.
    #[test]
    fn buffer_size_never_wraps() {
        let max = i32::MAX as u32;
        match capture_buffer_len(max, max) {
            Ok(len) => assert_eq!(len, (max as usize) * (max as usize) * 4),
            Err(e) => assert!(
                e.reason.contains("overflows"),
                "unexpected reason: {}",
                e.reason
            ),
        }
    }
}
