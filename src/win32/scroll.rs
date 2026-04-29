//! `GetScrollInfo` wrapper (ADR-007 P3). The legacy koffi binding had to
//! enforce `cbSize === 28` as a sanity check because koffi could silently
//! mis-pad the struct; the windows-rs `SCROLLINFO` is `repr(C)` so the
//! sizeof discipline comes for free, removing one of the explicit
//! sizeof-mine-detection hooks the TS code carried.

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetScrollInfo, SB_HORZ, SB_VERT, SCROLLBAR_CONSTANTS, SCROLLINFO, SIF_PAGE, SIF_POS,
    SIF_RANGE, SIF_TRACKPOS,
};

use super::safety::napi_safe_call;
use super::types::NativeScrollInfo;

fn hwnd_from_bigint(b: BigInt) -> HWND {
    let (_sign, val, _lossless) = b.get_u64();
    HWND(val as isize as *mut std::ffi::c_void)
}

/// Query the scrollbar position of `hwnd` for the given axis.
/// Returns `None` when the window has no scrollbar, the range is degenerate
/// (`nMax - nMin - nPage + 1 <= 0`), or the call fails — preserving the
/// legacy `readScrollInfo` semantics.
#[napi]
pub fn win32_get_scroll_info(
    hwnd: BigInt,
    axis: String,
) -> napi::Result<Option<NativeScrollInfo>> {
    napi_safe_call("win32_get_scroll_info", || {
        let bar: SCROLLBAR_CONSTANTS = match axis.as_str() {
            "vertical" => SB_VERT,
            "horizontal" => SB_HORZ,
            other => {
                return Err(napi::Error::from_reason(format!(
                    "unknown axis: {other:?} (expected \"vertical\" or \"horizontal\")"
                )))
            }
        };
        let mut si = SCROLLINFO {
            cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
            fMask: SIF_RANGE | SIF_PAGE | SIF_POS | SIF_TRACKPOS,
            nMin: 0,
            nMax: 0,
            nPage: 0,
            nPos: 0,
            nTrackPos: 0,
        };
        let h = hwnd_from_bigint(hwnd);
        let ok = unsafe { GetScrollInfo(h, bar, &mut si) };
        if ok.is_err() {
            return Ok(None);
        }
        let range = si.nMax - si.nMin - si.nPage as i32 + 1;
        if range <= 0 {
            return Ok(None);
        }
        let raw = (si.nPos - si.nMin) as f64 / range as f64;
        let page_ratio = raw.clamp(0.0, 1.0);
        Ok(Some(NativeScrollInfo {
            n_min: si.nMin,
            n_max: si.nMax,
            n_page: si.nPage,
            n_pos: si.nPos,
            page_ratio,
        }))
    })
}
