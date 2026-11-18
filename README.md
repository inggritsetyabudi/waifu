# AI VTuber Assistant

A macOS-first transparent Live2D desktop companion with NVIDIA NIM chat, VOICEVOX speech, and Indonesian voice input.

## Run

```sh
npm install
npm run tauri dev
```

Keep VOICEVOX open with its engine at `http://127.0.0.1:50021`. VOICEVOX is the default speech provider, including for existing settings files. Right-click the avatar → **Pengaturan & chat** → **Settings** to configure NVIDIA NIM and the voice provider. Use **Hubungkan / refresh VOICEVOX** to see the connected voice and choose a character/style. **Suara sistem** remains an explicit alternative; a failed VOICEVOX connection does not silently switch voices.

The avatar starts without controls or background. Drag to move it. The transparent window includes room on the left for reply bubbles. Close the controls to return to the avatar-only view; replies appear beside the avatar even when controls are hidden. On macOS, clicking the Dock icon restores a hidden avatar.

## VOICEVOX voice selection

**Otomatis** rereads VOICEVOX's saved `userCharacterOrder` and `defaultStyleIds` for every utterance. It uses the first configured character and that character's default speaking style. If no saved default is available, it uses that character's first available speaking style. The settings panel shows the resolved voice.

The engine API does **not** expose the editor's currently highlighted character/audio row. Clicking another character in the VOICEVOX editor alone therefore cannot be mirrored. Set the saved editor default, or choose the matching character/style in this app. The integration reads VOICEVOX configuration without modifying it.

Speech synthesis runs locally through `/audio_query` and `/synthesis`. Pronunciation and language support depend on the installed VOICEVOX engine/voice; the installed standard Japanese voices do not promise natural Indonesian pronunciation. The original Indonesian answer remains visible in the bubble. Audio amplitude drives the mouth while WAV samples are playing. New messages and the stop button interrupt playback.

## Voice conversation on macOS

1. Configure the NVIDIA NIM API key.
2. Right-click the avatar and press the **microphone icon** (also available in the main chat panel).
3. Allow macOS **Microphone** and **Speech Recognition** when prompted.
4. Speak Indonesian. An active microphone indicator and interim transcript are shown.
5. After about 1.5 seconds without a transcript change, that utterance is sent once to NIM. The microphone stops, the avatar speaks the reply, and a bubble appears beside it.

Each button press records one utterance, with a 45-second limit. **Batalkan** discards the current utterance. Hiding/closing the companion stops the microphone. Recording does not start automatically. For denied permissions, open System Settings → Privacy & Security → Microphone / Speech Recognition.

Speech recognition uses Apple's native Speech framework and may process audio online. Only the resulting transcript is sent to NVIDIA for a reply. This app does not store microphone recordings. A transient Apple recognition error `203 / Retry` is retried once; a persistent failure displays troubleshooting instructions. The `Info.plist` includes both required usage descriptions for development and app bundles. Windows speech output remains supported; native voice input in this implementation supports macOS only.

WebKit may require a click in the companion to allow audio playback. The microphone button attempts to unlock playback during the click without waiting before recording; **Tes suara** can also be used to enable/test audio in that window.

## Verification

```sh
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
# Requires a running local VOICEVOX engine:
cargo test --manifest-path src-tauri/Cargo.toml local_engine_generates_wave -- --ignored
npm run test:voice
```

The browser test uses Chrome on macOS (or `CHROME_BIN` / an installed Playwright Chromium elsewhere), and its own temporary Vite server on port 1432. It uses a real VOICEVOX-generated WAV with mocked Tauri, recognition, and NIM events. It checks transparent idle presentation, microphone state, interim/final transcripts, duplicate suppression, permission denial, cancellation, bubble placement with hidden controls, emotion, and audio-driven lip sync. It does not record the real microphone or contact NVIDIA. Actual microphone recognition and the full NIM voice conversation require an interactive test after macOS permissions are granted.

References: [VOICEVOX engine API](https://github.com/VOICEVOX/voicevox/blob/main/src/openapi/apis/DefaultApi.ts), [Apple Speech permissions](https://developer.apple.com/documentation/Speech/asking-permission-to-use-speech-recognition), [Tauri configuration](https://v2.tauri.app/reference/config/).

## Indonesian text, Japanese voice

Replies now contain two separate language channels. NIM streams Indonesian text for the chat/bubble, and generates its Japanese equivalent inside a private `<SPEECH_JA>` section. Only the Japanese section is sent to the speech provider; it never appears in the bubble or conversation history. This rule is appended even when an older custom system prompt is saved. If the model omits or truncates Japanese speech, the Indonesian answer remains visible and the app reports the missing speech instead of reading Indonesian through a Japanese voice.

The renderer uses Pixi 6.5.10 to match `pixi-live2d-display`'s declared peer dependencies. Only the companion loads the model. Texture atlases are decoded sequentially and capped at 2048 pixels in memory, with no changes to the original model files. Reloading releases the previous model and textures. A load/context error appears beside the avatar with **Muat ulang avatar**, so a failed model no longer leaves an unexplained blank surface.
