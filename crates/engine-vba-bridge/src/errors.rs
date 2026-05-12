//! Typed errors for the VBA Extensibility bridge (ADR-015 §4.4).
//!
//! Naming follows the `Vba*` PascalCase single-cap-acronym convention
//! that the project's existing `pascalToSnake` boundary rule
//! (`src/tools/_envelope.ts`) handles cleanly. Round-trip examples:
//!
//! | PascalCase | snake_case |
//! |---|---|
//! | `VbaAccessNotTrusted` | `vba_access_not_trusted` |
//! | `VbaAccessLockedByPolicy` | `vba_access_locked_by_policy` |
//! | `VbaModuleAuthoringFailed` | `vba_module_authoring_failed` |
//! | `VbaMacroExecutionFailed` | `vba_macro_execution_failed` |
//! | `VbaMacroNotFound` | `vba_macro_not_found` |
//! | `VbaUnsupportedArgumentType` | `vba_unsupported_argument_type` |
//! | `VbaWorkbookProtected` | `vba_workbook_protected` |
//! | `ExcelNotInstalled` | `excel_not_installed` |
//!
//! Mixed-case acronyms (`VBOM`, `HKCU`) are deliberately avoided
//! because `pascalToSnake` only splits at `[a-z][A-Z]` boundaries —
//! `VbaAccessNotTrusted` works, `AccessVBOMNotTrusted` would become
//! `access_vbomnot_trusted` (missing underscore before `not`).

use std::fmt;

pub type VbaBridgeResult<T> = std::result::Result<T, VbaBridgeError>;

/// Typed errors for the VBA bridge surface.
///
/// Each variant maps to a `_errors.ts` SUGGESTS entry with the same
/// PascalCase name (ADR-015 §4.4). Variants are kept thin: callers
/// receive an error code + a free-form context message that the napi
/// binding maps into the MCP envelope's `failure.reason` /
/// `failure.context` fields.
#[derive(Debug)]
pub enum VbaBridgeError {
    /// HKCU AccessVBOM is 0 and HKLM does not override it to 1.
    /// User must run the setup CLI (`scripts/enable-access-vbom.mjs`).
    VbaAccessNotTrusted,

    /// HKLM forces AccessVBOM to 0 (group policy). The MCP cannot
    /// override this; user must contact IT.
    VbaAccessLockedByPolicy,

    /// `CLSIDFromProgID("Excel.Application")` returned
    /// `REGDB_E_CLASSNOTREG`. Excel is not installed (or not registered).
    ExcelNotInstalled,

    /// `CodeModule::AddFromString` returned a non-zero HRESULT. The
    /// `code` argument is typically malformed VBA source. The context
    /// carries the underlying HRESULT description from the COM error
    /// info if available.
    VbaModuleAuthoringFailed(String),

    /// `Application::Run` returned a non-zero HRESULT.
    VbaMacroExecutionFailed(String),

    /// The caller's `code` does not declare a `Sub` matching the
    /// (defaulted) `macroName`. Detected at the wrapper level before
    /// invoking COM, so it surfaces cleanly without VBE involvement.
    VbaMacroNotFound { expected: String },

    /// Caller passed a JSON type that the VARIANT bridge does not
    /// support in v1 (`object` / `array` / dispatch). The caller can
    /// fall back to serializing into a worksheet cell.
    VbaUnsupportedArgumentType { json_type: &'static str },

    /// Workbook-level VBA password blocks `VBProject` access entirely.
    /// User must unlock the workbook manually before the bridge can
    /// add modules.
    VbaWorkbookProtected,

    /// A COM call returned an unexpected HRESULT. Used as a fallback
    /// when no more specific variant applies. The context carries the
    /// HRESULT code + the operation name at the failure site.
    ComCallFailed { hresult: i32, context: String },
}

impl VbaBridgeError {
    /// Returns the PascalCase code name for the error variant. This is
    /// the exact string the MCP envelope uses in `failure.reason`
    /// (after `pascalToSnake` projection in `src/tools/_envelope.ts`).
    pub fn code(&self) -> &'static str {
        match self {
            Self::VbaAccessNotTrusted => "VbaAccessNotTrusted",
            Self::VbaAccessLockedByPolicy => "VbaAccessLockedByPolicy",
            Self::ExcelNotInstalled => "ExcelNotInstalled",
            Self::VbaModuleAuthoringFailed(_) => "VbaModuleAuthoringFailed",
            Self::VbaMacroExecutionFailed(_) => "VbaMacroExecutionFailed",
            Self::VbaMacroNotFound { .. } => "VbaMacroNotFound",
            Self::VbaUnsupportedArgumentType { .. } => "VbaUnsupportedArgumentType",
            Self::VbaWorkbookProtected => "VbaWorkbookProtected",
            Self::ComCallFailed { .. } => "ComCallFailed",
        }
    }
}

impl fmt::Display for VbaBridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::VbaAccessNotTrusted => write!(
                f,
                "VbaAccessNotTrusted: HKCU AccessVBOM is 0; run scripts/enable-access-vbom.mjs"
            ),
            Self::VbaAccessLockedByPolicy => write!(
                f,
                "VbaAccessLockedByPolicy: HKLM group policy forces AccessVBOM=0; contact your IT department"
            ),
            Self::ExcelNotInstalled => write!(
                f,
                "ExcelNotInstalled: Excel.Application CLSID is not registered on this machine"
            ),
            Self::VbaModuleAuthoringFailed(ctx) => {
                write!(f, "VbaModuleAuthoringFailed: {ctx}")
            }
            Self::VbaMacroExecutionFailed(ctx) => {
                write!(f, "VbaMacroExecutionFailed: {ctx}")
            }
            Self::VbaMacroNotFound { expected } => write!(
                f,
                "VbaMacroNotFound: code does not declare Sub {expected}(...)"
            ),
            Self::VbaUnsupportedArgumentType { json_type } => write!(
                f,
                "VbaUnsupportedArgumentType: JSON {json_type} is not supported in args; \
                 serialize into a worksheet cell or pass a primitive (null / boolean / number / string)"
            ),
            Self::VbaWorkbookProtected => write!(
                f,
                "VbaWorkbookProtected: workbook-level VBA password blocks VBProject access; unlock manually"
            ),
            Self::ComCallFailed { hresult, context } => {
                write!(f, "ComCallFailed: HRESULT=0x{hresult:08x} at {context}")
            }
        }
    }
}

impl std::error::Error for VbaBridgeError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// All error codes must round-trip cleanly through the
    /// `pascalToSnake` boundary rule in `src/tools/_envelope.ts`
    /// (Codex Round 1 P2). The rule splits at every `[a-z][A-Z]`
    /// boundary, so any code containing a multi-uppercase run (`VBOM`,
    /// `HKCU`, etc.) would tokenize incorrectly. This test pins the
    /// invariant that all our codes have at most one uppercase letter
    /// per word.
    #[test]
    fn all_error_codes_are_single_cap_acronym_style() {
        let codes = [
            "VbaAccessNotTrusted",
            "VbaAccessLockedByPolicy",
            "ExcelNotInstalled",
            "VbaModuleAuthoringFailed",
            "VbaMacroExecutionFailed",
            "VbaMacroNotFound",
            "VbaUnsupportedArgumentType",
            "VbaWorkbookProtected",
            "ComCallFailed",
        ];
        for code in codes {
            assert!(
                !has_multi_uppercase_run(code),
                "code {code} contains a multi-uppercase run; pascalToSnake will tokenize incorrectly"
            );
        }
    }

    /// Returns true if `s` contains two consecutive uppercase letters.
    /// Mirrors the failure condition for `pascalToSnake` (which only
    /// splits at `[a-z][A-Z]` boundaries, so `VV` stays merged).
    fn has_multi_uppercase_run(s: &str) -> bool {
        let mut prev_upper = false;
        for c in s.chars() {
            let is_upper = c.is_ascii_uppercase();
            if is_upper && prev_upper {
                return true;
            }
            prev_upper = is_upper;
        }
        false
    }

    #[test]
    fn code_method_matches_variant_name() {
        // Spot-check a few variants.
        assert_eq!(VbaBridgeError::VbaAccessNotTrusted.code(), "VbaAccessNotTrusted");
        assert_eq!(VbaBridgeError::ExcelNotInstalled.code(), "ExcelNotInstalled");
        assert_eq!(
            VbaBridgeError::VbaMacroNotFound {
                expected: "Foo".into()
            }
            .code(),
            "VbaMacroNotFound"
        );
    }
}
