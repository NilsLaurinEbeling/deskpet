//! Commands the overlay frontend calls. Everything returns `Result` so the
//! frontend can surface failures instead of silently drifting out of sync.

use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::error::{AppError, AppResult};
use crate::hittest::{HitMask, HitTest};
use crate::overlay::{self, OverlayGeometry};

/// Called once the PixiJS stage is up. Returns the window's size, DPI scale and
/// ground line.
#[tauri::command]
pub fn overlay_geometry(app: AppHandle, window: WebviewWindow) -> AppResult<OverlayGeometry> {
    overlay::refresh_geometry(&app, &window)?;
    overlay::geometry(&app, &window)
}

/// Uploads a new alpha mask (sprite or size changed).
#[tauri::command]
pub fn set_hit_mask(window: WebviewWindow, state: State<'_, HitTest>, mask: HitMask) -> AppResult<()> {
    state.set_mask(window.label(), mask)
}

/// The pet only moved or breathed: keep the bitmap, update its rectangle. This
/// is the call that happens on nearly every frame, so it stays as small as
/// possible.
#[tauri::command]
pub fn set_hit_mask_bounds(
    window: WebviewWindow,
    state: State<'_, HitTest>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> AppResult<()> {
    state.set_mask_bounds(window.label(), x, y, width, height)
}

/// Held for the duration of a drag.
#[tauri::command]
pub fn set_hit_grab(window: WebviewWindow, state: State<'_, HitTest>, grabbed: bool) -> AppResult<()> {
    state.set_grabbed(window.label(), grabbed)
}

/// The pet is hidden — nothing on this overlay is clickable.
#[tauri::command]
pub fn clear_hit_mask(window: WebviewWindow, state: State<'_, HitTest>) {
    state.clear_mask(window.label());
}

/// Maps to `Settings.clickThrough`. When disabled the overlay never captures
/// the mouse, whatever the mask says.
#[tauri::command]
pub fn set_hit_testing_enabled(state: State<'_, HitTest>, enabled: bool) {
    state.set_enabled(enabled);
}

#[tauri::command]
pub fn hit_testing_enabled(state: State<'_, HitTest>) -> bool {
    state.is_enabled()
}

/// Escape hatch for the settings window ("Pet verstecken") and for the
/// fullscreen detection in a later phase.
#[tauri::command]
pub fn set_overlay_visible(
    app: AppHandle,
    state: State<'_, HitTest>,
    label: String,
    visible: bool,
) -> AppResult<()> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| AppError::UnknownWindow(label.clone()))?;
    if visible {
        window.show()?;
    } else {
        window.hide()?;
    }
    state.set_visible(&label, visible);
    Ok(())
}
