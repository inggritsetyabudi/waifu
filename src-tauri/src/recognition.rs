#[cfg(target_os = "macos")]
use std::{
    ffi::{CStr, CString, c_char},
    sync::OnceLock,
};
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
static APP: OnceLock<AppHandle> = OnceLock::new();
#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn vt_speech_start(
        id: *const c_char,
        locale: *const c_char,
        callback: extern "C" fn(*const c_char),
    );
    fn vt_speech_stop();
}
#[cfg(target_os = "macos")]
extern "C" fn speech_event(json: *const c_char) {
    if json.is_null() {
        return;
    }
    // Native callback owns the bytes for the duration of this call.
    let text = unsafe { CStr::from_ptr(json) }.to_string_lossy();
    if let (Some(app), Ok(value)) = (APP.get(), serde_json::from_str::<serde_json::Value>(&text)) {
        let _ = app.emit("speech://event", value);
    }
}
#[tauri::command]
pub fn cmd_start_listening(app: AppHandle, id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = APP.set(app);
        let id = CString::new(id).map_err(|_| "Invalid recognition id")?;
        let locale = CString::new("id-ID").unwrap();
        unsafe {
            vt_speech_start(id.as_ptr(), locale.as_ptr(), speech_event);
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, id);
        Err("Native speech recognition currently supports macOS".into())
    }
}
#[tauri::command]
pub fn cmd_stop_listening() {
    #[cfg(target_os = "macos")]
    unsafe {
        vt_speech_stop();
    }
}
