fn main() {
    let resources = std::path::Path::new("resources");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        for required in [
            "backend/_internal",
            "frontend/index.html",
            "tool-inventory.json",
            "NOTICES.txt",
        ] {
            assert!(
                resources.join(required).exists(),
                "Stage complete desktop resources before a release build: missing {required}"
            );
        }
        for name in [
            "backend/cratemind-backend",
            "tools/ffmpeg",
            "tools/ffprobe",
            "tools/fpcalc",
        ] {
            let name = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
                format!("{name}.exe")
            } else {
                name.into()
            };
            assert!(
                resources.join(&name).is_file(),
                "Missing staged desktop executable {name}"
            );
        }
    } else {
        // Unit tests and source-only host development can compile before packaging.
        for name in ["backend", "tools", "frontend", "licenses"] {
            std::fs::create_dir_all(resources.join(name)).expect("create debug resource directory");
        }
    }
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        for name in ["tool-inventory.json", "NOTICES.txt"] {
            let path = resources.join(name);
            if !path.exists() {
                std::fs::write(path, "source-only debug placeholder\n")
                    .expect("create debug placeholder");
            }
        }
    }
    tauri_build::build()
}
