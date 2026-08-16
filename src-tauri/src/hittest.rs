//! Cursor hit testing against the pet's alpha mask.
//!
//! The overlay covers the whole monitor, so it has to be transparent to the
//! mouse everywhere except on the pet itself. Windows only knows "the window
//! swallows clicks" or "it doesn't", so we flip that flag from a polling
//! thread:
//!
//! 1. the frontend uploads a downsampled 1-bit alpha mask of the current frame
//!    ([`HitMask`]) whenever the sprite changes, and only the mask's origin
//!    when the pet merely moves,
//! 2. this module polls the global cursor position at ~30 Hz and tests it
//!    against that mask,
//! 3. on a hit the window becomes interactive immediately; on a miss it goes
//!    back to click-through only after [`EXIT_HYSTERESIS_TICKS`] consecutive
//!    misses, so grazing the outline does not make the flag chatter.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

use crate::error::{AppError, AppResult};
use crate::platform;

/// Polling rate of the cursor thread.
pub const POLL_HZ: u64 = 30;
pub const POLL_INTERVAL: Duration = Duration::from_millis(1000 / POLL_HZ);

/// Consecutive misses before the overlay goes back to click-through.
/// One tick would flicker on the antialiased outline.
const EXIT_HYSTERESIS_TICKS: u8 = 3;

/// Re-read window geometry roughly once per second, as a safety net for
/// monitor changes we did not get an event for.
const RESYNC_EVERY_TICKS: u64 = POLL_HZ;

/// A drag that never reports its end must not leave the overlay swallowing
/// every click forever.
const GRAB_TIMEOUT_TICKS: u32 = (POLL_HZ * 30) as u32;

/// Upper bound on an uploaded mask (1 Mbit ≈ 128 kB) — a sane sprite needs a
/// fraction of that, and it keeps a malformed payload from allocating wildly.
const MAX_MASK_BITS: u64 = 1 << 20;

/// A downsampled alpha mask of the pet, in window-local **logical** pixels.
///
/// `bits` is row-major, one bit per cell, LSB first; a set bit means "this cell
/// contains at least one opaque pixel". The cell size is implied by
/// `width / cols` and `height / rows` so the two can never disagree.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HitMask {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub cols: u32,
    pub rows: u32,
    pub bits: Vec<u8>,
}

impl HitMask {
    pub fn validate(&self) -> AppResult<()> {
        if self.cols == 0 || self.rows == 0 {
            return Err(AppError::InvalidMask("zero-sized grid".into()));
        }
        let cells = u64::from(self.cols) * u64::from(self.rows);
        if cells > MAX_MASK_BITS {
            return Err(AppError::InvalidMask(format!("{cells} cells is too large")));
        }
        let expected = ((cells + 7) / 8) as usize;
        if self.bits.len() != expected {
            return Err(AppError::InvalidMask(format!(
                "{} bytes for {}x{} cells, expected {expected}",
                self.bits.len(),
                self.cols,
                self.rows
            )));
        }
        if !self.width.is_finite() || !self.height.is_finite() || self.width <= 0.0 || self.height <= 0.0 {
            return Err(AppError::InvalidMask("non-positive bounds".into()));
        }
        Ok(())
    }

    /// `lx`/`ly` are logical pixels relative to the window's client area.
    pub fn contains(&self, lx: f64, ly: f64) -> bool {
        let u = (lx - self.x) / self.width;
        let v = (ly - self.y) / self.height;
        if !(0.0..1.0).contains(&u) || !(0.0..1.0).contains(&v) {
            return false;
        }
        let col = (u * f64::from(self.cols)) as u32;
        let row = (v * f64::from(self.rows)) as u32;
        let index = (row * self.cols + col) as usize;
        self.bits
            .get(index >> 3)
            .is_some_and(|byte| byte & (1 << (index & 7)) != 0)
    }
}

/// What the frontend gets on every poll tick, so the pet can react to the
/// cursor even while the window is click-through and receives no DOM events.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorEvent {
    /// Logical, window-local.
    pub x: f64,
    pub y: f64,
    /// Cursor is inside this overlay's monitor.
    pub inside: bool,
    /// Cursor is on an opaque pixel of the pet.
    pub over_pet: bool,
    /// The window is currently accepting mouse input.
    pub interactive: bool,
}

pub const CURSOR_EVENT: &str = "deskpet://cursor";

#[derive(Debug)]
struct Overlay {
    mask: Option<HitMask>,
    /// Mirrors the last `set_ignore_cursor_events(false)` we applied.
    interactive: bool,
    misses: u8,
    /// Held while the pet is being dragged: stay interactive no matter what
    /// the mask says, so a fast drag cannot outrun it.
    grabbed: bool,
    grab_ticks: u32,
    /// A hidden pet is not clickable, whatever the last mask said.
    visible: bool,
    /// Client-area origin and size in physical pixels.
    origin: (i32, i32),
    size: (u32, u32),
    scale: f64,
    last_event: Option<CursorEvent>,
}

impl Overlay {
    fn new() -> Self {
        Self {
            mask: None,
            interactive: false,
            misses: 0,
            grabbed: false,
            grab_ticks: 0,
            visible: true,
            origin: (0, 0),
            size: (0, 0),
            scale: 1.0,
            last_event: None,
        }
    }
}

pub struct HitTest {
    overlays: Mutex<HashMap<String, Overlay>>,
    /// Master switch behind `Settings.clickThrough`. When off the overlay stays
    /// transparent to the mouse no matter what the mask says.
    enabled: AtomicBool,
}

impl Default for HitTest {
    fn default() -> Self {
        Self {
            overlays: Mutex::new(HashMap::new()),
            enabled: AtomicBool::new(true),
        }
    }
}

impl HitTest {
    /// A poisoned mutex must not take the app down — the worst case is one
    /// stale tick.
    fn overlays(&self) -> MutexGuard<'_, HashMap<String, Overlay>> {
        self.overlays.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn register(&self, label: &str) {
        self.overlays().entry(label.to_owned()).or_insert_with(Overlay::new);
    }

    pub fn unregister(&self, label: &str) {
        self.overlays().remove(label);
    }

    pub fn labels(&self) -> Vec<String> {
        self.overlays().keys().cloned().collect()
    }

    pub fn update_geometry(&self, label: &str, origin: (i32, i32), size: (u32, u32), scale: f64) {
        let mut overlays = self.overlays();
        let overlay = overlays.entry(label.to_owned()).or_insert_with(Overlay::new);
        overlay.origin = origin;
        overlay.size = size;
        overlay.scale = if scale > 0.0 { scale } else { 1.0 };
    }

    pub fn set_mask(&self, label: &str, mask: HitMask) -> AppResult<()> {
        mask.validate()?;
        let mut overlays = self.overlays();
        let overlay = overlays
            .get_mut(label)
            .ok_or_else(|| AppError::UnknownWindow(label.to_owned()))?;
        overlay.mask = Some(mask);
        Ok(())
    }

    /// Cheap path for a pet that only moved or breathed: keep the bitmap, move
    /// and stretch its rectangle. The lookup normalises by that rectangle, so
    /// the bits stay valid.
    pub fn set_mask_bounds(&self, label: &str, x: f64, y: f64, width: f64, height: f64) -> AppResult<()> {
        if !(x.is_finite() && y.is_finite()) || !(width > 0.0) || !(height > 0.0) {
            return Err(AppError::InvalidMask(format!(
                "bounds {x}/{y} {width}x{height}"
            )));
        }
        let mut overlays = self.overlays();
        let overlay = overlays
            .get_mut(label)
            .ok_or_else(|| AppError::UnknownWindow(label.to_owned()))?;
        if let Some(mask) = overlay.mask.as_mut() {
            mask.x = x;
            mask.y = y;
            mask.width = width;
            mask.height = height;
        }
        Ok(())
    }

    pub fn set_visible(&self, label: &str, visible: bool) {
        if let Some(overlay) = self.overlays().get_mut(label) {
            overlay.visible = visible;
        }
    }

    pub fn set_grabbed(&self, label: &str, grabbed: bool) -> AppResult<()> {
        let mut overlays = self.overlays();
        let overlay = overlays
            .get_mut(label)
            .ok_or_else(|| AppError::UnknownWindow(label.to_owned()))?;
        overlay.grabbed = grabbed;
        overlay.grab_ticks = 0;
        Ok(())
    }

    pub fn clear_mask(&self, label: &str) {
        if let Some(overlay) = self.overlays().get_mut(label) {
            overlay.mask = None;
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
}

/// Starts the cursor poller. Runs for the lifetime of the app.
pub fn spawn_poller(app: AppHandle) {
    thread::spawn(move || {
        let mut tick: u64 = 0;
        loop {
            thread::sleep(POLL_INTERVAL);
            tick = tick.wrapping_add(1);

            if tick % RESYNC_EVERY_TICKS == 0 {
                crate::overlay::resync(&app);
            }

            let Some(cursor) = platform::cursor_position(&app) else {
                continue;
            };
            tick_once(&app, cursor);
        }
    });
}

fn tick_once(app: &AppHandle, cursor: PhysicalPosition<f64>) {
    let state = app.state::<HitTest>();
    let enabled = state.is_enabled();

    // Decide under the lock, act outside of it: `set_ignore_cursor_events`
    // hops to the main thread and must never be called while holding it.
    let mut toggles: Vec<(String, bool)> = Vec::new();
    let mut events: Vec<(String, CursorEvent)> = Vec::new();

    {
        let mut overlays = state.overlays();
        for (label, overlay) in overlays.iter_mut() {
            let scale = overlay.scale;
            let local_x = (cursor.x - f64::from(overlay.origin.0)) / scale;
            let local_y = (cursor.y - f64::from(overlay.origin.1)) / scale;
            let inside = local_x >= 0.0
                && local_y >= 0.0
                && local_x < f64::from(overlay.size.0) / scale
                && local_y < f64::from(overlay.size.1) / scale;

            if overlay.grabbed {
                overlay.grab_ticks = overlay.grab_ticks.saturating_add(1);
                if overlay.grab_ticks > GRAB_TIMEOUT_TICKS {
                    eprintln!("[deskpet] releasing stale pointer grab on {label}");
                    overlay.grabbed = false;
                }
            }

            let over_pet = inside
                && overlay
                    .mask
                    .as_ref()
                    .is_some_and(|mask| mask.contains(local_x, local_y));
            let hit = enabled && overlay.visible && (overlay.grabbed || over_pet);

            if hit {
                overlay.misses = 0;
                if !overlay.interactive {
                    overlay.interactive = true;
                    toggles.push((label.clone(), false));
                }
            } else if overlay.interactive {
                overlay.misses = overlay.misses.saturating_add(1);
                if overlay.misses >= EXIT_HYSTERESIS_TICKS {
                    overlay.interactive = false;
                    overlay.misses = 0;
                    toggles.push((label.clone(), true));
                }
            }

            let event = CursorEvent {
                x: local_x,
                y: local_y,
                inside,
                over_pet,
                interactive: overlay.interactive,
            };
            if changed(overlay.last_event, event) {
                overlay.last_event = Some(event);
                events.push((label.clone(), event));
            }
        }
    }

    for (label, ignore) in toggles {
        let Some(window) = app.get_webview_window(&label) else {
            continue;
        };
        if let Err(err) = window.set_ignore_cursor_events(ignore) {
            eprintln!("[deskpet] set_ignore_cursor_events({label}, {ignore}) failed: {err}");
        }
    }

    for (label, event) in events {
        if let Err(err) = app.emit_to(&label, CURSOR_EVENT, event) {
            eprintln!("[deskpet] emitting cursor event to {label} failed: {err}");
        }
    }
}

/// Skip the IPC round trip for sub-pixel jitter.
fn changed(previous: Option<CursorEvent>, next: CursorEvent) -> bool {
    match previous {
        None => true,
        Some(prev) => {
            prev.inside != next.inside
                || prev.over_pet != next.over_pet
                || prev.interactive != next.interactive
                || (prev.x - next.x).abs() >= 1.0
                || (prev.y - next.y).abs() >= 1.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 4x4 grid over a 40x40 box at (100, 100); only the second row is set.
    fn mask() -> HitMask {
        HitMask {
            x: 100.0,
            y: 100.0,
            width: 40.0,
            height: 40.0,
            cols: 4,
            rows: 4,
            bits: vec![0b1111_0000, 0b0000_0000],
        }
    }

    #[test]
    fn validates_bit_length() {
        assert!(mask().validate().is_ok());
        let mut bad = mask();
        bad.bits.pop();
        assert!(bad.validate().is_err());
    }

    #[test]
    fn hits_only_set_cells() {
        let mask = mask();
        assert!(!mask.contains(105.0, 105.0), "row 0 is clear");
        assert!(mask.contains(105.0, 115.0), "row 1 is set");
        assert!(mask.contains(135.0, 115.0), "last column of row 1");
        assert!(!mask.contains(105.0, 125.0), "row 2 is clear");
    }

    /// The mask the real frontend builds for the placeholder sprite, captured
    /// by `node scripts/gen-hitmask-fixture.mjs`. This is the contract between
    /// the two halves of the hit test — bit order, row order and coordinate
    /// space — checked against data the frontend actually produced rather than
    /// against a restatement of the same assumptions.
    fn placeholder() -> HitMask {
        serde_json::from_str(include_str!("../tests/fixtures/placeholder-mask.json"))
            .expect("fixture is valid JSON for a HitMask")
    }

    /// 180x180 logical px over a 45x45 grid: one cell is 4 px.
    #[test]
    fn agrees_with_the_frontend_mask() {
        let mask = placeholder();
        mask.validate().expect("fixture passes validation");

        assert!(mask.contains(90.0, 42.0), "the head is opaque");
        assert!(mask.contains(90.0, 122.0), "the body is opaque");
        assert!(mask.contains(166.0, 122.0), "the tail is opaque");

        assert!(!mask.contains(90.0, 14.0), "the notch between the ears is a hole");
        assert!(!mask.contains(150.0, 122.0), "the gap under the tail is a hole");
        assert!(!mask.contains(10.0, 10.0), "the top-left corner is empty");
    }

    /// What `set_hit_mask_bounds` does on nearly every frame: the same bitmap
    /// moved and stretched has to keep hitting the same features.
    #[test]
    fn survives_being_moved_and_scaled() {
        let mut mask = placeholder();
        mask.x = 400.0;
        mask.y = 300.0;
        mask.width = 360.0;
        mask.height = 360.0;

        // Same relative points, twice the size, shifted by (400, 300).
        assert!(mask.contains(400.0 + 180.0, 300.0 + 84.0), "the head follows");
        assert!(!mask.contains(400.0 + 180.0, 300.0 + 28.0), "the notch follows");
        assert!(!mask.contains(400.0 + 300.0, 300.0 + 244.0), "the tail gap follows");
        assert!(!mask.contains(399.0, 300.0), "just left of the box is a miss");
    }

    #[test]
    fn misses_outside_the_box() {
        let mask = mask();
        assert!(!mask.contains(99.0, 115.0));
        assert!(!mask.contains(140.0, 115.0));
        assert!(!mask.contains(105.0, 99.0));
        assert!(!mask.contains(105.0, 140.0));
    }
}
