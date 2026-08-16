mod commands;
mod error;
mod hittest;
mod overlay;
mod platform;

use tauri::{Manager, WindowEvent};

use hittest::HitTest;

pub fn run() {
    tauri::Builder::default()
        .manage(HitTest::default())
        .invoke_handler(tauri::generate_handler![
            commands::window::overlay_geometry,
            commands::window::set_hit_mask,
            commands::window::set_hit_mask_bounds,
            commands::window::set_hit_grab,
            commands::window::clear_hit_mask,
            commands::window::set_hit_testing_enabled,
            commands::window::hit_testing_enabled,
            commands::window::set_overlay_visible,
        ])
        .setup(|app| {
            overlay::init(app.handle())?;
            hittest::spawn_poller(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Any of these invalidates the cached client rect the cursor poller
            // tests against.
            WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                let app = window.app_handle().clone();
                let label = window.label().to_owned();
                if let Some(webview) = app.get_webview_window(&label) {
                    if let Err(err) = overlay::refresh_geometry(&app, &webview) {
                        eprintln!("[deskpet] geometry refresh for {label} failed: {err}");
                    }
                }
            }
            WindowEvent::Destroyed => {
                window.app_handle().state::<HitTest>().unregister(window.label());
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("deskpet failed to start");
}
