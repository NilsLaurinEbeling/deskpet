//! Used while developing on Linux/macOS. The overlay works there in principle
//! (transparency, always-on-top, click-through), it just misses the Windows
//! window-style tweaks. macOS gets its own treatment in a later phase.

use tauri::{AppHandle, PhysicalPosition, WebviewWindow};

use crate::error::AppResult;

pub fn apply_overlay_style(_window: &WebviewWindow) -> AppResult<()> {
    Ok(())
}

pub fn cursor_position(app: &AppHandle) -> Option<PhysicalPosition<f64>> {
    app.cursor_position().ok()
}
