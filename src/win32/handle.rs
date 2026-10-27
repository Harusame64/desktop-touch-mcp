//! The one reading of a window handle passed from JS as a `BigInt` (internal #303).
//!
//! Nine modules each had their own copy, and every copy dropped the sign and the lossless flag
//! from `get_u64()`: a handle past u64 wrapped to its low 64 bits — `2^64 + 0x1234` became
//! `0x1234`, another window — and a negative one became its magnitude. The TS side refuses those
//! before they get here (`parseTargetHwnd`, `parseWindowHandle`); this is the native side's own
//! floor, for a caller that skips that parse.
//!
//! A refused value is an error, not the null HWND: Win32 reads NULL as "this thread" or "none" by
//! call, not as a window that is gone — `PostMessageW(NULL)` posts to the calling thread and
//! succeeds, `ImmGetDefaultIMEWnd(NULL)` answers the thread's own IME window, and a foreground
//! check against `GetForegroundWindow()` on the lock screen (NULL too) matches (Opus review of
//! #855). The SetWindowPos sentinels are built in `window_op.rs` and never read here.

use napi::bindgen_prelude::BigInt;
use windows::Win32::Foundation::HWND;

/// `HWND_BROADCAST`: a message to it goes to every top-level window.
const HWND_BROADCAST_VALUE: u64 = 0xFFFF;

/// The handle, or an error when the value names no window: zero, negative, past 64 bits, or one of
/// the pseudo-handles (`HWND_BROADCAST`, and -1/-2/-3 as `isize` — `HWND_TOPMOST`/`HWND_NOTOPMOST`/
/// `HWND_MESSAGE`).
pub(crate) fn hwnd_from_bigint(b: BigInt) -> napi::Result<HWND> {
    handle_value(&b)
        .map(|v| HWND(v as isize as *mut std::ffi::c_void))
        .ok_or_else(|| napi::Error::from_reason("WindowNotFound: the value is not a window handle"))
}

/// `hwnd_from_bigint`'s rule, for the entries that keep the raw value (an async task's field).
pub(crate) fn handle_value(b: &BigInt) -> Option<u64> {
    let (negative, value, lossless) = b.get_u64();
    if negative || !lossless || value == 0 || value == HWND_BROADCAST_VALUE || (value as isize) < 0 && (value as isize) >= -3 {
        None
    } else {
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn big(sign_bit: bool, words: &[u64]) -> BigInt {
        BigInt { sign_bit, words: words.to_vec() }
    }

    #[test]
    fn a_handle_that_fits_is_read_as_it_is() {
        assert_eq!(handle_value(&big(false, &[0x1234])), Some(0x1234));
        // a sign-extended 32-bit handle, if user32 ever hands one out, stays a handle
        assert_eq!(handle_value(&big(false, &[0xFFFF_FFFF_8000_1234])), Some(0xFFFF_FFFF_8000_1234));
    }

    #[test]
    fn past_u64_is_no_handle_not_its_low_bits() {
        // 2^64 + 0x1234: two words; get_u64 alone answers 0x1234
        assert_eq!(handle_value(&big(false, &[0x1234, 1])), None);
    }

    #[test]
    fn negative_zero_and_pseudo_handles_are_no_handle() {
        assert_eq!(handle_value(&big(true, &[1])), None);
        assert_eq!(handle_value(&big(false, &[0])), None);
        assert_eq!(handle_value(&big(false, &[0xFFFF])), None);
        for v in [u64::MAX, u64::MAX - 1, u64::MAX - 2] {
            assert_eq!(handle_value(&big(false, &[v])), None, "{v:#x}");
        }
    }
}
