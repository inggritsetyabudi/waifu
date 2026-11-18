use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, time::Duration};

const ENGINE: &str = "http://127.0.0.1:50021";

#[derive(Clone, Deserialize)]
struct Speaker {
    name: String,
    speaker_uuid: String,
    styles: Vec<Style>,
}
#[derive(Clone, Deserialize)]
struct Style {
    name: String,
    id: u32,
    #[serde(rename = "type")]
    kind: Option<String>,
}
#[derive(Serialize)]
pub struct Voice {
    id: u32,
    name: String,
}
#[derive(Serialize)]
pub struct VoicevoxStatus {
    voices: Vec<Voice>,
    selected_id: u32,
    selected_name: String,
    source: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())
}

fn config_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    return std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Application Support/VOICEVOX/config.json"));
    #[cfg(target_os = "windows")]
    return std::env::var_os("APPDATA").map(|h| PathBuf::from(h).join("VOICEVOX/config.json"));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    None
}

fn editor_config() -> Value {
    config_path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}
fn voices(speakers: &[Speaker]) -> Vec<Voice> {
    speakers
        .iter()
        .flat_map(|s| {
            s.styles
                .iter()
                .filter(|v| matches!(v.kind.as_deref(), None | Some("talk" | "streaming_talk")))
                .map(|v| Voice {
                    id: v.id,
                    name: format!("{} · {}", s.name, v.name),
                })
        })
        .collect()
}
fn select_voice(
    speakers: &[Speaker],
    config: &Value,
    explicit: Option<u32>,
) -> Result<(u32, String), String> {
    let available = voices(speakers);
    if let Some(id) = explicit {
        if available.iter().any(|v| v.id == id) {
            return Ok((id, "Pilihan aplikasi".into()));
        }
        return Err(
            "Style VOICEVOX yang dipilih tidak tersedia. Pilih ulang di Pengaturan.".into(),
        );
    }
    let ordered = config["userCharacterOrder"]
        .as_array()
        .and_then(|v| v.first())
        .and_then(Value::as_str);
    let speaker = ordered
        .and_then(|id| speakers.iter().find(|s| s.speaker_uuid == id))
        .or(speakers.first())
        .ok_or("VOICEVOX tidak memiliki karakter suara")?;
    let default = config["defaultStyleIds"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|v| v["speakerUuid"].as_str() == Some(&speaker.speaker_uuid))
        })
        .and_then(|v| v["defaultStyleId"].as_u64())
        .and_then(|v| u32::try_from(v).ok());
    let id = default
        .filter(|id| available.iter().any(|v| v.id == *id))
        .or_else(|| {
            speaker
                .styles
                .iter()
                .find(|s| available.iter().any(|v| v.id == s.id))
                .map(|s| s.id)
        })
        .ok_or("Karakter VOICEVOX tidak memiliki style bicara")?;
    Ok((
        id,
        "Default tersimpan VOICEVOX (bukan seleksi aktif editor)".into(),
    ))
}
async fn speakers(client: &reqwest::Client) -> Result<Vec<Speaker>, String> {
    client
        .get(format!("{ENGINE}/speakers"))
        .send()
        .await
        .map_err(|_| {
            "Tidak dapat terhubung ke VOICEVOX. Buka VOICEVOX dengan engine di port 50021."
                .to_string()
        })?
        .error_for_status()
        .map_err(|e| format!("VOICEVOX: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn cmd_voicevox_status(
    state: tauri::State<'_, crate::AppState>,
) -> Result<VoicevoxStatus, String> {
    let explicit = state.settings.lock().unwrap().voicevox_style_id;
    status(explicit).await
}
async fn status(explicit: Option<u32>) -> Result<VoicevoxStatus, String> {
    let client = client()?;
    let speakers = speakers(&client).await?;
    let (selected_id, source) = select_voice(&speakers, &editor_config(), explicit)?;
    let voices = voices(&speakers);
    let selected_name = voices
        .iter()
        .find(|v| v.id == selected_id)
        .unwrap()
        .name
        .clone();
    Ok(VoicevoxStatus {
        voices,
        selected_id,
        selected_name,
        source,
    })
}
pub async fn synthesize(text: &str, explicit: Option<u32>) -> Result<Vec<u8>, String> {
    // Resolve again for every utterance so saved editor defaults are picked up automatically.
    let status = status(explicit).await?;
    let client = client()?;
    let style = status.selected_id.to_string();
    let query: Value = client
        .post(format!("{ENGINE}/audio_query"))
        .query(&[("text", text), ("speaker", style.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("VOICEVOX audio_query: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let audio = client
        .post(format!("{ENGINE}/synthesis"))
        .query(&[("speaker", style)])
        .json(&query)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("VOICEVOX synthesis: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    if audio.len() < 44 || &audio[..4] != b"RIFF" || &audio[8..12] != b"WAVE" {
        return Err("VOICEVOX tidak mengembalikan audio WAV yang valid".into());
    }
    Ok(audio.to_vec())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn follows_editor_default_and_explicit_override() {
        let speakers: Vec<Speaker> = serde_json::from_value(serde_json::json!([
            {"name":"A", "speaker_uuid":"a", "styles":[{"name":"normal","id":2}]},
            {"name":"B", "speaker_uuid":"b", "styles":[{"name":"normal","id":3},{"name":"soft","id":4}]}
        ])).unwrap();
        let config = serde_json::json!({"userCharacterOrder":["b"],"defaultStyleIds":[{"speakerUuid":"b","defaultStyleId":4}]});
        assert_eq!(select_voice(&speakers, &config, None).unwrap().0, 4);
        assert_eq!(select_voice(&speakers, &config, Some(2)).unwrap().0, 2);
        assert!(select_voice(&speakers, &config, Some(999)).is_err());
    }
    #[tokio::test]
    #[ignore = "requires a running local VOICEVOX engine"]
    async fn local_engine_generates_wave() {
        let result = synthesize("こんにちは。", None).await.unwrap();
        assert!(result.len() > 1000);
    }
}
