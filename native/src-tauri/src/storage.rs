use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;
#[derive(Default, Deserialize, Serialize)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
}
pub fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let args: Vec<String> = std::env::args().collect();
    // Explicit fixture-only seam for installed-artifact QA. Never follows environment overrides.
    let path = if let Some(i) = args.iter().position(|arg| arg == "--qa-app-data") {
        let path = PathBuf::from(args.get(i + 1).ok_or("Λείπει φάκελος δοκιμής")?);
        if !path.is_absolute() || !path.join(".cratemind-qa-fixture").is_file() {
            return Err("Ο φάκελος δοκιμής απαιτεί .cratemind-qa-fixture".into());
        }
        path
    } else {
        app.path().app_data_dir().map_err(|e| e.to_string())?
    };
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
pub fn load_geometry(root: &Path) -> Option<Geometry> {
    let value: Geometry =
        serde_json::from_slice(&std::fs::read(root.join("window.json")).ok()?).ok()?;
    (value.width >= 640 && value.width <= 16384 && value.height >= 480 && value.height <= 16384)
        .then_some(value)
}
pub fn save_geometry(root: &Path, window: &tauri::WebviewWindow) {
    if let (Ok(size), Ok(position), Ok(maximized)) = (
        window.inner_size(),
        window.outer_position(),
        window.is_maximized(),
    ) {
        let value = Geometry {
            width: size.width,
            height: size.height,
            x: position.x,
            y: position.y,
            maximized,
        };
        if let Ok(bytes) = serde_json::to_vec(&value) {
            let temporary = root.join("window.json.tmp");
            if std::fs::write(&temporary, bytes).is_ok() {
                let _ = std::fs::rename(temporary, root.join("window.json"));
            }
        }
    }
}
