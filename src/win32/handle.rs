//! The one reading of a window handle passed from JS as a `BigInt` (internal #303).
//!
//! Nine modules each had their own copy, and every copy dropped the sign and the lossless flag
//! from `get_u64()`: a handle past u64 wrapped to its low 64 bits — `2^64 + 0x1234` became
//! `0x1234`, another window — and a negative one became its magnitude. The same rule is in TS
//! (`parseWindowHandle` in `aim.ts`, `parseTargetHwnd` in `session-registry.ts`), which refuses
//! these values before a tool gets here; this is the native side's own floor.
//!
//! A refused value is read as the null HWND, the same as a handle that is gone, so the read-only
//! calls keep their contract (ADR-007 panic-fuzz: "" / null / false for a bad handle, no throw).
//! NULL is not "no window" to every Win32 call, though: `PostMessageW(NULL)` posts to the calling
//! thread and succeeds, `ImmGetDefaultIMEWnd(NULL)` answers the thread's own IME window, and a
//! foreground check matches `GetForegroundWindow()` on the lock screen, where it is NULL too (Opus
//! review of #855). The entries that act like that check `refused_or_null` and fail before calling
//! Win32. Zero is read as NULL as it always was (`get_active_window` passes it on the lock screen).
//! The SetWindowPos sentinels are built in `window_op.rs` and never read here.

use napi::bindgen_prelude::BigInt;
use windows::Win32::Foundation::HWND;

/// `HWND_BROADCAST`: a message to it goes to every top-level window.
const HWND_BROADCAST_VALUE: u64 = 0xFFFF;

/// The handle, or the null HWND for a value that names no window: negative, past 64 bits, or a
/// pseudo-handle (`HWND_BROADCAST`, and -1/-2/-3 as `isize` — `HWND_TOPMOST`/`HWND_NOTOPMOST`/
/// `HWND_MESSAGE`).
pub(crate) fn hwnd_from_bigint(b: BigInt) -> HWND {
    HWND(handle_value(&b).unwrap_or(0) as isize as *mut std::ffi::c_void)
}

/// For an entry that must not reach Win32 with NULL (it would act on this thread, or match an absent
/// foreground): true when the value named no window, or named zero.
pub(crate) fn refused_or_null(h: HWND) -> bool {
    h.0.is_null()
}

/// `hwnd_from_bigint`'s rule, for the entries that keep the raw value (an async task's field).
pub(crate) fn handle_value(b: &BigInt) -> Option<u64> {
    // napi 2 reports a negative value as not lossless (`!sign_bit && words.len() == 1`, win2 read
    // bigint.rs), so `negative` adds nothing today; it stays as the rule, should that change.
    let (negative, value, lossless) = b.get_u64();
    let pseudo = value == HWND_BROADCAST_VALUE || matches!(value as isize, -3..=-1);
    if negative || !lossless || pseudo { None } else { Some(value) }
}

/// The error for a value `handle_value` refuses, where an entry fails by throwing (the async captures).
pub(crate) fn not_a_handle() -> napi::Error {
    napi::Error::from_reason("WindowNotFound: the value is not a window handle")
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
        // zero stays the null HWND (get_active_window on the lock screen)
        assert_eq!(handle_value(&big(false, &[0])), Some(0));
        // the edge of the pseudo-handles: -4 as isize is a handle (win2's mutation widening -3..=-1 passed)
        assert_eq!(handle_value(&big(false, &[u64::MAX - 3])), Some(u64::MAX - 3));
        assert_eq!(handle_value(&big(false, &[0xFFFE])), Some(0xFFFE));
        // a sign-extended 32-bit handle, if user32 ever hands one out, stays a handle
        assert_eq!(handle_value(&big(false, &[0xFFFF_FFFF_8000_1234])), Some(0xFFFF_FFFF_8000_1234));
    }

    #[test]
    fn past_u64_is_no_handle_not_its_low_bits() {
        // 2^64 + 0x1234: two words; get_u64 alone answers 0x1234
        assert_eq!(handle_value(&big(false, &[0x1234, 1])), None);
    }

    #[test]
    fn negative_and_pseudo_handles_are_no_handle() {
        assert_eq!(handle_value(&big(true, &[1])), None);
        assert_eq!(handle_value(&big(false, &[0xFFFF])), None);
        for v in [u64::MAX, u64::MAX - 1, u64::MAX - 2] {
            assert_eq!(handle_value(&big(false, &[v])), None, "{v:#x}");
        }
    }
}
