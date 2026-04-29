//! GPU / EP / OS capability detection for AMD-first vendor-neutral cascade
//! (ADR-005 D2').
//!
//! Returned `CapabilityProfile` flows up to the TS side via `detect_capability()`
//! napi export, where the model registry uses it to pick the best variant.

use napi_derive::napi;
use crate::win32::safety::napi_safe_call;

/// Capability snapshot used by the TS model registry to pick a variant.
///
/// Sample profile on the dogfood machine (Radeon RX 9070 XT, Win11 24H2):
/// ```json
/// {
///   "os": "windows", "osBuild": 26100,
///   "gpuVendor": "AMD", "gpuDevice": "Radeon RX 9070 XT",
///   "gpuArch": "RDNA4", "gpuVramMb": 16384,
///   "winml": true, "directml": true, "rocm": false,
///   "cuda": false, "tensorrt": false,
///   "cpuIsa": ["avx512f","avx2","avx"],
///   "backendBuilt": true, "epsBuilt": ["directml"]
/// }
/// ```
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct CapabilityProfile {
    pub os: String,
    pub os_build: u32,
    pub gpu_vendor: String,
    pub gpu_device: String,
    pub gpu_arch: String,
    pub gpu_vram_mb: u32,
    pub winml: bool,
    pub directml: bool,
    pub rocm: bool,
    pub cuda: bool,
    pub tensorrt: bool,
    pub cpu_isa: Vec<String>,
    /// True when the `vision-gpu` cargo feature was enabled at build time.
    pub backend_built: bool,
    /// Cargo feature names of EPs compiled in (e.g. ["directml", "cuda"]).
    pub eps_built: Vec<String>,
}

/// Detect capability. Always succeeds — unavailable items are reported as `false`.
#[napi]
pub fn detect_capability() -> napi::Result<CapabilityProfile> {
    napi_safe_call("detect_capability", || {
        Ok(CapabilityProfile {
            os: detect_os(),
            os_build: detect_os_build(),
            gpu_vendor: detect_gpu().vendor,
            gpu_device: detect_gpu().device,
            gpu_arch: detect_gpu().arch,
            gpu_vram_mb: detect_gpu().vram_mb,
            winml: detect_winml(),
            directml: detect_directml(),
            rocm: detect_rocm(),
            cuda: detect_cuda(),
            tensorrt: detect_tensorrt(),
            cpu_isa: detect_cpu_isa(),
            backend_built: cfg!(feature = "vision-gpu"),
            eps_built: detect_eps_built(),
        })
    })
}

// ── OS detection ────────────────────────────────────────────────────────────

fn detect_os() -> String {
    if cfg!(target_os = "windows") { "windows" }
    else if cfg!(target_os = "linux") { "linux" }
    else if cfg!(target_os = "macos") { "macos" }
    else { "unknown" }
    .to_string()
}

#[cfg(target_os = "windows")]
fn detect_os_build() -> u32 {
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    // Safety: RtlGetVersion populates a stack-allocated OSVERSIONINFOW.
    unsafe {
        let _ = RtlGetVersion(&mut info);
    }
    info.dwBuildNumber
}

#[cfg(not(target_os = "windows"))]
fn detect_os_build() -> u32 { 0 }

// ── GPU detection (DXGI on Windows; stub elsewhere) ────────────────────────

struct GpuInfo {
    vendor: String,
    device: String,
    arch: String,
    vram_mb: u32,
}

#[cfg(target_os = "windows")]
fn detect_gpu() -> GpuInfo {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, DXGI_ADAPTER_DESC1,
        DXGI_ADAPTER_FLAG_SOFTWARE,
    };
    // Safety: DXGI factory creation is documented as thread-safe; failures
    // surface as an Err which we convert to an Unknown-vendor profile.
    let factory: Result<IDXGIFactory1, _> = unsafe { CreateDXGIFactory1() };
    let factory = match factory {
        Ok(f) => f,
        Err(_) => return unknown_gpu(),
    };
    // Pick the adapter with the largest dedicated VRAM (skip software / Microsoft Basic Render).
    let mut best: Option<DXGI_ADAPTER_DESC1> = None;
    let mut idx: u32 = 0;
    loop {
        let adapter_res: Result<IDXGIAdapter1, _> = unsafe { factory.EnumAdapters1(idx) };
        let adapter = match adapter_res {
            Ok(a) => a,
            Err(_) => break,
        };
        // windows 0.62: GetDesc1 returns the desc by value, not via out-pointer.
        if let Ok(desc) = unsafe { adapter.GetDesc1() } {
            // windows 0.62: Flags is u32, DXGI_ADAPTER_FLAG newtype is i32.
            // Cast Flags to i32 to AND against the newtype's inner value.
            let is_software = (desc.Flags as i32 & DXGI_ADAPTER_FLAG_SOFTWARE.0) != 0;
            let is_microsoft_basic = desc.VendorId == 0x1414;
            if !is_software && !is_microsoft_basic {
                match &best {
                    None => best = Some(desc),
                    Some(prev) if desc.DedicatedVideoMemory > prev.DedicatedVideoMemory => best = Some(desc),
                    _ => {}
                }
            }
        }
        idx += 1;
    }
    match best {
        Some(desc) => {
            let device = String::from_utf16_lossy(&desc.Description)
                .trim_end_matches('\0')
                .to_string();
            GpuInfo {
                vendor: vendor_id_to_name(desc.VendorId).to_string(),
                arch: gpu_arch_from_device(desc.VendorId, desc.DeviceId, &device),
                device,
                vram_mb: (desc.DedicatedVideoMemory / (1024 * 1024)) as u32,
            }
        }
        None => unknown_gpu(),
    }
}

#[cfg(not(target_os = "windows"))]
fn detect_gpu() -> GpuInfo { unknown_gpu() }

fn unknown_gpu() -> GpuInfo {
    GpuInfo {
        vendor: "Unknown".into(),
        device: String::new(),
        arch: "Unknown".into(),
        vram_mb: 0,
    }
}

fn vendor_id_to_name(id: u32) -> &'static str {
    match id {
        0x1002 | 0x1022 => "AMD",
        0x10DE => "NVIDIA",
        0x8086 => "Intel",
        0x1414 => "Microsoft",
        0x5143 => "Qualcomm",
        _ => "Unknown",
    }
}

/// Best-effort GPU architecture inference from VendorId + Description string.
///
/// Phase 4a heuristic — Phase 4b will use a proper DeviceId table.
/// AMD RDNA 世代判定は Description 文字列 ("Radeon RX 9070" 等) で十分実用。
fn gpu_arch_from_device(vendor_id: u32, _device_id: u32, description: &str) -> String {
    let d = description.to_lowercase();
    match vendor_id {
        0x1002 | 0x1022 => {
            // AMD Radeon — RX 9000 = RDNA4 (2025-)、RX 7000 = RDNA3、RX 6000 = RDNA2
            if d.contains("rx 9") || d.contains("rx9") { "RDNA4".into() }
            else if d.contains("rx 7") || d.contains("rx7") { "RDNA3".into() }
            else if d.contains("rx 6") || d.contains("rx6") { "RDNA2".into() }
            else if d.contains("rx 5") || d.contains("rx5") { "RDNA1".into() }
            else if d.contains("vega") { "GCN5".into() }
            else if d.contains("ai pro") { "RDNA4".into() }
            else { "AMD-Unknown".into() }
        }
        0x10DE => {
            // NVIDIA — RTX 50 = Blackwell、RTX 40 = Ada、RTX 30 = Ampere、RTX 20 = Turing
            if d.contains("rtx 50") || d.contains("rtx50") { "Blackwell".into() }
            else if d.contains("rtx 40") || d.contains("rtx40") { "Ada".into() }
            else if d.contains("rtx 30") || d.contains("rtx30") { "Ampere".into() }
            else if d.contains("rtx 20") || d.contains("rtx20") { "Turing".into() }
            else if d.contains("gtx 16") { "Turing".into() }
            else { "NVIDIA-Unknown".into() }
        }
        0x8086 => {
            // Intel — Arc B = Battlemage、Arc A = Alchemist
            if d.contains("arc b") { "Battlemage".into() }
            else if d.contains("arc") { "Alchemist".into() }
            else if d.contains("iris") || d.contains("uhd") { "Xe".into() }
            else { "Intel-Unknown".into() }
        }
        _ => "Unknown".into(),
    }
}

// ── EP availability ─────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn detect_winml() -> bool {
    // WinML on Win11 24H2 (build 26100) ships an in-box ONNX Runtime and the
    // onnxruntime-winml package picks it up. We don't try to load it here —
    // just signal availability so the TS registry knows it can attempt the
    // WinML lane.
    detect_os_build() >= 26100
}

#[cfg(not(target_os = "windows"))]
fn detect_winml() -> bool { false }

#[cfg(target_os = "windows")]
fn detect_directml() -> bool {
    // DirectML ships in Windows 10+ as DirectML.dll. We treat all Win10+ builds
    // as DirectML-capable; the EP itself reports failure if a particular GPU
    // refuses (in which case the cascade falls through to Vulkan/CPU).
    true
}

#[cfg(not(target_os = "windows"))]
fn detect_directml() -> bool { false }

fn detect_rocm() -> bool {
    // Windows: ROCm 7.2.1+ ships hipInfo.exe alongside the runtime DLLs.
    // We check both ROCM_PATH env var and a few common install locations.
    if std::env::var("ROCM_PATH").is_ok() { return true; }
    #[cfg(target_os = "windows")]
    {
        for p in ["C:\\Program Files\\AMD\\ROCm", "C:\\AMD\\ROCm"] {
            if std::path::Path::new(p).exists() { return true; }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for p in ["/opt/rocm", "/usr/local/rocm"] {
            if std::path::Path::new(p).exists() { return true; }
        }
    }
    false
}

fn detect_cuda() -> bool {
    if std::env::var("CUDA_PATH").is_ok() { return true; }
    #[cfg(target_os = "windows")]
    {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        if std::path::Path::new(&format!("{pf}\\NVIDIA GPU Computing Toolkit\\CUDA")).exists() {
            return true;
        }
    }
    #[cfg(target_os = "linux")]
    {
        if std::path::Path::new("/usr/local/cuda").exists() { return true; }
    }
    false
}

fn detect_tensorrt() -> bool {
    if std::env::var("TENSORRT_PATH").is_ok() { return true; }
    // Phase 4a: rely on env var only. Phase 4b will probe for nvinfer DLL.
    false
}

// ── CPU ISA detection ───────────────────────────────────────────────────────

fn detect_cpu_isa() -> Vec<String> {
    let mut isa = Vec::new();
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        if std::is_x86_feature_detected!("avx512f") { isa.push("avx512f".into()); }
        if std::is_x86_feature_detected!("avx2") { isa.push("avx2".into()); }
        if std::is_x86_feature_detected!("avx") { isa.push("avx".into()); }
        if std::is_x86_feature_detected!("sse4.2") { isa.push("sse4.2".into()); }
    }
    #[cfg(target_arch = "aarch64")]
    {
        isa.push("neon".into());
    }
    isa
}

// ── EP feature flags compiled into this build ──────────────────────────────

fn detect_eps_built() -> Vec<String> {
    #[allow(unused_mut)]
    let mut eps: Vec<String> = Vec::new();
    if cfg!(feature = "vision-gpu") { eps.push("directml".into()); } // base feature includes directml
    if cfg!(feature = "vision-gpu-cuda") { eps.push("cuda".into()); }
    if cfg!(feature = "vision-gpu-tensorrt") { eps.push("tensorrt".into()); }
    if cfg!(feature = "vision-gpu-rocm") { eps.push("rocm".into()); }
    if cfg!(feature = "vision-gpu-migraphx") { eps.push("migraphx".into()); }
    if cfg!(feature = "vision-gpu-coreml") { eps.push("coreml".into()); }
    if cfg!(feature = "vision-gpu-openvino") { eps.push("openvino".into()); }
    if cfg!(feature = "vision-gpu-webgpu") { eps.push("webgpu".into()); }
    if cfg!(feature = "vision-gpu-winml") { eps.push("winml".into()); }
    eps
}
