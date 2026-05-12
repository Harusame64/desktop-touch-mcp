//! `serde_json::Value` ↔ `VARIANT` bridge (ADR-015 §3.5).
//!
//! VBA macro arguments and return values flow through `VARIANT`. This
//! module provides:
//!
//! - A pure-function classifier ([`classify_json`]) that maps a JSON
//!   value to its target VARIANT type tag ([`VariantKind`]). The
//!   classifier is testable on every platform (no Windows dependency)
//!   and is the centre of the `null → VT_NULL` semantic invariant
//!   that Round 1 of ADR-015 incorrectly mapped to `VT_EMPTY`
//! - On Windows, the actual `VARIANT` construction routines
//!   ([`json_to_variant`] / [`variant_to_json`]) that consume / produce
//!   `windows::Win32::System::Variant::VARIANT`
//!
//! ## Supported types
//!
//! | JSON | VARIANT | Notes |
//! |---|---|---|
//! | `null` | `VT_NULL` | Matches VBA `IsNull()`. NOT `VT_EMPTY`. |
//! | `true` / `false` | `VT_BOOL` | `VARIANT_TRUE` = -1, `VARIANT_FALSE` = 0 |
//! | integer | `VT_I4` | Clamped to `i32` range |
//! | float | `VT_R8` | |
//! | string | `VT_BSTR` (default) | |
//! | `{__type:"date", value:"<ISO-8601>"}` | `VT_DATE` | Explicit opt-in per ADR-015 §3.5; JSON has no native Date type and ISO autodetect would silently change semantics (Codex Round 2 axis) |
//!
//! Object / array / null-typed nested structures return
//! [`VbaBridgeError::VbaUnsupportedArgumentType`]; callers serialize
//! complex data into a worksheet cell instead.

use serde_json::Value;

use crate::errors::{VbaBridgeError, VbaBridgeResult};

/// Target VARIANT type for a given JSON value.
///
/// Returned by [`classify_json`]. The variants intentionally carry the
/// already-validated payload so the windows-side conversion code in
/// [`json_to_variant`] does not have to re-extract it from the
/// `serde_json::Value`.
#[derive(Debug, Clone, PartialEq)]
pub enum VariantKind {
    /// `VT_NULL` — VBA `IsNull()` is true.
    Null,
    /// `VT_BOOL` — VBA `True` / `False`.
    Bool(bool),
    /// `VT_I4` — VBA `Long` (32-bit signed integer).
    I4(i32),
    /// `VT_R8` — VBA `Double` (64-bit float).
    R8(f64),
    /// `VT_BSTR` — VBA `String`.
    Bstr(String),
    /// `VT_DATE` — VBA `Date`. The value is the ISO-8601 string the
    /// caller tagged with `{__type:"date", value:"..."}`; the windows-side
    /// conversion parses it into the OLE Automation date (days since
    /// 1899-12-30) format. The parsing is deferred to the windows-side
    /// code (or to a future helper) — Phase 1 only classifies.
    Date(String),
}

/// Classifies a JSON value to its target VARIANT kind.
///
/// This is a pure function with no Windows dependency, so the unit
/// tests in this module cover it on every platform. The actual
/// `windows::Win32::System::Variant::VARIANT` construction lives in
/// [`json_to_variant`] (Windows only).
///
/// ## Rules
///
/// - `Value::Null` → `VariantKind::Null` (NOT `Empty`).
///   The `VT_NULL` vs `VT_EMPTY` distinction matters in VBA: `IsNull()`
///   tests for `VT_NULL`, `IsEmpty()` tests for `VT_EMPTY`. Mapping a
///   JSON `null` to `VT_EMPTY` would make `IsNull()` return false in
///   macros that branch on null-handling, which is the opposite of
///   caller intent. Round 1 of ADR-015 had this wrong; Round 2 fixed it.
///
/// - `Value::Bool` → `VariantKind::Bool(b)`.
///
/// - `Value::Number(i)` where i fits in `i32` → `VariantKind::I4(i)`.
///   Numbers outside `i32` range fall through to `VT_R8` via the float
///   path below — they round-trip lossily but preserve the value.
///
/// - `Value::Number(f)` → `VariantKind::R8(f)`.
///
/// - `Value::String(s)` → `VariantKind::Bstr(s)` (default).
///
/// - `Value::Object` with shape `{__type:"date", value:"<ISO>"}` →
///   `VariantKind::Date(value)`. **This is the only date path**; ISO
///   autodetect on plain strings is intentionally not supported (it
///   would silently change macro semantics — Codex Round 2 axis).
///
/// - `Value::Object` (other shapes) → error.
/// - `Value::Array` → error.
pub fn classify_json(v: &Value) -> VbaBridgeResult<VariantKind> {
    match v {
        Value::Null => Ok(VariantKind::Null),
        Value::Bool(b) => Ok(VariantKind::Bool(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if (i32::MIN as i64..=i32::MAX as i64).contains(&i) {
                    return Ok(VariantKind::I4(i as i32));
                }
                // Out-of-range integer falls through to R8.
            }
            if let Some(f) = n.as_f64() {
                Ok(VariantKind::R8(f))
            } else {
                // Number that fits in neither i64 nor f64; treat as
                // unsupported rather than panicking.
                Err(VbaBridgeError::VbaUnsupportedArgumentType {
                    json_type: "number-out-of-range",
                })
            }
        }
        Value::String(s) => Ok(VariantKind::Bstr(s.clone())),
        Value::Object(map) => {
            // Date wrapper: {__type: "date", value: "<ISO-8601>"}
            if let Some(Value::String(t)) = map.get("__type") {
                if t == "date" {
                    if let Some(Value::String(val)) = map.get("value") {
                        return Ok(VariantKind::Date(val.clone()));
                    }
                }
            }
            Err(VbaBridgeError::VbaUnsupportedArgumentType { json_type: "object" })
        }
        Value::Array(_) => Err(VbaBridgeError::VbaUnsupportedArgumentType { json_type: "array" }),
    }
}

#[cfg(windows)]
mod win {
    //! Windows-only `VARIANT` construction. Phase 1 ships the
    //! classifier + unit tests; the actual `windows::Win32::System::Variant::VARIANT`
    //! construction comes online in Phase 2 alongside `excel.rs`.
    //!
    //! Phase 1 keeps this submodule as a stub so the public API
    //! surface (`json_to_variant` / `variant_to_json`) can be referenced
    //! by future Phase 2 code without further crate-level wiring.

    use super::{VariantKind, VbaBridgeError, VbaBridgeResult, Value};

    /// Construct a `VARIANT` from a JSON value.
    ///
    /// Phase 1: stub that classifies and returns the kind. The actual
    /// `VARIANT` construction (allocating BSTRs, packing into the
    /// VARIANT union, etc.) lands in Phase 2 alongside `excel.rs`.
    pub fn json_to_variant_kind(v: &Value) -> VbaBridgeResult<VariantKind> {
        super::classify_json(v)
    }

    /// Stub for the reverse direction. Phase 2 implements VARIANT
    /// extraction from `IDispatch::Invoke` return values.
    pub fn variant_kind_to_json(kind: VariantKind) -> VbaBridgeResult<Value> {
        match kind {
            VariantKind::Null => Ok(Value::Null),
            VariantKind::Bool(b) => Ok(Value::Bool(b)),
            VariantKind::I4(i) => Ok(Value::Number(i.into())),
            VariantKind::R8(f) => Ok(serde_json::Number::from_f64(f)
                .map(Value::Number)
                .unwrap_or(Value::Null)),
            VariantKind::Bstr(s) => Ok(Value::String(s)),
            VariantKind::Date(iso) => {
                // Round-trip a date as the same {__type:"date", value:...}
                // wrapper the caller used on the way in, so callers do
                // not need to special-case the return-value shape.
                Ok(serde_json::json!({"__type": "date", "value": iso}))
            }
        }
    }

    #[allow(dead_code)]
    fn _phase2_placeholder(_: &VbaBridgeError) {
        // Suppresses unused-import warnings on Phase 1 cdylib builds.
    }
}

#[cfg(windows)]
pub use win::{json_to_variant_kind as json_to_variant, variant_kind_to_json as variant_to_json};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn null_maps_to_vt_null_not_vt_empty() {
        // Round 1 of ADR-015 had this wrong (mapped to VT_EMPTY).
        // This test pins the corrected semantic per ADR-015 §3.5.
        let v = Value::Null;
        let kind = classify_json(&v).unwrap();
        assert_eq!(kind, VariantKind::Null);
        // Belt-and-suspenders: confirm the enum has no Empty variant
        // (compile-time check — if someone later adds VariantKind::Empty
        // and routes Null to it, this match will still pin Null → Null).
        match kind {
            VariantKind::Null => {}
            _ => panic!("null must classify to VariantKind::Null"),
        }
    }

    #[test]
    fn boolean_maps_to_bool() {
        assert_eq!(
            classify_json(&Value::Bool(true)).unwrap(),
            VariantKind::Bool(true)
        );
        assert_eq!(
            classify_json(&Value::Bool(false)).unwrap(),
            VariantKind::Bool(false)
        );
    }

    #[test]
    fn small_integer_maps_to_i4() {
        assert_eq!(classify_json(&json!(0)).unwrap(), VariantKind::I4(0));
        assert_eq!(classify_json(&json!(42)).unwrap(), VariantKind::I4(42));
        assert_eq!(classify_json(&json!(-100)).unwrap(), VariantKind::I4(-100));
        // i32 boundaries
        assert_eq!(
            classify_json(&json!(i32::MAX)).unwrap(),
            VariantKind::I4(i32::MAX)
        );
        assert_eq!(
            classify_json(&json!(i32::MIN)).unwrap(),
            VariantKind::I4(i32::MIN)
        );
    }

    #[test]
    fn large_integer_falls_through_to_r8() {
        // i32::MAX + 1 cannot fit in I4, so the classifier falls
        // through to R8 (lossless for this exact value).
        let big = (i32::MAX as i64) + 1;
        match classify_json(&json!(big)).unwrap() {
            VariantKind::R8(f) => assert_eq!(f as i64, big),
            other => panic!("expected R8, got {other:?}"),
        }
    }

    #[test]
    fn float_maps_to_r8() {
        match classify_json(&json!(1.5)).unwrap() {
            VariantKind::R8(f) => assert!((f - 1.5).abs() < f64::EPSILON),
            other => panic!("expected R8, got {other:?}"),
        }
    }

    #[test]
    fn string_maps_to_bstr_by_default() {
        // Plain string stays BSTR — ISO-looking strings DO NOT
        // auto-promote to VT_DATE (Codex Round 2 P2: avoid silently
        // changing argument semantics).
        let iso_looking = "2026-05-12T00:00:00Z";
        assert_eq!(
            classify_json(&json!(iso_looking)).unwrap(),
            VariantKind::Bstr(iso_looking.into())
        );
    }

    #[test]
    fn date_wrapper_maps_to_vt_date() {
        // Caller-tagged date wrapper opts in to VT_DATE.
        let v = json!({"__type": "date", "value": "2026-05-12T00:00:00Z"});
        assert_eq!(
            classify_json(&v).unwrap(),
            VariantKind::Date("2026-05-12T00:00:00Z".into())
        );
    }

    #[test]
    fn object_without_date_wrapper_is_unsupported() {
        let v = json!({"foo": "bar"});
        match classify_json(&v) {
            Err(VbaBridgeError::VbaUnsupportedArgumentType { json_type }) => {
                assert_eq!(json_type, "object");
            }
            other => panic!("expected VbaUnsupportedArgumentType, got {other:?}"),
        }
    }

    #[test]
    fn object_with_wrong_type_tag_is_unsupported() {
        // Wrapper-looking object with a non-"date" __type is rejected
        // (no future-compatibility hole that silently accepts unknown
        // types).
        let v = json!({"__type": "unknown", "value": "x"});
        assert!(matches!(
            classify_json(&v),
            Err(VbaBridgeError::VbaUnsupportedArgumentType { json_type: "object" })
        ));
    }

    #[test]
    fn array_is_unsupported() {
        let v = json!([1, 2, 3]);
        match classify_json(&v) {
            Err(VbaBridgeError::VbaUnsupportedArgumentType { json_type }) => {
                assert_eq!(json_type, "array");
            }
            other => panic!("expected VbaUnsupportedArgumentType, got {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_round_trip_via_kind() {
        // Phase 1 windows path is a thin pass-through to the
        // classifier. This test pins that path so Phase 2 cannot
        // accidentally diverge the windows and non-windows views.
        let v = Value::Null;
        let round_trip = win::variant_kind_to_json(win::json_to_variant_kind(&v).unwrap()).unwrap();
        assert_eq!(round_trip, Value::Null);

        let v = json!(42);
        let round_trip = win::variant_kind_to_json(win::json_to_variant_kind(&v).unwrap()).unwrap();
        assert_eq!(round_trip, json!(42));

        let v = json!("hello");
        let round_trip = win::variant_kind_to_json(win::json_to_variant_kind(&v).unwrap()).unwrap();
        assert_eq!(round_trip, json!("hello"));

        let v = json!({"__type": "date", "value": "2026-05-12"});
        let round_trip = win::variant_kind_to_json(win::json_to_variant_kind(&v).unwrap()).unwrap();
        assert_eq!(round_trip, json!({"__type": "date", "value": "2026-05-12"}));
    }
}
