fn main() {
    // Emit napi-build compatible env tracking
    println!("cargo:rerun-if-env-changed=DEBUG_GENERATED_CODE");
    println!("cargo:rerun-if-env-changed=TYPE_DEF_TMP_PATH");
    println!("cargo:rerun-if-env-changed=CARGO_CFG_NAPI_RS_CLI_VERSION");
    println!("cargo::rerun-if-env-changed=NAPI_DEBUG_GENERATED_CODE");
    println!("cargo::rerun-if-env-changed=NAPI_TYPE_DEF_TMP_FOLDER");
    println!("cargo::rerun-if-env-changed=NAPI_FORCE_BUILD_DESKTOP_TOUCH_ENGINE");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();

    if target_os == "windows" && target_env == "gnu" {
        // For GNU target on Windows: link against libnode.a in the project root.
        // napi_build::setup_gnu() expects libnode.dll to exist, but standard
        // Node.js installs on Windows only ship node.exe. We generated libnode.a
        // from node.exe exports via dlltool, so link directly.
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        println!("cargo:rustc-link-search=native={manifest_dir}");
        println!("cargo:rustc-link-lib=node");
    } else if target_os == "windows" {
        // MSVC target: link against node.lib in the project root.
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        println!("cargo:rustc-link-search=native={manifest_dir}");
        println!("cargo:rustc-link-lib=node");
    }
}
