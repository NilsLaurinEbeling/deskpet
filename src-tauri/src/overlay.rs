//! Creation and placement of the transparent pet windows.
//!
//! Phase 1 only lights up the primary monitor, but everything below is already
//! indexed per monitor: dropping the `take(1)` in [`init`] is all that stands
//! between here and one overlay per screen.

use serde::Serialize;
use tauri::{
    AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::error::{AppError, AppResult};
use crate::hittest::HitTest;
use crate::platform;

/// Label of the overlay declared in `tauri.conf.json`. Additional monitors get
/// `overlay-1`, `overlay-2`, … built from that same config.
pub const PRIMARY_LABEL: &str = "overlay";

pub fn label_for(index: usize) -> String {
    if index == 0 {
        PRIMARY_LABEL.to_owned()
    } else {
        format!("{PRIMARY_LABEL}-{index}")
    }
}

/// Geometry the frontend needs to lay the pet out. All lengths are logical
/// pixels relative to the window's client area — the physical/logical
/// conversion happens here so the frontend never has to think about DPI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayGeometry {
    pub label: String,
    pub scale_factor: f64,
    pub width: f64,
    pub height: f64,
    /// Bottom of the monitor's work area — the taskbar edge the pet stands on.
    pub ground_y: f64,
    pub monitor: Option<String>,
}

pub fn init(app: &AppHandle) -> AppResult<()> {
    let monitors = target_monitors(app)?;
    for (index, monitor) in monitors.iter().enumerate() {
        let window = ensure_window(app, index)?;
        place(&window, monitor)?;
        platform::apply_overlay_style(&window)?;
        app.state::<HitTest>().register(window.label());
        refresh_geometry(app, &window)?;
        window.show()?;
        // Default state: the whole screen is click-through. The poller opens it
        // up as soon as the frontend has uploaded a mask and the cursor is on
        // the pet.
        //
        // This has to come *after* `show()`: the input shape can only be
        // applied to a window the platform has actually realised (on GTK that
        // is a hard panic, and the window is created hidden).
        window.set_ignore_cursor_events(true)?;
    }
    Ok(())
}

/// Phase 1: primary monitor only.
fn target_monitors(app: &AppHandle) -> AppResult<Vec<Monitor>> {
    let primary = app.primary_monitor()?.ok_or(AppError::NoMonitor)?;
    Ok(vec![primary])
}

fn ensure_window(app: &AppHandle, index: usize) -> AppResult<WebviewWindow> {
    let label = label_for(index);
    if let Some(window) = app.get_webview_window(&label) {
        return Ok(window);
    }

    // Clone the flags from the declared overlay so there is exactly one place
    // where transparency/always-on-top/… are defined.
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == PRIMARY_LABEL)
        .cloned()
        .ok_or_else(|| AppError::UnknownWindow(PRIMARY_LABEL.to_owned()))?;
    config.label = label;

    Ok(WebviewWindowBuilder::from_config(app, &config)?.build()?)
}

/// Covers the monitor exactly. Always physical pixels: on a 150 % display
/// logical coordinates would land the window in the wrong place.
fn place(window: &WebviewWindow, monitor: &Monitor) -> AppResult<()> {
    window.set_position(PhysicalPosition::new(
        monitor.position().x,
        monitor.position().y,
    ))?;
    window.set_size(PhysicalSize::new(
        monitor.size().width,
        monitor.size().height,
    ))?;
    Ok(())
}

/// Pushes the window's current client rect into the hit-test state. Called on
/// startup, on every move/resize/DPI change and once per second as a safety
/// net.
pub fn refresh_geometry(app: &AppHandle, window: &WebviewWindow) -> AppResult<()> {
    let origin = window.inner_position()?;
    let size = window.inner_size()?;
    let scale = window.scale_factor()?;
    app.state::<HitTest>().update_geometry(
        window.label(),
        (origin.x, origin.y),
        (size.width, size.height),
        scale,
    );
    Ok(())
}

pub fn geometry(app: &AppHandle, window: &WebviewWindow) -> AppResult<OverlayGeometry> {
    let origin = window.inner_position()?;
    let size = window.inner_size()?;
    let scale = window.scale_factor()?;
    let monitor = window.current_monitor()?.or(app.primary_monitor()?);

    // Fall back to the window's own bottom edge if the work area is unknown.
    let ground_y = monitor
        .as_ref()
        .map(|monitor| {
            let area = monitor.work_area();
            f64::from(area.position.y + area.size.height as i32 - origin.y) / scale
        })
        .unwrap_or(f64::from(size.height) / scale);

    Ok(OverlayGeometry {
        label: window.label().to_owned(),
        scale_factor: scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
        ground_y: ground_y.clamp(0.0, f64::from(size.height) / scale),
        monitor: monitor.and_then(|monitor| monitor.name().cloned()),
    })
}

/// Safety net against monitors being unplugged or rearranged: if an overlay
/// no longer sits on a monitor, drag it back to the primary one.
pub fn resync(app: &AppHandle) {
    for label in app.state::<HitTest>().labels() {
        let Some(window) = app.get_webview_window(&label) else {
            app.state::<HitTest>().unregister(&label);
            continue;
        };

        if matches!(window.current_monitor(), Ok(None) | Err(_)) {
            match app.primary_monitor() {
                Ok(Some(primary)) => {
                    if let Err(err) = place(&window, &primary) {
                        eprintln!("[deskpet] could not move {label} back onto a monitor: {err}");
                    }
                }
                _ => continue,
            }
        }

        if let Err(err) = refresh_geometry(app, &window) {
            eprintln!("[deskpet] geometry resync for {label} failed: {err}");
        }
    }
}
