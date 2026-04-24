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
    // bounds.x/y are added to dirty-rect coordinates (output→desktop offset).
    // Phase 3: single primary monitor, offset = 0.
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

        // Phase 3: use (0, 0) offset. Dirty rects from Desktop Duplication are in
        // desktop coordinates for the primary monitor. Multi-monitor offset support
        // is deferred to Phase 4.
        let bounds = OutputBounds { x: 0, y: 0, width: 0, height: 0 };

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
