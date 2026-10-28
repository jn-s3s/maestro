//! Tray icon, its recent-file menu and window restoration.

use maestro_core::paths::{lexical_normalize, path_key};
use std::{collections::HashSet, path::Path};

use tauri::{
    AppHandle, Emitter, Manager,
    image::Image,
    menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::state::AppState;

pub const TRAY_ID: &str = "main";

/// Creates the tray icon with the Open, Recent files and Quit menu.
///
/// @param app - The running application handle.
/// @throws When the icon, menu or tray cannot be created.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = match build_menu(app) {
        Ok(menu) => menu,
        Err(error) => {
            eprintln!("Build tray menu: {error}");
            Menu::new(app)?
        }
    };
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(include_bytes!(
            "../../resources/tray.png"
        ))?)
        .tooltip("Maestro")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "open" => show_main(app),
                "quit" => app.exit(0),
                _ => {
                    let Some(path) = id.strip_prefix("recent:") else {
                        return;
                    };
                    show_main(app);
                    if let Err(error) = app.emit("fs-open", path.to_owned()) {
                        eprintln!("Emit fs-open: {error}");
                    }
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuilds the tray menu after the recent-file list changes.
///
/// @param app - The running application handle.
/// @throws When the menu cannot be built or assigned.
pub fn update(app: &AppHandle) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let menu = build_menu(app)?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

/// Restores, unminimizes and focuses the main window.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let recents = valid_recents(app);
    let open = MenuItem::with_id(app, "open", "&Open Maestro", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let separator = PredefinedMenuItem::separator(app).map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "&Quit", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let mut recent_items = Vec::new();
    for path in &recents {
        let label = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let id = format!("recent:{}", path.to_string_lossy());
        recent_items.push(
            MenuItem::with_id(app, id, label, true, None::<&str>)
                .map_err(|error| error.to_string())?,
        );
    }
    let submenu = if recent_items.is_empty() {
        None
    } else {
        let items: Vec<&dyn IsMenuItem<tauri::Wry>> = recent_items
            .iter()
            .map(|item| item as &dyn IsMenuItem<tauri::Wry>)
            .collect();
        Some(
            Submenu::with_items(app, "Recent files", true, &items)
                .map_err(|error| error.to_string())?,
        )
    };
    let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&open];
    if let Some(submenu) = &submenu {
        items.push(submenu);
    }
    items.push(&separator);
    items.push(&quit);
    Menu::with_items(app, &items).map_err(|error| error.to_string())
}

fn valid_recents(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let state = app.state::<AppState>();
    let mut inner = state.lock_inner();
    let mut valid = Vec::new();
    let mut seen = HashSet::new();
    for recent in inner.settings.recent_files.iter().take(5) {
        let Ok(canonical) = inner.files.registry().resolve_file(Path::new(recent)) else {
            continue;
        };
        if seen.insert(path_key(&canonical)) {
            valid.push(lexical_normalize(Path::new(recent)));
        }
    }
    if valid.len() != inner.settings.recent_files.len() {
        let mut settings = inner.settings.clone();
        settings.recent_files = valid
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        if let Err(error) = state.save_settings(&mut inner, settings) {
            state.log("tray-recent-persist", &error);
        }
    }
    valid
}
