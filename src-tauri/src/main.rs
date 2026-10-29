#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod shell;
mod state;
mod tray;

use maestro_core::settings::ThemeMode;
use state::AppState;
use tauri::{Manager, WebviewWindow, WindowEvent};

fn apply_theme(window: &WebviewWindow, mode: ThemeMode) {
    let theme = match mode {
        ThemeMode::System => None,
        ThemeMode::Light => Some(tauri::Theme::Light),
        ThemeMode::Dark => Some(tauri::Theme::Dark),
    };
    if let Err(error) = window.set_theme(theme) {
        eprintln!("Apply window theme: {error}");
    }
}

fn main() {
    let result = tauri::Builder::default()
        // The single-instance plugin must be registered before any other plugin.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }))
        .setup(|app| {
            let data_root =
                AppState::resolve_data_root(app.handle()).map_err(std::io::Error::other)?;
            let state = AppState::new(data_root).map_err(std::io::Error::other)?;
            let theme = state.lock_inner().settings.theme;
            app.manage(state);
            if let Some(window) = app.get_webview_window("main") {
                apply_theme(&window, theme);
            }
            tray::create(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<AppState>();
                let close_to_tray = state.lock_inner().settings.close_to_tray;
                if close_to_tray {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("Hide window: {error}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_tools,
            commands::read_file,
            commands::write_file,
            commands::file_stat,
            commands::reveal_path,
            commands::open_file,
            commands::open_external,
            commands::get_settings,
            commands::set_hidden,
            commands::set_theme,
            commands::set_close_to_tray,
            commands::set_soft_wrap,
            commands::add_custom,
            commands::remove_custom,
            commands::add_workspace,
            commands::remove_workspace,
            commands::set_history_limit,
            commands::search_files,
            commands::set_snapshot_meta,
            commands::get_schema,
            commands::check_config,
            commands::save_draft,
            commands::list_drafts,
            commands::delete_draft,
            commands::push_recent,
            commands::list_backups,
            commands::read_backup,
            commands::delete_backup,
            commands::clear_backups,
            commands::watch_file,
            commands::watch_folder,
            commands::list_folder,
            commands::create_file_in,
            commands::create_folder_in,
            commands::rename_file,
            commands::rename_folder,
            commands::delete_file,
            commands::delete_folder,
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("Start Maestro: {error}");
        std::process::exit(1);
    }
}
