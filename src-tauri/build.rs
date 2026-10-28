const COMMANDS: &[&str] = &[
    "list_tools",
    "read_file",
    "write_file",
    "file_stat",
    "reveal_path",
    "open_file",
    "open_external",
    "get_settings",
    "set_hidden",
    "set_theme",
    "set_close_to_tray",
    "set_soft_wrap",
    "add_custom",
    "remove_custom",
    "push_recent",
    "list_backups",
    "read_backup",
    "delete_backup",
    "clear_backups",
    "watch_file",
    "watch_folder",
    "list_folder",
    "create_file_in",
    "create_folder_in",
    "rename_file",
    "rename_folder",
    "delete_file",
    "delete_folder",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build the desktop application manifest");
}
