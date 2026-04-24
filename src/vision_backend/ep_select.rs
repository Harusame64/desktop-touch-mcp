//! EP cascade builder for the visual GPU backend (ADR-005 D2').
//!
//! `build_cascade` converts a `CapabilityProfile` into an ordered list of
//! `EpAttempt` values. The caller iterates and calls `try_one_ep` for each
//! until one succeeds. CPU is always the final fallback.
//!
//! The design intentionally avoids `with_execution_providers([all_eps])` — see
//! design doc §3.2 / §9.2 for the rationale (deterministic EP selection).

use crate::vision_backend::capability::CapabilityProfile;
use crate::vision_backend::types::SelectedEp;

/// One EP attempt: the kind (for logging) and a closure that registers the
/// EP on a SessionBuilder. Cloneable so we can log / iterate without consuming.
pub struct EpAttempt {
    pub kind: SelectedEp,
    /// `apply` mutates the builder by registering the EP, then returns it.
    /// Returning Err here means "this EP couldn't even be configured" —
    /// caller treats it as a failed attempt and moves to the next.
    pub apply: std::sync::Arc<
        dyn Fn(ort::session::builder::SessionBuilder)
            -> Result<ort::session::builder::SessionBuilder, ort::Error>
            + Send
            + Sync,
    >,
}

impl Clone for EpAttempt {
    fn clone(&self) -> Self {
        Self {
            kind: self.kind.clone(),
            apply: self.apply.clone(),
        }
    }
}

/// Build the cascade order from a capability profile. Order matches
/// ADR-005 D2' Layer 1/2 + final CPU fallback.
///
/// 4b-1 scope: WinML attempt is registered as a label only but skipped
/// at try time (Phase 4b-2 wires it). DirectML / ROCm / CUDA depend on
/// runtime detection AND build features.
pub fn build_cascade(profile: &CapabilityProfile) -> Vec<EpAttempt> {
    let mut out: Vec<EpAttempt> = Vec::new();

    // WinML (Phase 4b-2 will provide the real implementation)
    if profile.winml && cfg!(feature = "vision-gpu-winml") {
        out.push(winml_attempt());
    }

    // DirectML (always available with `vision-gpu` feature on Windows)
    if profile.directml {
        out.push(directml_attempt(0));
    }

    // ROCm (opt-in feature)
    #[cfg(feature = "vision-gpu-rocm")]
    if profile.rocm {
        out.push(rocm_attempt(0));
    }

    // CUDA (opt-in feature)
    #[cfg(feature = "vision-gpu-cuda")]
    if profile.cuda {
        out.push(cuda_attempt(0));
    }

    // Layer 3: WebGPU (opt-in feature, vendor-neutral via wgpu → Vulkan/DX12/Metal).
    // Inserted between vendor-specific Layer 2 EPs and the CPU fallback so it only
    // runs when DirectML/ROCm/CUDA are unavailable or unregistered for this build.
    // Guarded by `gpu_vram_mb > 0` — on headless / CPU-only machines WebGPU cannot
    // produce a usable adapter anyway, so skipping avoids spending a session attempt.
    #[cfg(feature = "vision-gpu-webgpu")]
    if profile.gpu_vram_mb > 0 {
        out.push(webgpu_attempt());
    }

    // CPU is always last
    out.push(cpu_attempt());

    out
}

fn directml_attempt(device_id: u32) -> EpAttempt {
    EpAttempt {
        kind: SelectedEp::DirectML { device_id },
        apply: std::sync::Arc::new(move |builder| {
            use ort::execution_providers::DirectMLExecutionProvider;
            builder
                .with_execution_providers([DirectMLExecutionProvider::default()
                    .with_device_id(device_id as i32)
                    .build()])
                .map_err(|e| ort::Error::new(e.to_string()))
        }),
    }
}

fn cpu_attempt() -> EpAttempt {
    EpAttempt {
        kind: SelectedEp::Cpu,
        // CPU EP is implicit — registering an empty list lets ort use
        // the default CPU provider for every op.
        apply: std::sync::Arc::new(|builder| Ok(builder)),
    }
}

fn winml_attempt() -> EpAttempt {
    // Phase 4b-1: stub that always errors — Phase 4b-2 replaces this body.
    EpAttempt {
        kind: SelectedEp::WinML,
        apply: std::sync::Arc::new(|_b| {
            Err(ort::Error::new("WinML EP stub (Phase 4b-2) not yet implemented"))
        }),
    }
}

#[cfg(feature = "vision-gpu-rocm")]
fn rocm_attempt(device_id: u32) -> EpAttempt {
    EpAttempt {
        kind: SelectedEp::Rocm { device_id },
        apply: std::sync::Arc::new(move |builder| {
            use ort::execution_providers::ROCmExecutionProvider;
            builder
                .with_execution_providers([ROCmExecutionProvider::default()
                    .with_device_id(device_id as i32)
                    .build()])
                .map_err(|e| ort::Error::new(e.to_string()))
        }),
    }
}

#[cfg(feature = "vision-gpu-cuda")]
fn cuda_attempt(device_id: u32) -> EpAttempt {
    EpAttempt {
        kind: SelectedEp::Cuda { device_id },
        apply: std::sync::Arc::new(move |builder| {
            use ort::execution_providers::CUDAExecutionProvider;
            builder
                .with_execution_providers([CUDAExecutionProvider::default()
                    .with_device_id(device_id as i32)
                    .build()])
                .map_err(|e| ort::Error::new(e.to_string()))
        }),
    }
}

#[cfg(feature = "vision-gpu-webgpu")]
fn webgpu_attempt() -> EpAttempt {
    // Phase 4b-3 (ADR-005 D2' Layer 3): ort WebGPU EP (wgpu → Vulkan/DX12/Metal).
    // `adapter` is populated as empty here because ort 2.0.0-rc.12 does not
    // surface the selected wgpu adapter name via the EP options surface.
    // A future batch may fill this via a separate wgpu probe (§10 future work).
    EpAttempt {
        kind: SelectedEp::WebGPU { adapter: String::new() },
        apply: std::sync::Arc::new(|builder| {
            use ort::execution_providers::WebGPUExecutionProvider;
            builder
                .with_execution_providers([WebGPUExecutionProvider::default().build()])
                .map_err(|e| ort::Error::new(e.to_string()))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_amd_rdna4_no_extras() -> CapabilityProfile {
        CapabilityProfile {
            os: "windows".into(),
            os_build: 26100,
            gpu_vendor: "AMD".into(),
            gpu_device: "Radeon RX 9070 XT".into(),
            gpu_arch: "RDNA4".into(),
            gpu_vram_mb: 16384,
            winml: false,
            directml: true,
            rocm: false,
            cuda: false,
            tensorrt: false,
            cpu_isa: vec!["avx2".into()],
            backend_built: true,
            eps_built: vec!["directml".into()],
        }
    }

    #[test]
    fn cascade_amd_directml_only() {
        let p = profile_amd_rdna4_no_extras();
        let attempts = build_cascade(&p);
        let kinds: Vec<_> = attempts.iter().map(|a| a.kind.as_label()).collect();
        assert_eq!(kinds, vec!["DirectML(0)", "CPU"]);
    }

    #[test]
    fn cascade_winml_first_when_feature_on() {
        // Compiled only with vision-gpu-winml feature
        #[cfg(feature = "vision-gpu-winml")]
        {
            let mut p = profile_amd_rdna4_no_extras();
            p.winml = true;
            let attempts = build_cascade(&p);
            assert_eq!(attempts[0].kind.as_label(), "WinML");
        }
        // Without the feature the test is trivially passing (no assertions needed)
        #[cfg(not(feature = "vision-gpu-winml"))]
        {
            let _ = profile_amd_rdna4_no_extras();
        }
    }

    #[test]
    fn cascade_cpu_only_when_no_gpu() {
        let mut p = profile_amd_rdna4_no_extras();
        p.directml = false;
        let attempts = build_cascade(&p);
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].kind.as_label(), "CPU");
    }

    #[test]
    fn cascade_rocm_when_feature_on() {
        #[cfg(feature = "vision-gpu-rocm")]
        {
            let mut p = profile_amd_rdna4_no_extras();
            p.rocm = true;
            let attempts = build_cascade(&p);
            let labels: Vec<_> = attempts.iter().map(|a| a.kind.as_label()).collect();
            assert!(labels.contains(&"ROCm(0)".to_string()));
        }
        #[cfg(not(feature = "vision-gpu-rocm"))]
        {
            let _ = profile_amd_rdna4_no_extras();
        }
    }

    #[test]
    fn ep_attempt_is_clone() {
        // Verify EpAttempt clone doesn't panic (Arc::clone should be cheap)
        let p = profile_amd_rdna4_no_extras();
        let attempts = build_cascade(&p);
        let cloned: Vec<_> = attempts.iter().map(|a| a.clone()).collect();
        assert_eq!(
            attempts.iter().map(|a| a.kind.as_label()).collect::<Vec<_>>(),
            cloned.iter().map(|a| a.kind.as_label()).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn selected_ep_labels_are_correct() {
        assert_eq!(SelectedEp::WinML.as_label(), "WinML");
        assert_eq!(SelectedEp::DirectML { device_id: 0 }.as_label(), "DirectML(0)");
        assert_eq!(SelectedEp::DirectML { device_id: 1 }.as_label(), "DirectML(1)");
        assert_eq!(SelectedEp::Rocm { device_id: 0 }.as_label(), "ROCm(0)");
        assert_eq!(SelectedEp::Cuda { device_id: 0 }.as_label(), "CUDA(0)");
        assert_eq!(SelectedEp::Cpu.as_label(), "CPU");
        assert_eq!(SelectedEp::Fallback("all failed".into()).as_label(), "Fallback(all failed)");
    }

    #[test]
    fn webgpu_selected_ep_label() {
        assert_eq!(SelectedEp::WebGPU { adapter: String::new() }.as_label(), "WebGPU");
        assert_eq!(
            SelectedEp::WebGPU { adapter: "AMD Radeon RX 9070 XT (Vulkan)".into() }.as_label(),
            "WebGPU(AMD Radeon RX 9070 XT (Vulkan))"
        );
    }

    #[test]
    fn cascade_includes_webgpu_before_cpu_when_feature_on() {
        #[cfg(feature = "vision-gpu-webgpu")]
        {
            let p = profile_amd_rdna4_no_extras();
            let attempts = build_cascade(&p);
            let labels: Vec<_> = attempts.iter().map(|a| a.kind.as_label()).collect();
            // WebGPU is Layer 3 — after DirectML (Layer 2), before CPU (final).
            assert_eq!(labels, vec!["DirectML(0)", "WebGPU", "CPU"]);
        }
        #[cfg(not(feature = "vision-gpu-webgpu"))]
        {
            let _ = profile_amd_rdna4_no_extras();
        }
    }

    #[test]
    fn webgpu_skipped_when_gpu_vram_zero() {
        #[cfg(feature = "vision-gpu-webgpu")]
        {
            let mut p = profile_amd_rdna4_no_extras();
            p.gpu_vram_mb = 0;
            p.directml = false;
            let attempts = build_cascade(&p);
            // WebGPU must not appear when no GPU adapter is available.
            assert!(!attempts.iter().any(|a| matches!(a.kind, SelectedEp::WebGPU { .. })));
            // Only CPU remains as a fallback.
            assert_eq!(attempts.len(), 1);
            assert_eq!(attempts[0].kind.as_label(), "CPU");
        }
        #[cfg(not(feature = "vision-gpu-webgpu"))]
        {
            let _ = profile_amd_rdna4_no_extras();
        }
    }
}
