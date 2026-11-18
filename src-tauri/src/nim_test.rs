use crate::nim::split_emo;

#[test]
fn strips_complete_emo_tag() {
    let text = "Hai! Senang bertemu.\n<EMO>{\"primary\":\"happy\",\"intensity\":0.6}</EMO>";
    let (spoken, emo) = split_emo(text);
    assert_eq!(spoken, "Hai! Senang bertemu.");
    assert!(emo.is_some());
    let emo = emo.unwrap();
    assert!(emo.contains("happy"));
}

#[test]
fn partial_tag_keeps_text_hidden_but_empty_emo() {
    let text = "Hai! Senang <EMO>{\"primary\":\"hap";
    let (spoken, emo) = split_emo(text);
    assert_eq!(spoken, "Hai! Senang");
    assert!(emo.is_none());
}

#[test]
fn no_tag_passes_through() {
    let text = "Just plain dialogue";
    let (spoken, emo) = split_emo(text);
    assert_eq!(spoken, "Just plain dialogue");
    assert!(emo.is_none());
}

#[test]
fn invalid_json_emo_is_dropped() {
    let text = "teks\n<EMO>bukan json</EMO>";
    let (spoken, emo) = split_emo(text);
    assert_eq!(spoken, "teks");
    assert!(emo.is_none());
}

#[test]
fn emo_in_middle_is_stripped() {
    let text = "awal <EMO>{\"a\":1}</EMO> akhir";
    let (spoken, emo) = split_emo(text);
    // anything after the tag is ignored by design (tag must be last line)
    assert_eq!(spoken, "awal");
    assert!(emo.is_some());
}

#[test]
#[ignore] // requires local Keychain access; run with: cargo test -- --ignored
fn keychain_key_is_readable() {
    let key = crate::settings::get_api_key().expect("keyring error");
    assert!(key.is_some(), "no NVIDIA API key stored in Keychain");
    assert!(key.unwrap().starts_with("nvapi-"));
}

#[test]
fn separates_indonesian_text_from_japanese_speech() {
    let raw = "Aku senang menemanimu!\n<SPEECH_JA>あなたと一緒にいられてうれしいです！</SPEECH_JA>\n<EMO>{\"primary\":\"happy\"}</EMO>";
    assert_eq!(split_emo(raw).0, "Aku senang menemanimu!");
    assert_eq!(
        crate::nim::japanese_speech(raw).unwrap(),
        "あなたと一緒にいられてうれしいです！"
    );
    for index in 0..raw.len() {
        if raw.is_char_boundary(index) {
            let visible = split_emo(&raw[..index]).0;
            assert!(!visible.contains("SPEECH"));
            assert!(!visible.contains("あなた"));
            assert!(!visible.contains("<"));
        }
    }
}

#[test]
fn does_not_speak_indonesian_when_japanese_is_missing_or_invalid() {
    for raw in [
        "Halo",
        "Halo<SPEECH_JA>Halo</SPEECH_JA>",
        "Halo<SPEECH_JA>こんにちは",
        "Halo<SPEECH_JA>こんにちは<EMO></SPEECH_JA>",
    ] {
        assert!(crate::nim::japanese_speech(raw).is_none());
    }
    assert_eq!(split_emo("Halo<SPEECH_JA>こんにちは").0, "Halo");
}

#[test]
fn bilingual_rules_apply_to_existing_custom_system_prompts() {
    let mut settings = crate::settings::Settings::default();
    settings.system_prompt = "Existing user prompt".into();
    let built = crate::nim::build_system_prompt(&settings);
    assert!(built.starts_with("Existing user prompt"));
    assert!(built.contains("<SPEECH_JA>"));
}
