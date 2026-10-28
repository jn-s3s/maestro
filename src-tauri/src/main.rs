#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod document;

use document::{Document, Fixture};
use std::sync::Mutex;
use tauri::{
    Manager, State,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

type FixtureState = Mutex<Fixture>;

#[tauri::command]
fn read_fixture(state: State<'_, FixtureState>) -> Result<Document, String> {
    state.lock().map_err(|_| "Fixture lock unavailable")?.read()
}

#[tauri::command]
fn save_fixture(
    state: State<'_, FixtureState>,
    content: String,
    expected_revision: String,
) -> Result<Document, String> {
    state
        .lock()
        .map_err(|_| "Fixture lock unavailable")?
        .save(&content, &expected_revision)
}

#[tauri::command]
fn hide_to_tray(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .hide()
        .map_err(|e| format!("Hide prototype window: {e}"))
}

fn show_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

fn main() {
    let result = tauri::Builder::default()
        .setup(|app| {
            app.manage(Mutex::new(Fixture::new()?));
            let show =
                MenuItem::with_id(app, "show", "Open Maestro Prototype", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit prototype", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../../resources/tray.png"
                ))?)
                .tooltip("Maestro Prototype - synthetic data only")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Err(error) = show_window(app) {
                            eprintln!("Show prototype window: {error}");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
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
                        if let Err(error) = show_window(tray.app_handle()) {
                            eprintln!("Show prototype window: {error}");
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("Hide prototype window: {error}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_fixture,
            save_fixture,
            hide_to_tray
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        eprintln!("Start Maestro prototype: {error}");
        std::process::exit(1);
    }
}
