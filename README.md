# AI VTuber Assistant

A macOS-first transparent Live2D desktop companion with NVIDIA NIM chat, VOICEVOX speech, and Indonesian voice input.

## Run

```sh
npm install
npm run desktop
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


## API key from .env

The application no longer reads or writes macOS Keychain. In development and this local debug app, set the key in `ai-vtuber-assistant/.env`:

```dotenv
NVIDIA_API_KEY=your_key_here
```

`.env` is ignored by Git; `.env.example` contains no secret. You can also paste the key into Settings → **Simpan ke .env**, or choose **Pakai sesi ini** to keep it only in memory. **Muat .env** explicitly refreshes an edited file. Production bundles use `.env` in the app's configuration directory, written by the same Settings action. File writes preserve other environment entries and use private file permissions on macOS. No `VITE_` secret is used or sent back to the frontend.

## Click reactions and microphone crashes

Clicking the avatar triggers a local expression/gesture for the clicked region (head, face, hands, body, feet, or accessories). Drawable triangle tests reject empty space; bundled-model zones provide semantic names because their manifests omit HitAreas. These touch reactions are local animation feedback, separate from AI replies. Dragging begins after a movement threshold, so a click does not move the window. The microphone icon is directly accessible beside the avatar, and button clicks cannot trigger avatar dragging or double-click menu toggles.

Use **npm run desktop** on macOS to build/open the actual `.app` through LaunchServices. The reported crash was a TCC privacy termination: an unbundled child process launched by VS Code could be attributed to the IDE, which lacks the speech usage description. The app bundle includes both usage descriptions, its own bundle identifier, and the audio input entitlement. Native code checks for an app bundle and usage descriptions before asking permission; a bare IDE executable shows instructions instead of calling the API that caused the crash. `npm run tauri dev` remains available for UI work, but its microphone is intentionally blocked by that preflight.

The OS microphone and Speech Recognition consent dialogs are still required on first use. They are separate from the removed Keychain password prompts. Actual microphone recognition requires an interactive test after permission is granted.


## Bubble controls and help with the Mac screen

The companion now has a separate bubble column next to the avatar. Replies, recording state, touch feedback, errors, controls, and screen previews flow in that column instead of being positioned over the model. The bottom bubble contains microphone, message/controls, screen-help, and settings icons. Expanded content scrolls within the column on smaller windows. More gesture choices are available under **Aksi & ekspresi**; head/body gestures and available shoulder/hand parameters blend in/out, while unsupported rig controls are skipped.

Press **Bantu layar Mac**, grant macOS Screen Recording access when required, then drag to select an area. Escape cancels. Honey hides its own windows while the region selector is active and restores them afterward. Apple Vision reads text locally. Review/edit that text and enter a question, then press **Kirim teks layar**. Only the reviewed text and question go to NVIDIA; the image remains local and temporary capture files are deleted. There is no background screen monitoring. OCR may miss small or stylized text; edit the preview when needed.

This supports explaining errors, understanding application text, summarizing selected content, and suggesting next steps. It does not autonomously click/type in other apps, execute shell commands, or inspect images without readable text. The selected NIM model remains usable because screen assistance uses text context rather than assuming image-input support. Screen text is treated as untrusted data in the model prompt.

Additional validation: `tests/native-screen.m` draws a synthetic image and checks the real native Vision OCR without recording the desktop. UI tests cover simultaneous panels at 640×520, non-overlap with the avatar, actual gesture movement, reviewed-text submission, cancellation, and denied screen permissions. Interactive screen selection still requires a manual test after macOS permission is granted.

## Ask for poses and expressions in conversation

Text chat and microphone transcripts use the same NIM action-planning instructions. For example:

- `Pose malu dulu, lalu lambaikan tangan sambil tersenyum.`
- `Kedipkan sebelah mata dan sapa aku.`
- `Coba pose percaya diri selama lima detik.`
- `Tunjukkan ekspresi kaget, lalu kembali santai.`
- `Berhenti, kembali normal.`

The model returns an allowlisted `actions` array inside emotion metadata. Each step may contain pose, expression, gesture, bounded duration/intensity, and a short Japanese `speech_ja` line. Indonesian reply text remains in the bubble. When step-specific speech is available, only those lines are spoken; the whole-reply Japanese translation is not spoken a second time. Each step waits for its audio playback and minimum duration before the next begins. Lip sync continues to use actual playback samples.

Supported poses are neutral, shy, confident, thinking, greeting, relaxed, and celebrate; expressions include smile, blush, pout, cry, surprised, sleepy, serious, wink, and neutral. Live2D applies head/body/gaze posture changes and supported model expressions, skipping unavailable rig parameters. These are model-compatible posture variations, not unrestricted skeletal animation or costume changes. Unsupported physical requests are described as unavailable in the model instructions.

New messages/microphone input and **Hentikan aksi & suara** interrupt the queue. Click reactions and manual actions also replace queued animation. A maximum of six steps and 30 seconds of declared animation duration are accepted. Actual playback can take longer than the declared animation duration. Native tests validate the action schema; UI integration checks voiced step order, actual pose/expression selection, duplicate-speech prevention, and cancellation. The ignored `nvidia_plans_voiced_pose_sequence` test exercises real NIM action planning with the configured `.env` key.


## Appearance and playful interactions

Honey now has a welcome card, an activity header (ready/listening/thinking/speaking), polished companion bubbles, and a redesigned control studio. Three atmospheres—Lavender, Senja, and Matcha—change the UI palette without changing avatar assets. Appearance, mute, touch sounds, and reduced motion are remembered locally and synchronized between the companion and control window. These preferences contain no credentials or conversation text.

**Aksi cepat** offers High five, Semangati aku, Pose lucu, and Tarik napas. These are explicitly local animation/voice presets, separate from NIM conversation replies. They use the existing action director and real Japanese speech, and can be interrupted. Optional touch sounds are off by default; enabling them adds short region-specific voice reactions with a cooldown. Brief pointer-transparent touch sparkles provide visual feedback. Muting suppresses future speech while keeping animation active; reduced motion lowers procedural movement and respects the OS preference.

Reply bubbles support **Salin**, **Dengarkan**, and **Sematkan**. Pinning keeps the latest reply from auto-hiding until dismissed/unpinned (a new reply replaces its contents); replay uses the original Japanese reply/action lines. Kepribadian sliders in Settings update the backend personality values used in the NIM prompt. No fake relationship meters or microphone levels are used.

Mipmapped model textures improve downscaled rendering while retaining the 2048px atlas limit. UI tests cover muted animation, voiced quick actions, touch audio opt-in, pin persistence, clipboard copy, remembered/synchronized themes, and reduced motion, in addition to the existing conversation/screen/layout checks.

### Mode Manja

Buka kontrol avatar lalu aktifkan **Mode Manja** (juga tersedia di pengaturan kepribadian). Sentuhan biasa mendapat respons lembut, malu-malu, atau bercanda; dada, selangkangan, dan paha tetap memicu penolakan tegas dalam semua mode; AI memakai gaya pasangan virtual yang hangat. Teks tetap Indonesia, suara tetap Jepang. Aktifkan **Suara saat disentuh** untuk mendengar respons sentuhan. Mode tersimpan di pengaturan dan tersinkron antarjendela. Matikan untuk kembali ke respons companion biasa.

### Tingkah spontan

Aktif secara bawaan. Setelah sekitar 9–18 detik tanpa interaksi, avatar sesekali melirik, berganti pose, berpikir, tersenyum, atau mengedip usil. Mode Manja menambah kemungkinan pose malu-malu. Rangkaian bervariasi tanpa mengulang berturut-turut; setelah lama didiamkan, bisa tampil mengantuk. Aktivitas ini lokal dan senyap. Sentuhan, mengetik, mikrofon, jawaban AI, dan kontrol menghentikannya; ia kembali setelah jeda tenang. Nonaktifkan **Tingkah spontan** di kontrol avatar. Pilihan **Gerakan lebih lembut** memperjarang aktivitas dan memperhalus gerakan.

### Balasan sentuhan AI

**Balasan sentuhan AI** aktif secara bawaan: klik avatar meminta satu respons singkat ke NVIDIA NIM, memakai API key dari `.env`. Mode Manja memberi gaya hangat dan malu-malu; batas area sensitif tetap berlaku dalam kedua mode. Klik beruntun digabung, dengan jeda minimum 3,5 detik antarpanggilan. Konteks yang dikirim hanya area sentuhan, jumlah klik, serta tiga balasan sentuhan terakhir; tidak menambah riwayat chat biasa. Bubble berisi bahasa Indonesia; **Suara saat disentuh** mengaktifkan ucapan Jepang. Mikrofon, chat, dan hentikan aksi membatalkan respons tertunda. Jika koneksi gagal, ekspresi lokal tetap bekerja dan status menjelaskan kegagalan; matikan opsi AI untuk kembali ke respons lokal.

### Tampilan minimal & mode ngobrol

Desktop kini menampilkan karakter dan tiga ikon kecil: mikrofon, tulis pesan, serta menu `⋯`. Banner sambutan dan panel aksi tidak lagi tampil otomatis. Menu tambahan menyimpan kontrol suara, bantuan layar, pengaturan, serta bagian **Aksi & kepribadian** yang terlipat. Bubble jawaban tetap berada di samping karakter.

Mikrofon adalah mode ngobrol: sekali ditekan, ia mendengarkan ucapan berikutnya setelah AI selesai menjawab. Penangkapan suara dijeda saat menyiapkan/memutar jawaban untuk mencegah suara avatar menjadi transkrip pengguna, kemudian dilanjutkan setelah jeda singkat. Ikon tetap aktif selama mode menyala; tekan lagi untuk berhenti. Mode ini tidak aktif otomatis saat aplikasi baru dibuka. Sesi native yang berakhir tanpa ucapan diperbarui; penolakan izin atau kegagalan pengenal ucapan mematikan mode dan menampilkan alasannya.

**Mengobrol sendiri saat sepi** aktif secara bawaan bersama **Tingkah spontan**. Selain pose lokal setiap 9–18 detik, companion sesekali meminta obrolan singkat dari AI, membacakan bahasa Jepang dan menampilkan teks Indonesia dengan rangkaian ekspresi/pose. Jadwal awal 30–45 detik; setelah interaksi, ia menunggu sekitar 45–90 detik yang tenang. Aktivitas berhenti saat kamu berbicara, mengetik, atau memakai kontrol. Matikan opsi tersebut atau bisukan suara untuk menghentikan inisiatif suara. Avatar tidak diberi akses layar untuk fitur ini.

Gestur `heart`, `peace`, `sip_tea`, `check_phone`, dan `money` memakai pose/atribut bawaan Nicole bila tersedia. Model lain memakai gerakan ringan yang didukung. Semua gestur itu juga dapat diminta lewat obrolan; tidak perlu mengganti model untuk menggunakan percakapan.

### Batas sentuhan & letak kontrol

Kontrol mikrofon, chat, dan menu berada tepat di bawah karakter, dalam ruang tersendiri. Panel yang diperluas, formulir, dan bubble tetap di samping sehingga tidak menutupi avatar, termasuk pada ukuran minimum jendela.

Area dada, selangkangan, dan paha memicu ekspresi marah/tegas dan gelengan kepala, termasuk saat **Mode Manja** aktif. Batas Nicole dikalibrasi terhadap koordinat model asli, bukan persentase tinggi jendela; area transparan tetap diabaikan. AI mendapat instruksi menolak sentuhan tersebut dan metadata ekspresinya dipastikan tegas. Sentuhan biasa tetap hangat sesuai kepribadian.

### Bubble kiri/kanan, editor pesan, dan aksi tubuh

Karakter kini berada di tengah dengan ruang bubble terpisah di kedua sisi. Setiap jawaban memilih kiri atau kanan secara acak; token streaming tetap pada sisi yang sama. Saat menu, editor pesan, atau konteks layar terbuka di kiri, jawaban dipindah ke kanan agar tidak bertabrakan. Kontrol tetap di bawah karakter. Jendela bawaan diperlebar menjadi 1000 × 660 agar kedua sisi nyaman dibaca.

Editor pesan memakai kartu dengan fokus otomatis, tinggi yang mengikuti isi, tombol kirim, dan draft yang tetap tersimpan saat kartu ditutup. Enter mengirim; Shift+Enter membuat baris baru. Komposisi IME tidak memicu pengiriman.

Aksi tambahan: `dance` (goyang badan dan tangan), `bow` (membungkuk), `stretch` (meregangkan badan), `lean_left`/`lean_right` (condong ke samping), serta `bounce` (memantul ringan di tempat). Semuanya menggerakkan parameter rig/postur, dengan gerak lebih kecil ketika opsi gerakan lembut aktif. Pose hati, peace, teh, ponsel, dan uang tetap memakai atribut bawaan model bila tersedia.

Coba **Aksi cepat → Dance kecil**, **Pamer gaya**, **Jeda teh**, atau **Cilukba**, maupun minta lewat percakapan: “dance kecil lalu membungkuk”. Perilaku spontan juga memakai rangkaian aksi tubuh baru, bukan hanya ekspresi wajah. Gerakan tetap di dalam area karakter dan tidak menciptakan animasi berjalan/salto yang tidak ada pada model.

### Aksi tubuh yang terlihat bersamaan dengan wajah

Pose tangan dan properti Nicole kini diterapkan sebagai lapisan parameter terpisah dari ekspresi wajah. Pose hati/peace, minum teh, ponsel, dan uang tidak hilang ketika wajah berubah; gerakan menyapa dan gembira juga memakai pose tangan bawaan jika tersedia. Pose tetap terlihat penuh saat gerakan lembut aktif.

Balasan AI biasa yang hanya mengirim ekspresi/lirikan diberi rangkaian aksi tangan/badan secara lokal; perintah aksi yang sudah eksplisit, perintah berhenti, dan reaksi marah pada area sensitif tetap dihormati. Semua rangkaian idle sekarang menyertakan aksi tangan, properti, atau badan, termasuk rutinitas manja. Model tanpa atribut tangan mendapat gerakan badan yang tersedia sebagai pengganti.

Untuk ucapan satu jawaban utuh, rangkaian aksi kini berjalan bersamaan dengan suara dan diteruskan bila suara lebih panjang. Audio tidak diputar ulang ketika rangkaian visual mengulang. Rangkaian dengan ucapan per langkah tetap mengikuti urutan aksi dan ucapan masing-masing; menghentikan aktivitas membatalkan antrean seperti biasa.

### Gerakan dasar yang terus hidup

Avatar tetap memiliki gerakan halus di sela-sela aksi: napas, perubahan tumpuan badan, lirikan yang berpindah sendiri, serta mata yang bergerak lebih dahulu sebelum kepala mengikuti. Perhatian pada kursor memudar setelah beberapa detik, sehingga wajah tidak terus terkunci pada posisi mouse terakhir. Saat mic mendengarkan, pandangan lebih ke depan dan postur sedikit condong; gerakan saat bicara mengikuti energi audio yang benar-benar diputar.

Nicole memiliki grup `EyeBlink` kosong pada manifest aslinya. Aplikasi melengkapi grup itu di memori dan memakai kedip Cubism pada rig kelopak mata, tanpa mengubah file model. Gerakan badan juga menggunakan parameter khusus yang tercantum dalam metadata model, termasuk rig badan Nicole, sehingga bentuk mesh berubah saat diam dan bukan hanya menggeser gambar seluruhnya.

Gerakan dasar ini terpisah dari sakelar rangkaian **Tingkah spontan**. **Gerakan lebih lembut** mengurangi amplitudonya; aksi yang sedang diperintahkan tetap diprioritaskan. Verifikasi render mencakup mata tertutup-terbuka, perubahan pandangan tanpa mouse, dan deformasi mesh saat posisi objek tetap diam.
