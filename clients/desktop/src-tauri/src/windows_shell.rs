//! File Explorer integration and power management (Windows only).
//!
//! - "Upload to Loom" on files and folders: per-user registry verbs under
//!   HKCU\Software\Classes (no admin needed). Windows 11 lists them under
//!   "Show more options". Each selected item starts `Loom.exe --upload <path>`;
//!   the running app gathers them into one upload (single-instance plugin).
//! - "Send to › Loom": a shortcut in the user's SendTo folder; Windows passes
//!   every selected item at once.
//! - Keep the PC awake while transferring (SetThreadExecutionState, from one
//!   long-lived thread, since the request belongs to the calling thread).

#[cfg(windows)]
mod imp {
    use std::path::PathBuf;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const VERB: &str = "LoomUpload";
    const CLASSES: [&str; 3] = [r"Software\Classes\*\shell", r"Software\Classes\Directory\shell", r"Software\Classes\Directory\Background\shell"];

    fn exe() -> String {
        std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
    }

    pub fn set_explorer_menu(on: bool) -> std::io::Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        for class in CLASSES {
            let path = format!(r"{class}\{VERB}");
            if !on {
                let _ = hkcu.delete_subkey_all(&path);
                continue;
            }
            let (key, _) = hkcu.create_subkey(&path)?;
            let background = class.contains("Background");
            key.set_value("", &if background { "Upload this folder to Loom" } else { "Upload to Loom" })?;
            key.set_value("Icon", &format!("\"{}\",0", exe()))?;
            key.set_value("MultiSelectModel", &"Player")?;
            let (cmd, _) = key.create_subkey("command")?;
            let arg = if background { "%V" } else { "%1" };
            cmd.set_value("", &format!("\"{}\" --upload \"{arg}\"", exe()))?;
        }
        Ok(())
    }

    fn send_to_link() -> Option<PathBuf> {
        dirs::data_dir().map(|d| d.join(r"Microsoft\Windows\SendTo\Loom.lnk"))
    }

    pub fn set_send_to(on: bool) -> std::io::Result<()> {
        let Some(link) = send_to_link() else { return Ok(()) };
        if !on {
            let _ = std::fs::remove_file(&link);
            return Ok(());
        }
        let mut sl = mslnk::ShellLink::new(exe()).map_err(|e| std::io::Error::other(e.to_string()))?;
        sl.set_arguments(Some("--upload".into()));
        sl.set_name(Some("Upload to Loom".into()));
        sl.set_icon_location(Some(exe()));
        sl.create_lnk(&link).map_err(|e| std::io::Error::other(e.to_string()))
    }

    pub fn keep_awake(on: bool) {
        use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
        unsafe {
            SetThreadExecutionState(if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS });
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn set_explorer_menu(_on: bool) -> std::io::Result<()> {
        Ok(())
    }
    pub fn set_send_to(_on: bool) -> std::io::Result<()> {
        Ok(())
    }
    pub fn keep_awake(_on: bool) {}
}

pub use imp::{set_explorer_menu, set_send_to};

/// A thread that holds (or releases) the "don't sleep" request.
pub struct Awake {
    tx: std::sync::mpsc::Sender<bool>,
}

impl Awake {
    pub fn start() -> Awake {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        std::thread::Builder::new()
            .name("keep-awake".into())
            .spawn(move || {
                let mut current = false;
                while let Ok(want) = rx.recv() {
                    if want != current {
                        imp::keep_awake(want);
                        current = want;
                    }
                }
                imp::keep_awake(false);
            })
            .expect("thread");
        Awake { tx }
    }

    pub fn set(&self, on: bool) {
        let _ = self.tx.send(on);
    }
}
