use windows::{
    Win32::{
        Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE},
        System::Threading::CreateMutexW,
        UI::WindowsAndMessaging::{
            FindWindowW, IsIconic, SW_RESTORE, SetForegroundWindow, ShowWindow,
        },
    },
    core::{PCWSTR, w},
};
pub struct SingleInstance(HANDLE);
impl SingleInstance {
    /// None means another Rust instance was focused; do not open a second DB writer.
    pub fn acquire() -> Result<Option<Self>, String> {
        unsafe {
            let handle = CreateMutexW(None, false, w!("Local\\BoardCutOptimizerRustNative"))
                .map_err(|e| e.to_string())?;
            if GetLastError() == ERROR_ALREADY_EXISTS {
                if let Ok(window) = FindWindowW(PCWSTR::null(), w!("板优排 · Rust 原生版")) {
                    if IsIconic(window).as_bool() {
                        let _ = ShowWindow(window, SW_RESTORE);
                    }
                    let _ = SetForegroundWindow(window);
                }
                let _ = CloseHandle(handle);
                Ok(None)
            } else {
                Ok(Some(Self(handle)))
            }
        }
    }
}
impl Drop for SingleInstance {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
