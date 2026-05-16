use windows::{
    core::Interface,
    Win32::{
        Foundation::HMODULE,
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
            Direct3D11::{
                D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
                ID3D11Device,
            },
            Dxgi::{
                CreateDXGIFactory1, IDXGIAdapter, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput,
                IDXGIOutput1, IDXGIOutputDuplication, DXGI_ERROR_UNSUPPORTED,
            },
        },
    },
};

use super::types::{DuplicationError, OutputBounds};

pub struct DuplicationContext {
    pub duplication: IDXGIOutputDuplication,
    // bounds.x/y are added to dirty-rect coordinates by `thread.rs:271-272`
    // (output-local → desktop coord translation). For the primary monitor
    // (output 0) DesktopCoordinates is typically (0, 0, primaryW, primaryH)
    // so the offset is a no-op; for secondary monitors with positive or
    // negative desktop placement, this offset is load-bearing.
    pub bounds: OutputBounds,
    // Keep device alive — IDXGIOutputDuplication holds an implicit ref,
    // but we pin it here to ensure drop order is predictable.
    #[allow(dead_code)]
    pub device: ID3D11Device,
}

pub fn create_context(output_index: u32) -> Result<DuplicationContext, DuplicationError> {
    unsafe {
        // 1. DXGI Factory
        let factory: IDXGIFactory1 = CreateDXGIFactory1()
            .map_err(|e| DuplicationError::InitFailed(format!("CreateDXGIFactory1: {e}")))?;

        // 2. Primary adapter
        let adapter1: IDXGIAdapter1 = factory
            .EnumAdapters1(0)
            .map_err(|e| DuplicationError::InitFailed(format!("EnumAdapters1: {e}")))?;

        // Cast to IDXGIAdapter for D3D11CreateDevice.
        let adapter: IDXGIAdapter = adapter1
            .cast()
            .map_err(|e| DuplicationError::InitFailed(format!("IDXGIAdapter cast: {e}")))?;

        // 3. D3D11 device. When providing an adapter, DriverType must be UNKNOWN.
        // `software` takes HMODULE (not Option) — pass null handle (unused for hardware EP).
        let mut device_opt: Option<ID3D11Device> = None;
        D3D11CreateDevice(
            &adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device_opt),
            None,
            None,
        )
        .map_err(|e| DuplicationError::InitFailed(format!("D3D11CreateDevice: {e}")))?;

        let device = device_opt
            .ok_or_else(|| DuplicationError::InitFailed("D3D11 device null".into()))?;

        // 4. Enumerate output (IDXGIOutput, parent interface).
        let output: IDXGIOutput = adapter1
            .EnumOutputs(output_index)
            .map_err(|_| {
                DuplicationError::InitFailed(format!("output {output_index} not found"))
            })?;

        // ADR-019 Stage 5 multi-monitor prerequisite — query the output's actual
        // DesktopCoordinates so `thread.rs` can translate output-local dirty rects
        // into desktop coords for cross-monitor windows. windows 0.62 returns the
        // descriptor by value (same pattern as `vision_backend/capability.rs:128`
        // for IDXGIAdapter1::GetDesc1). For primary monitor this typically gives
        // `(0, 0, primaryW, primaryH)` so the addition is a no-op; for secondary
        // monitors positioned to the right `(1920, 0, ...)` or left `(-1920, 0, ...)`
        // the offset is load-bearing.
        let desc = output
            .GetDesc()
            .map_err(|e| DuplicationError::InitFailed(format!("IDXGIOutput::GetDesc: {e}")))?;
        let r = desc.DesktopCoordinates;
        let bounds = OutputBounds {
            x: r.left,
            y: r.top,
            width: r.right - r.left,
            height: r.bottom - r.top,
        };

        // 5. Cast to IDXGIOutput1 for DuplicateOutput.
        let output1: IDXGIOutput1 = output
            .cast()
            .map_err(|e| DuplicationError::InitFailed(format!("IDXGIOutput1 cast: {e}")))?;

        // 6. DuplicateOutput — DXGI_ERROR_UNSUPPORTED on RDP / older drivers.
        let duplication = output1.DuplicateOutput(&device).map_err(|e| {
            if e.code() == DXGI_ERROR_UNSUPPORTED {
                DuplicationError::Unsupported
            } else {
                DuplicationError::InitFailed(format!("DuplicateOutput: {e}"))
            }
        })?;

        Ok(DuplicationContext { device, duplication, bounds })
    }
}
