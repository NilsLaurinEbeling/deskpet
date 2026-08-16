//! Platform specifics. Everything outside this module stays OS-agnostic.

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub use windows::{apply_overlay_style, cursor_position};

#[cfg(not(windows))]
mod fallback;

#[cfg(not(windows))]
pub use fallback::{apply_overlay_style, cursor_position};
