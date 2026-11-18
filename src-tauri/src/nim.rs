use crate::settings::Settings;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

#[derive(Clone)]
pub struct NimClient {
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
struct SseDelta {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SseChoice {
    delta: Option<SseDelta>,
}

#[derive(Debug, Deserialize)]
struct SseChunk {
    choices: Option<Vec<SseChoice>>,
    #[allow(dead_code)]
    error: Option<Value>,
}

/// Map free-form LLM emotion labels onto the canonical emotion set the
/// animation layer understands.
fn normalize_emotion(v: &mut Value) {
    const MAP: &[(&str, &str)] = &[
        ("joy", "happy"),
        ("joyful", "happy"),
        ("happiness", "happy"),
        ("affection", "happy"),
        ("love", "shy"),
        ("flustered", "flustered"),
        ("shyness", "shy"),
        ("embarrassment", "embarrassed"),
        ("smug", "teasing"),
        ("mischief", "playful"),
        ("worry", "concerned"),
        ("fear", "nervous"),
        ("anxious", "nervous"),
        ("grief", "sad"),
        ("disgust", "annoyed"),
        ("frustration", "annoyed"),
        ("irritation", "annoyed"),
        ("astonishment", "surprised"),
        ("drowsiness", "sleepy"),
    ];
    if let Some(primary) = v
        .get("primary")
        .and_then(|p| p.as_str())
        .map(|s| s.to_lowercase())
    {
        let canonical = MAP
            .iter()
            .find(|(from, _)| *from == primary)
            .map(|(_, to)| to.to_string());
        if let Some(canonical) = canonical {
            v["primary"] = Value::String(canonical);
        }
    }
}

/// Strip the trailing <EMO>{...}</EMO> directive from a streamed assistant
/// message, returning (spoken_text_so_far, Some(emo_json) when complete).
pub fn split_emo(text: &str) -> (String, Option<String>) {
    let mut boundary = text.len();
    for marker in ["<SPEECH_JA>", "<EMO>"] {
        if let Some(index) = text.find(marker) {
            boundary = boundary.min(index);
        }
        // Suppress tag prefixes even when split across SSE tokens.
        for length in 1..marker.len() {
            if text.ends_with(&marker[..length]) {
                boundary = boundary.min(text.len() - length);
            }
        }
    }
    let visible = text[..boundary].trim_end().to_string();
    let emo = text.find("<EMO>").and_then(|start| {
        let body = &text[start + "<EMO>".len()..];
        let end = body.find("</EMO>")?;
        let mut value: Value = serde_json::from_str(&body[..end]).ok()?;
        if !value.is_object() {
            return None;
        }
        normalize_emotion(&mut value);
        Some(value.to_string())
    });
    (visible, emo)
}

/// Japanese speech is kept separate from Indonesian UI text and history.
pub fn japanese_speech(text: &str) -> Option<String> {
    let start = text.find("<SPEECH_JA>")? + "<SPEECH_JA>".len();
    let tail = &text[start..];
    let speech = tail[..tail.find("</SPEECH_JA>")?].trim();
    if speech.is_empty() || speech.chars().count() > 12000 || speech.contains(['<', '>']) {
        return None;
    }
    if !speech
        .chars()
        .any(|c| matches!(c as u32, 0x3040..=0x30ff | 0x3400..=0x9fff))
    {
        return None;
    }
    Some(speech.to_string())
}

fn completed_reply(id: &str, raw: &str) -> Value {
    let (text, emo) = split_emo(raw);
    json!({ "id": id, "text": text, "emo": emo, "speech_text": japanese_speech(raw) })
}

impl NimClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("reqwest client"),
        }
    }

    pub async fn test_connection(
        &self,
        settings: &Settings,
        api_key: &str,
    ) -> Result<String, String> {
        let url = format!("{}/models", settings.nim_base_url.trim_end_matches('/'));
        let resp = self
            .http
            .get(&url)
            .bearer_auth(api_key)
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("network error: {e}"))?;
        match resp.status() {
            s if s.is_success() => {
                let body: Value = resp.json().await.map_err(|e| e.to_string())?;
                let count = body["data"].as_array().map(|a| a.len()).unwrap_or(0);
                Ok(format!("Connected. {count} models available."))
            }
            s if s.as_u16() == 401 => Err("Invalid API key (401 Unauthorized)".into()),
            s => Err(format!(
                "HTTP {s}: {}",
                resp.text()
                    .await
                    .unwrap_or_default()
                    .chars()
                    .take(300)
                    .collect::<String>()
            )),
        }
    }

    /// Stream a chat completion. Emits `nim://chunk` {id, delta, text},
    /// `nim://emo` {id, emo}, `nim://done` {id, text, emo}, `nim://error` {id, message}.
    pub async fn chat_stream(
        &self,
        app: AppHandle,
        req_id: String,
        settings: Settings,
        api_key: String,
        messages: Vec<ChatMessage>,
        cancel: CancellationToken,
    ) {
        let url = format!(
            "{}/chat/completions",
            settings.nim_base_url.trim_end_matches('/')
        );
        let body = json!({
            "model": settings.nvidia_model,
            "messages": messages,
            "temperature": settings.temperature,
            "top_p": settings.top_p,
            "max_tokens": settings.max_tokens,
            "presence_penalty": settings.presence_penalty,
            "frequency_penalty": settings.frequency_penalty,
            "stream": true,
        });

        let result = self
            .http
            .post(&url)
            .bearer_auth(&api_key)
            .json(&body)
            .send();

        tokio::select! {
            resp = result => {
                match resp {
                    Ok(resp) if resp.status().is_success() => {
                        // Some networks/proxies buffer SSE forever (0 bytes).
                        // If no first chunk arrives in time, fall back to
                        // non-streaming completion.
                        let mut fallback_body = body.clone();
                        fallback_body["stream"] = Value::Bool(false);
                        self.pump_stream(app, req_id, url, resp, cancel, fallback_body, api_key)
                            .await;
                    }
                    Ok(resp) => {
                        let status = resp.status();
                        let text = resp.text().await.unwrap_or_default();
                        let msg = if status.as_u16() == 401 {
                            "Invalid NVIDIA API key (401)".to_string()
                        } else if status.as_u16() == 429 {
                            "Rate limited (429) — try again shortly".to_string()
                        } else {
                            format!("HTTP {status}: {}", text.chars().take(400).collect::<String>())
                        };
                        tracing::warn!(%req_id, %msg, "nim chat failed");
                        let _ = app.emit("nim://error", serde_json::json!({"id": req_id, "message": msg}));
                    }
                    Err(e) => {
                        let _ = app.emit("nim://error", serde_json::json!({"id": req_id, "message": format!("network error: {e}")}));
                    }
                }
            }
            _ = cancel.cancelled() => {
                tracing::info!(%req_id, "chat request cancelled before response");
                let _ = app.emit("nim://cancelled", serde_json::json!({"id": req_id}));
            }
        }
    }

    async fn pump_stream(
        &self,
        app: AppHandle,
        req_id: String,
        url: String,
        resp: reqwest::Response,
        cancel: CancellationToken,
        fallback_body: Value,
        fallback_key: String,
    ) {
        let mut stream = resp.bytes_stream();
        let first = tokio::select! {
            first = stream.next() => first,
            _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => {
                return self.fallback_chat(app, req_id, url, fallback_body, fallback_key, cancel).await;
            }
            _ = cancel.cancelled() => {
                let _ = app.emit("nim://cancelled", json!({"id": req_id}));
                return;
            }
        };
        let Some(Ok(first)) = first else {
            return self
                .fallback_chat(app, req_id, url, fallback_body, fallback_key, cancel)
                .await;
        };
        // Decode only complete SSE lines. Japanese UTF-8 characters may span network chunks.
        let mut buffer = first.to_vec();
        let mut full_text = String::new();
        let mut ended = false;
        loop {
            while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
                let line = String::from_utf8_lossy(&buffer[..index])
                    .trim_end_matches('\r')
                    .to_string();
                buffer.drain(..=index);
                let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                    continue;
                };
                if data == "[DONE]" {
                    let payload = completed_reply(&req_id, &full_text);
                    if !payload["emo"].is_null() {
                        let _ = app.emit("nim://emo", json!({"id": req_id, "emo": payload["emo"]}));
                    }
                    let _ = app.emit("nim://done", payload);
                    return;
                }
                if let Ok(mut chunk) = serde_json::from_str::<SseChunk>(data) {
                    if let Some(delta) = chunk
                        .choices
                        .as_mut()
                        .and_then(|c| c.first_mut())
                        .and_then(|c| c.delta.as_mut())
                        .and_then(|d| d.content.take())
                    {
                        full_text.push_str(&delta);
                        let (text, _) = split_emo(&full_text);
                        let _ = app.emit(
                            "nim://chunk",
                            json!({"id": req_id, "delta": delta, "text": text, "complete": false}),
                        );
                    }
                }
            }
            if ended {
                let _ = app.emit("nim://done", completed_reply(&req_id, &full_text));
                return;
            }
            tokio::select! {
                item = stream.next() => match item {
                    Some(Ok(bytes)) => buffer.extend_from_slice(&bytes),
                    Some(Err(error)) => {
                        let _ = app.emit("nim://error", json!({"id": req_id, "message": format!("stream error: {error}")}));
                        return;
                    }
                    None => {
                        ended = true;
                        if !buffer.is_empty() { buffer.push(b'\n'); }
                    }
                },
                _ = cancel.cancelled() => {
                    let _ = app.emit("nim://cancelled", json!({"id": req_id}));
                    return;
                }
            }
        }
    }

    /// Non-streaming completion used when SSE is unavailable on this network.
    async fn fallback_chat(
        &self,
        app: AppHandle,
        req_id: String,
        url: String,
        mut body: Value,
        api_key: String,
        cancel: CancellationToken,
    ) {
        body["stream"] = Value::Bool(false);
        let http = self.http.clone();

        tokio::select! {
            resp = http.post(&url).bearer_auth(&api_key).json(&body).send() => {
                match resp {
                    Ok(resp) if resp.status().is_success() => {
                        match resp.json::<Value>().await {
                            Ok(data) => {
                                let raw = data["choices"][0]["message"]["content"]
                                    .as_str().unwrap_or("").to_string();
                                let (spoken, emo) = split_emo(&raw);
                                if let Some(emo) = emo.clone() {
                                    let _ = app.emit("nim://emo", serde_json::json!({"id": req_id, "emo": emo}));
                                }
                                let _ = app.emit("nim://chunk", serde_json::json!({"id": req_id, "delta": spoken, "text": spoken, "complete": true}));
                                let _ = app.emit("nim://done", completed_reply(&req_id, &raw));
                                tracing::info!(%req_id, len = spoken.len(), "chat done (non-streaming fallback)");
                            }
                            Err(e) => {
                                let _ = app.emit("nim://error", serde_json::json!({"id": req_id, "message": format!("bad response: {e}")}));
                            }
                        }
                    }
                    Ok(resp) => {
                        let status = resp.status();
                        let text = resp.text().await.unwrap_or_default();
                        let _ = app.emit("nim://error", serde_json::json!({"id": req_id, "message": format!("HTTP {status}: {}", text.chars().take(300).collect::<String>())}));
                    }
                    Err(e) => {
                        let _ = app.emit("nim://error", serde_json::json!({"id": req_id, "message": format!("network error: {e}")}));
                    }
                }
            }
            _ = cancel.cancelled() => {
                let _ = app.emit("nim://cancelled", serde_json::json!({"id": req_id}));
            }
        }
    }
}

/// Build the system prompt by injecting personality parameter values.
pub fn build_system_prompt(settings: &Settings) -> String {
    let p = &settings.personality;
    format!(
        "{}\n\nParameter kepribadian saat ini (0-100): Shyness={}, Cheerfulness={}, Playfulness={}, Calmness={}, Confidence={}, Curiosity={}, Expressiveness={}, Gentleness={}, Assertiveness={}, EmotionalSensitivity={}.",
        settings.system_prompt,
        p.shyness,
        p.cheerfulness,
        p.playfulness,
        p.calmness,
        p.confidence,
        p.curiosity,
        p.expressiveness,
        p.gentleness,
        p.assertiveness,
        p.emotional_sensitivity
    ) + r#"

ATURAN OUTPUT BILINGUAL WAJIB (menggantikan aturan format sebelumnya jika berbeda):
Teks yang terlihat oleh pengguna harus seluruhnya bahasa Indonesia. Setelah jawaban Indonesia, tulis terjemahan yang maknanya sama dalam bahasa Jepang untuk diucapkan, dibungkus tepat dalam tag <SPEECH_JA>...</SPEECH_JA>. Terakhir tulis metadata <EMO>...</EMO> seperti biasa.
Contoh format:
Senang bertemu denganmu! Apa yang ingin kamu bicarakan hari ini?
<SPEECH_JA>会えてうれしいです！今日は何について話しましょうか？</SPEECH_JA>
<EMO>{"primary":"happy","intensity":0.7,"gesture":"nod"}</EMO>
Jangan menampilkan bahasa Jepang di luar tag SPEECH_JA. Isi SPEECH_JA hanya ucapan Jepang natural tanpa romaji, markdown, instruksi, atau metadata. Jawaban Indonesia dan ucapan Jepang harus menyampaikan jawaban yang sama. Jangan abaikan kedua bagian ini, termasuk saat jawaban singkat.
"#
}

#[cfg(test)]
mod bilingual_live_test {
    use super::*;
    #[tokio::test]
    #[ignore = "requires NVIDIA credentials and a live network request"]
    async fn nvidia_generates_indonesian_text_and_japanese_speech() {
        let key = crate::settings::get_api_key()
            .unwrap()
            .expect("Configure NVIDIA key first");
        let settings = Settings::default();
        let client = NimClient::new();
        let response = client
            .http
            .post(format!("{}/chat/completions", settings.nim_base_url))
            .bearer_auth(key)
            .timeout(std::time::Duration::from_secs(60))
            .json(
                &json!({"model":settings.nvidia_model,"stream":false,"max_tokens":700,
                "messages":[{"role":"system","content":build_system_prompt(&settings)},
                    {"role":"user","content":"Sapa aku singkat dalam satu kalimat."}]}),
            )
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        let raw = response["choices"][0]["message"]["content"]
            .as_str()
            .expect("Missing content");
        let (visible, _) = split_emo(raw);
        assert!(!visible.is_empty());
        assert!(
            !visible
                .chars()
                .any(|c| matches!(c as u32, 0x3040..=0x30ff | 0x3400..=0x9fff))
        );
        assert!(
            japanese_speech(raw).is_some(),
            "Model omitted Japanese speech"
        );
    }
}
