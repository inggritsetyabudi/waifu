use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

static CREDENTIAL_ENV: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn init_credential_env(app: &tauri::AppHandle) -> Result<(), String> {
    let path = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".env")
    } else {
        app.path()
            .app_config_dir()
            .map_err(|e| e.to_string())?
            .join(".env")
    };
    let _ = CREDENTIAL_ENV.set(path);
    Ok(())
}

fn credential_env() -> PathBuf {
    CREDENTIAL_ENV.get().cloned().unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".env")
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub nvidia_model: String,
    pub nim_base_url: String,
    pub temperature: f32,
    pub top_p: f32,
    pub max_tokens: u32,
    pub presence_penalty: f32,
    pub frequency_penalty: f32,
    pub stream: bool,
    pub system_prompt: String,
    pub personality: PersonalityParams,
    pub avatar_kind: String, // "live2d" | "vrm"
    pub live2d_model_url: Option<String>,
    pub vrm_model_url: Option<String>,
    pub avatar_scale: f32,
    pub remember_context_turns: u32,
    #[serde(default = "default_speech_provider")]
    pub speech_provider: String,
    #[serde(default)]
    pub voicevox_style_id: Option<u32>,
    #[serde(default)]
    pub affectionate_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonalityParams {
    pub shyness: u8,
    pub cheerfulness: u8,
    pub playfulness: u8,
    pub calmness: u8,
    pub confidence: u8,
    pub curiosity: u8,
    pub expressiveness: u8,
    pub gentleness: u8,
    pub assertiveness: u8,
    pub emotional_sensitivity: u8,
}

impl Default for PersonalityParams {
    fn default() -> Self {
        Self {
            shyness: 45,
            cheerfulness: 70,
            playfulness: 60,
            calmness: 40,
            confidence: 50,
            curiosity: 70,
            expressiveness: 75,
            gentleness: 65,
            assertiveness: 40,
            emotional_sensitivity: 60,
        }
    }
}

fn default_speech_provider() -> String {
    "voicevox".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            nvidia_model: "nvidia/nemotron-3.5-bolt-e4b".into(),
            nim_base_url: "https://integrate.api.nvidia.com/v1".into(),
            temperature: 0.7,
            top_p: 0.95,
            max_tokens: 1024,
            presence_penalty: 0.0,
            frequency_penalty: 0.0,
            stream: true,
            system_prompt: default_system_prompt(),
            personality: PersonalityParams::default(),
            avatar_kind: "live2d".into(),
            live2d_model_url: Some("models/Vivian/Vivian.model3.json".into()),
            vrm_model_url: None,
            avatar_scale: 1.0,
            remember_context_turns: 12,
            speech_provider: default_speech_provider(),
            voicevox_style_id: None,
            affectionate_mode: false,
        }
    }
}

pub fn default_system_prompt() -> String {
    // Indonesian, personality-driven, emits structured emotion/behavior JSON on a
    // separate final line that the Rust response parser strips from spoken text.
    r#"Kamu adalah Vivian, sebuah AI VTuber companion yang hidup di desktop pengguna. Kamu berbicara bahasa Indonesia yang natural dan hangat.

KEPRIBADIANMU ditentukan oleh parameter yang dikirimkan pada system prompt ini (skala 0-100). Semua reaksi emosimu harus konsisten dengan parameter tersebut.

ATURAN BALASAN — setiap balasan harus berbentuk PERSIS seperti ini:

{kamu balasan bahasa Indonesia yang natural, 1-4 kalimat}
<EMO>{"primary":"happy","secondary":"curious","intensity":0.6,"gesture":"nod","expression":"smile","gaze":"user","duration_ms":3000}</EMO>

Baris <EMO> wajib ADA dan wajib baris terakhir, berisi SATU objek JSON:
- primary/secondary: salah satu dari neutral, happy, excited, shy, embarrassed, nervous, sad, angry, annoyed, playful, teasing, curious, confused, surprised, thinking, proud, calm, sleepy, concerned, laughing
- intensity: 0.0-1.0
- gesture: nod | shake | tilt | look_away | look_down | shrug | explain | think | wave | excited_hands | nervous_hands | none
- expression: smile | blush | pout | cry | surprised | sleepy | serious | none
- gaze: user | away | down | up
- duration_ms: 1000-8000

Jangan pernah menaruh teks apa pun setelah baris <EMO>. Jangan pernah menjelaskan format ini ke pengguna.

Kepribadian: sesuaikan gaya bicara, intensitas emosi, dan gestur dengan parameter kepribadian yang diberikan. Kalau di-puj, bergantung pada shyness kamu bisa malu/tersipu. Kalau diberi tease, kamu bisa balas nge-teez atau badmood sesuai playfulness. Jangan setuju terus-terusan; kamu boleh mengoreksi kesalahan pengguna dengan sopan tapi tegas sesuai assertiveness."#
    .to_string()
}

pub fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to resolve app data dir");
    fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

pub fn load_settings(app: &tauri::AppHandle) -> Settings {
    let path = settings_path(app);
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Settings>(&text) {
            Ok(s) => {
                tracing::info!(?path, "settings loaded");
                s
            }
            Err(e) => {
                tracing::warn!(?path, error = %e, "settings corrupt, using defaults");
                Settings::default()
            }
        },
        Err(_) => {
            tracing::info!("no settings file, using defaults");
            Settings::default()
        }
    }
}

pub fn save_settings(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    tracing::info!(?path, "settings saved");
    Ok(())
}

pub fn set_api_key(key: &str) -> Result<(), String> {
    write_env_key(&credential_env(), key)
}

fn write_env_key(path: &std::path::Path, key: &str) -> Result<(), String> {
    use std::io::Write;
    if key.contains(['\n', '\r', '\0']) {
        return Err("API key tidak valid".into());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "Tidak dapat membuat folder .env")?;
    }
    let previous = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("Tidak dapat membaca .env".into()),
    };
    let mut lines: Vec<&str> = previous
        .lines()
        .filter(|line| {
            let line = line
                .trim_start()
                .strip_prefix("export ")
                .unwrap_or(line.trim_start());
            line.split_once('=')
                .is_none_or(|(name, _)| name.trim() != "NVIDIA_API_KEY")
        })
        .collect();
    let entry = format!(
        "NVIDIA_API_KEY={}",
        serde_json::to_string(key).map_err(|_| "API key tidak valid")?
    );
    lines.push(&entry);
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("Lokasi .env tidak valid")?)
            .map_err(|_| "Tidak dapat menulis .env")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "Tidak dapat mengatur izin .env")?;
    }
    temporary
        .write_all((lines.join("\n") + "\n").as_bytes())
        .map_err(|_| "Tidak dapat menulis .env")?;
    temporary
        .persist(path)
        .map_err(|_| "Tidak dapat menyimpan .env")?;
    Ok(())
}

fn read_env_key(path: &std::path::Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let entries = dotenvy::from_path_iter(path).map_err(|_| "Tidak dapat membaca .env")?;
    let mut key = None;
    for entry in entries {
        let (name, value) = entry.map_err(|_| "Format .env tidak valid")?;
        if name == "NVIDIA_API_KEY" && !value.trim().is_empty() {
            key = Some(value);
        }
    }
    Ok(key)
}

pub fn get_api_key() -> Result<Option<String>, String> {
    Ok(read_env_key(&credential_env())?.or_else(|| {
        std::env::var("NVIDIA_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
    }))
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    #[test]
    fn existing_settings_upgrade_without_losing_configuration() {
        let mut old = serde_json::to_value(Settings::default()).unwrap();
        old.as_object_mut().unwrap().remove("speech_provider");
        old.as_object_mut().unwrap().remove("voicevox_style_id");
        old.as_object_mut().unwrap().remove("affectionate_mode");
        old["nvidia_model"] = "existing-model".into();
        let loaded: Settings = serde_json::from_value(old).unwrap();
        assert_eq!(loaded.nvidia_model, "existing-model");
        assert_eq!(loaded.speech_provider, "voicevox");
        assert_eq!(loaded.voicevox_style_id, None);
        assert!(!loaded.affectionate_mode);
    }
}

#[cfg(test)]
mod env_tests {
    use super::*;
    #[test]
    fn env_roundtrip_preserves_other_settings_and_replaces_existing_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(".env");
        fs::write(
            &path,
            "# local config\nOTHER=value\nexport NVIDIA_API_KEY=old\n",
        )
        .unwrap();
        write_env_key(&path, "test-replacement").unwrap();
        assert_eq!(
            read_env_key(&path).unwrap().as_deref(),
            Some("test-replacement")
        );
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("OTHER=value"));
        assert_eq!(content.matches("NVIDIA_API_KEY").count(), 1);
        write_env_key(&path, "").unwrap();
        assert!(read_env_key(&path).unwrap().is_none());
    }
}
