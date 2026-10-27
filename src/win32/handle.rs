//! The one reading of a window handle passed from JS as a `BigInt` (internal #303).
//!
//! Nine modules each had their own copy, and every copy dropped the sign and the lossless flag
//! from `get_u64()`. A handle past u64 wrapped to its low 64 bits — `2^64 + 0x1234` became
//! `0x1234`, another window — and a negative one became its magnitude. The TS side refuses both
//! before they get here (`parseTargetHwnd`, `parseWindowHandle`); this is the native side's own
//! floor, so a caller that skips that parse aims at no window rather than at someone else's.
//!
//! The SetWindowPos sentinels (HWND_TOPMOST = -1, HWND_NOTOPMOST = -2) are not read through here:
//! `window_op.rs` builds them itself.

use napi::bindgen_prelude::BigInt;
use windows::Win32::Foundation::HWND;

/// The handle, or the null HWND when the value is negative or does not fit in 64 bits. A null
/// HWND names no window, so the Win32 call that receives it fails as for any handle that is gone.
pub(crate) fn hwnd_from_bigint(b: BigInt) -> HWND {
    HWND(handle_value(&b).map_or(0, |v| v as isize) as *mut std::ffi::c_void)
}

fn handle_value(b: &BigInt) -> Option<u64> {
    let (negative, value, lossless) = b.get_u64();
    if negative || !lossless { None } else { Some(value) }
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
        assert_eq!(handle_value(&big(false, &[u64::MAX])), Some(u64::MAX));
    }

    #[test]
    fn past_u64_is_no_handle_not_its_low_bits() {
        // 2^64 + 0x1234: two words; get_u64 alone answers 0x1234
        assert_eq!(handle_value(&big(false, &[0x1234, 1])), None);
    }

    #[test]
    fn a_negative_value_is_no_handle() {
        assert_eq!(handle_value(&big(true, &[1])), None);
    }
}
