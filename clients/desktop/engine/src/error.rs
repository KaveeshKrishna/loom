//! Errors, sorted by what the engine should do about them.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    /// Couldn't reach the server, or it answered 5xx / 429 / timed out:
    /// wait and try again, forever.
    #[error("{0}")]
    Transient(String),
    /// The device token is gone (removed in Devices, password reset).
    #[error("This device was signed out of Loom")]
    SignedOut,
    /// The server's drive is full.
    #[error("Loom's drive is full")]
    DiskFull,
    /// The upload session expired or was cancelled on the server: start the file again.
    #[error("The upload expired on the server")]
    SessionGone,
    /// The local file changed while it was being sent: start again with the new version.
    #[error("The file changed while it was being uploaded")]
    SourceChanged,
    /// Won't work by retrying (no permission, bad name, file deleted…).
    #[error("{0}")]
    Permanent(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Db(#[from] rusqlite::Error),
}

impl Error {
    pub fn is_transient(&self) -> bool {
        matches!(self, Error::Transient(_))
    }
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        // Connection problems, timeouts and broken bodies are all worth retrying.
        Error::Transient(network_message(&e))
    }
}

fn network_message(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "The connection timed out".into()
    } else if e.is_connect() {
        "Can't reach Loom".into()
    } else {
        format!("Network error: {e}")
    }
}
