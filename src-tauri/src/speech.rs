/// Synthesize locally and return WAV samples so playback and lip sync share a clock.
#[tauri::command]
pub async fn cmd_synthesize_speech(
    state: tauri::State<'_, crate::AppState>,
    text: String,
) -> Result<Vec<u8>, String> {
    validate_text(&text)?;
    let settings = state.settings.lock().unwrap().clone();
    if settings.speech_provider == "voicevox" {
        return crate::voicevox::synthesize(&text, settings.voicevox_style_id).await;
    }
    if settings.speech_provider != "system" {
        return Err(
            "Mesin suara tidak dikenal. Pilih VOICEVOX atau suara sistem di Pengaturan.".into(),
        );
    }
    system_speech(text).await
}

fn validate_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() || text.chars().count() > 12000 {
        return Err("Speech must contain 1–12000 characters".into());
    }
    Ok(())
}

async fn system_speech(text: String) -> Result<Vec<u8>, String> {
    validate_text(&text)?;
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input = dir.path().join("speech.txt");
    let output = dir.path().join("speech.wav");
    tokio::fs::write(&input, text)
        .await
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let result = tokio::process::Command::new("/usr/bin/say")
        .args([
            "-v",
            "Kyoko",
            "--file-format=WAVE",
            "--data-format=LEI16@22050",
            "-o",
        ])
        .arg(&output)
        .arg("-f")
        .arg(&input)
        .kill_on_drop(true)
        .output();

    #[cfg(target_os = "windows")]
    {
        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command",
            "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [System.Globalization.CultureInfo]::GetCultureInfo('ja-JP')); $s.SetOutputToWaveFile($env:VTUBER_SPEECH_OUTPUT); $s.Speak([IO.File]::ReadAllText($env:VTUBER_SPEECH_INPUT)) } finally { $s.Dispose() }"])
            .env("VTUBER_SPEECH_INPUT", &input).env("VTUBER_SPEECH_OUTPUT", &output)
            .kill_on_drop(true);
        // Keep the Command alive until its output future has completed.
        return synthesize_windows(cmd, output, dir).await;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("Local speech currently supports macOS and Windows".into());

    #[cfg(target_os = "macos")]
    {
        let result = tokio::time::timeout(std::time::Duration::from_secs(90), result)
            .await
            .map_err(|_| "Speech synthesis timed out")?
            .map_err(|e| e.to_string())?;
        if !result.status.success() {
            return Err("System speech synthesis failed. Check installed system voices.".into());
        }
        tokio::fs::read(output).await.map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "windows")]
async fn synthesize_windows(
    mut cmd: tokio::process::Command,
    output: std::path::PathBuf,
    _dir: tempfile::TempDir,
) -> Result<Vec<u8>, String> {
    let result = tokio::time::timeout(std::time::Duration::from_secs(90), cmd.output())
        .await
        .map_err(|_| "Speech synthesis timed out")?
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err("System speech synthesis failed. Check installed system voices.".into());
    }
    tokio::fs::read(output).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_empty_or_excessive_text() {
        assert!(system_speech("  ".into()).await.is_err());
        assert!(system_speech("a".repeat(12001)).await.is_err());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn system_voice_returns_nonempty_wave_audio() {
        let audio = system_speech("こんにちは。".into()).await.unwrap();
        assert_eq!(&audio[..4], b"RIFF");
        assert_eq!(&audio[8..12], b"WAVE");
        let data = audio.windows(4).position(|s| s == b"data").unwrap();
        let size = u32::from_le_bytes(audio[data + 4..data + 8].try_into().unwrap()) as usize;
        assert!(size > 22050, "Expected actual speech samples");
        assert!(audio[data + 8..data + 8 + size].iter().any(|v| *v != 0));
    }
}
