//! GDI capture (ADR-007 P2) — `print_window_to_buffer`.
//!
//! Replaces the koffi-driven sequence in `printWindowToBuffer`:
//!   GetWindowRect → GetDC(NULL) → CreateCompatibleDC → CreateCompatibleBitmap
//!   → SelectObject → PrintWindow → GetDIBits → reshape BGRA→RGBA → cleanup.
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
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
    HGDIOBJ,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

use super::safety::napi_safe_call;
use super::types::NativePrintWindowResult;

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
