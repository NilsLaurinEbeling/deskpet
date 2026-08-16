//! Windows-only window plumbing.
//!
//! Two things the Tauri config cannot express:
//!
//! * `WS_EX_TOOLWINDOW` keeps the overlay out of Alt-Tab and the taskbar,
//! * `WS_EX_NOACTIVATE` stops a click on the pet from stealing focus from
//!   whatever the user is actually working in.

use std::ffi::c_void;

use tauri::{AppHandle, PhysicalPosition, WebviewWindow};
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_EX_APPWINDOW,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use crate::error::{AppError, AppResult};

pub fn apply_overlay_style(window: &WebviewWindow) -> AppResult<()> {
    // Go through the raw pointer instead of Tauri's `HWND` so a version skew
    // between our `windows` crate and Tauri's cannot break the build.
    let raw = window.hwnd()?;
    let hwnd = HWND(raw.0 as *mut c_void);

    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let wanted =
            (current | WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) & !WS_EX_APPWINDOW.0;
        if wanted != current {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted as isize);
            // Styles only take effect once the frame is recalculated.
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            )
            .map_err(|err| AppError::Platform(format!("SetWindowPos: {err}")))?;
        }
    }

    Ok(())
}

/// `GetCursorPos` returns physical pixels (the process is per-monitor DPI
/// aware) and, unlike the Tauri API, does not hop to the event loop — which
/// matters at 30 polls per second.
pub fn cursor_position(_app: &AppHandle) -> Option<PhysicalPosition<f64>> {
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point).ok()? };
    Some(PhysicalPosition::new(f64::from(point.x), f64::from(point.y)))
}
