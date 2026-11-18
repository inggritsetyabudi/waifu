fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/recognition.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("vtuber_recognition");
        for framework in ["Foundation", "AVFoundation", "Speech"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rerun-if-changed=native/recognition.m");
    }
    tauri_build::build()
}
