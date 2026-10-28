fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["read_fixture", "save_fixture", "hide_to_tray"]),
    ))
    .expect("failed to build the prototype application manifest");
}
