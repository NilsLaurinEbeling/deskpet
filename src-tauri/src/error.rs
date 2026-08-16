use serde::{Serialize, Serializer};

/// Every command returns this. It serialises to a plain string so the frontend
/// can show it verbatim — silent failures are not acceptable.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("window '{0}' does not exist")]
    UnknownWindow(String),

    #[error("no monitor available")]
    NoMonitor,

    #[error("invalid hit mask: {0}")]
    InvalidMask(String),

    // Only raised by the Windows window-style calls.
    #[cfg_attr(not(windows), allow(dead_code))]
    #[error("platform call failed: {0}")]
    Platform(String),

    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
