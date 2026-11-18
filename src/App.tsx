import { useCallback, useEffect, useRef, useState } from "react";
import {
  Settings,
  getSettings,
  saveSettings as saveSettingsCmd,
  hasApiKey,
  setApiKey as setApiKeyCmd,
  testConnection,
  sendChat,
  listenChatEvents,
  cancelChat,
  commitTurn,
  ChunkPayload,
  DonePayload,
  ErrorPayload,
  clearHistory,
  openCompanion,
  closeCompanion,
  openSettings,
} from "./lib/tauri";
import { ensureCubismCore } from "./avatar/cubism";

import { invoke } from "@tauri-apps/api/core";
import { useVoiceInput } from "./audio/useVoiceInput";
import { MicrophoneButton } from "./components/MicrophoneButton";
import { AvatarSpeech } from "./audio/speech";
import "./App.css";

interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  emo?: {
    primary?: string;
    secondary?: string;
    intensity?: number;
    gesture?: string;
    expression?: string;
  } | null;
}
/** Common capability surface shared by Live2DStage and VRMStage. */
interface AvatarStage {
  setEmotion?(primary: string, intensity: number): void;
  setExpression?(name: string, durationMs?: number): void;
  playMotion?(group: string): void;
  gesture?(g: string): void;
  feedLipSync?(level: number): void;
  stopLipSync?(): void;
  resize?(): void;
  destroy?(): void;
  dispose?(): void;
}

interface VoicevoxStatus {
  voices: { id: number; name: string }[];
  selected_id: number;
  selected_name: string;
  source: string;
}

interface ExprInfo {
  expressions: string[];
  motions: string[];
}

function parseEmotion(raw: string | null): ChatMsg["emo"] {
  try {
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<AvatarStage | null>(null);
  const loadedSettings = useRef<Settings | null>(null);
  const isCompanion =
    new URLSearchParams(window.location.search).get("mode") === "companion";

  const [showControls, setShowControls] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [voiceStarting, setVoiceStarting] = useState(false);
  const voiceStartPending = useRef(false);
  const [voicevox, setVoicevox] = useState<VoicevoxStatus | null>(null);
  const [reply, setReply] = useState("");
  const [replyVisible, setReplyVisible] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const replyPhase = useRef<"streaming" | "preparing" | "speaking" | "idle">("idle");
  const bubbleReply = (text: string, phase: typeof replyPhase.current) => {
    clearTimeout(replyTimer.current);
    replyPhase.current = phase;
    setReply(text); setReplyVisible(Boolean(text));
  };
  const dismissLater = () => {
    clearTimeout(replyTimer.current);
    replyTimer.current = setTimeout(() => setReplyVisible(false), 15000);
  };
  const speechRef = useRef<AvatarSpeech | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyPresent, setKeyPresent] = useState(false);
  const [connStatus, setConnStatus] = useState<string>("");
  const [avatarStatus, setAvatarStatus] = useState("init");
  const [avatarAttempt, setAvatarAttempt] = useState(0);
  const [exprInfo, setExprInfo] = useState<ExprInfo>({ expressions: [], motions: [] });
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [emotion, setEmotion] = useState<{ primary: string; intensity: number }>({
    primary: "neutral",
    intensity: 0,
  });
  const idRef = useRef(0);

  // ---- init ----
  useEffect(() => {
    let disposed = false;
    let ownedStage: AvatarStage | null = null;
    const resize = () => ownedStage?.resize?.();
    const reportStatus = (status: string) => {
      if (disposed) return;
      setAvatarStatus(status);
      if (isCompanion) void invoke("cmd_report_avatar_status", { status }).catch(() => {});
    };
    (async () => {
      let s: Settings | null = null;
      try {
        s = await getSettings();
        loadedSettings.current = s;
        setSettings(s);
        if (!isCompanion) void hasApiKey().then((present) => {
          if (!disposed) setKeyPresent(present);
        }).catch(() => {});
      } catch {
        // running outside Tauri (plain browser) — use defaults for preview
        setAvatarStatus("browser preview (no backend)");
      }

      if (disposed) return;
      if (!isCompanion) {
        setAvatarStatus("companion");
        return;
      }
      const modelUrl =
        s?.live2d_model_url ?? "models/Vivian/Vivian.model3.json";
      const kind = s?.avatar_kind ?? "live2d";

      if (kind === "live2d" && canvasRef.current) {
        try {
          setAvatarStatus("Memuat Live2D…");
          await ensureCubismCore();
          const { Live2DStage } = await import("./avatar/live2d");
          if (disposed || !canvasRef.current) return;
          const stage = new Live2DStage(canvasRef.current);
          stage.onStatus = reportStatus;
          stage.onModelInfo = setExprInfo;
          stageRef.current = stage;
          ownedStage = stage;
          if (import.meta.env.DEV) (window as any).__stage = stage;
          await stage.load(modelUrl, s?.avatar_scale ?? 1);
        } catch (e) {
          if (!disposed) reportStatus(`error: ${e}`);
        }
      } else if (kind === "vrm" && canvasRef.current) {
        const { VRMStage } = await import("./avatar/vrm");
        if (disposed || !canvasRef.current) return;
        const stage = new VRMStage(canvasRef.current);
        stageRef.current = stage;
        ownedStage = stage;
        setAvatarStatus(s?.vrm_model_url ? "vrm ready" : "no vrm loaded");
        if (s?.vrm_model_url) {
          try {
            await stage.load(s.vrm_model_url, s?.avatar_scale ?? 1);
          } catch (e) {
            setAvatarStatus(`vrm error: ${e}`);
          }
        }
      }
      if (!disposed) window.addEventListener("resize", resize);
    })();
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      ownedStage?.destroy?.();
      ownedStage?.dispose?.();
      if (stageRef.current === ownedStage) stageRef.current = null;
    };
  }, [avatarAttempt, isCompanion]);

  useEffect(() => {
    const speech = new AvatarSpeech((level) => {
      if (level === 0) stageRef.current?.stopLipSync?.();
      else stageRef.current?.feedLipSync?.(level);
    }, (active) => {
      setSpeaking(active);
      if (active) {
        replyPhase.current = "speaking";
        clearTimeout(replyTimer.current);
      } else if (replyPhase.current === "speaking") {
        replyPhase.current = "idle";
        dismissLater();
      }
    });
    speechRef.current = speech;
    return () => { speech.destroy(); speechRef.current = null; clearTimeout(replyTimer.current); };
  }, []);

  // The companion owns speech even when a reply was requested in the control panel.
  useEffect(() => {
    if (!isCompanion) return;
    document.body.classList.add("companion");
    let disposed = false;
    let un: Array<() => void> = [];
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const apply = (raw: unknown) => {
        try {
          const emo = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (!emo) return;
          stageRef.current?.setEmotion?.(emo.primary ?? "neutral", emo.intensity ?? 0);
          stageRef.current?.gesture?.(emo.gesture ?? "none");
        } catch { /* Ignore malformed metadata without blocking the response. */ }
      };
      const listeners = await Promise.all([
        listen<{ emo: unknown }>("nim://emo", (e) => apply(e.payload.emo)),
        listen<ChunkPayload>("nim://chunk", (e) => {
          if (e.payload.text) bubbleReply(e.payload.text, "streaming");
        }),
        listen<DonePayload>("nim://done", (e) => {
          apply(e.payload.emo);
          if (e.payload.text.trim()) {
            bubbleReply(e.payload.text, "preparing");
            if (!e.payload.speech_text?.trim()) {
              replyPhase.current = "idle"; dismissLater();
              setVoiceStatus("AI belum menghasilkan ucapan Jepang. Jawaban Indonesia tetap ditampilkan.");
              return;
            }
            speechRef.current?.speak(e.payload.speech_text ?? "").catch((e) => {
              replyPhase.current = "idle";
              dismissLater();
              setVoiceStatus(String(e)); setShowControls(true);
            });
          }
        }),
        listen<Settings>("settings://changed", (e) => {
          const previous = loadedSettings.current;
          const next = e.payload;
          if (previous && (previous.avatar_kind !== next.avatar_kind ||
            previous.live2d_model_url !== next.live2d_model_url ||
            previous.vrm_model_url !== next.vrm_model_url ||
            previous.avatar_scale !== next.avatar_scale)) window.location.reload();
          loadedSettings.current = next;
        }),
        listen("nim://cancelled", () => speechRef.current?.stop()),
        listen("avatar://stop-speech", () => speechRef.current?.stop()),
        listen<ErrorPayload>("nim://error", (e) => {
          stageRef.current?.setEmotion?.("sad", 0.5);
          bubbleReply(e.payload.message, "idle"); dismissLater();
        }),
      ]);
      if (disposed) listeners.forEach((off) => off());
      else un = listeners;
    })().catch((e) => setVoiceStatus(String(e)));
    return () => {
      disposed = true;
      un.forEach((off) => off());
      document.body.classList.remove("companion");
    };
  }, [isCompanion]);

  useEffect(() => {
    if (!showSettings) return;
    let disposed = false;
    invoke<VoicevoxStatus>("cmd_voicevox_status").then((status) => {
      if (!disposed) setVoicevox(status);
    }).catch((e) => { if (!disposed) setVoiceStatus(String(e)); });
    return () => { disposed = true; };
  }, [showSettings]);

  const testVoice = () => {
    setVoiceStatus("Menyiapkan suara…");
    speechRef.current?.speak("こんにちは。今日もあなたとお話しできてうれしいです。").then(() => {
      setVoiceStatus("");
    }).catch((e) => setVoiceStatus(String(e)));
  };

  // ---- chat streaming ----
  const doSend = useCallback(
    async (text: string) => {
      if (!text.trim() || streaming) return;
      await invoke("cmd_stop_listening").catch(() => {});
      speechRef.current?.stop();
      const { emit } = await import("@tauri-apps/api/event");
      await emit("avatar://stop-speech");
      const id = `${isCompanion ? "companion" : "main"}-${Date.now()}-${++idRef.current}`;
      setStreamId(id);
      setStreaming(true);
      setMessages((m) => [...m, { role: "user", text }, { role: "assistant", text: "" }]);

      let unlisten: Awaited<ReturnType<typeof listenChatEvents>> | null = null;
      const off = async () => {
        unlisten?.forEach((u) => u());
        unlisten = null;
      };

      const onChunk = (p: ChunkPayload) => {
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: "assistant", text: p.text };
          return copy;
        });
      };
      const onDone = (p: DonePayload) => {
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = {
            role: "assistant",
            text: p.text,
            emo: parseEmotion(p.emo),
          };
          return copy;
        });
        const emo = parseEmotion(p.emo);
        if (emo) {
          setEmotion({ primary: emo.primary ?? "neutral", intensity: emo.intensity ?? 0 });
          stageRef.current?.setEmotion?.(emo.primary ?? "neutral", emo.intensity ?? 0);
          stageRef.current?.gesture?.(emo.gesture ?? "none");
        }
        commitTurn(text, p.text);
        setStreaming(false);
        off();
      };
      const onError = (p: ErrorPayload) => {
        if (isCompanion) { bubbleReply(p.message, "idle"); dismissLater(); }
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = {
            role: "assistant",
            text: `⚠ ${p.message}`,
          };
          return copy;
        });
        setStreaming(false);
        off();
      };

      try {
        unlisten = await listenChatEvents(id, {
          onChunk,
          onDone,
          onError,
          onCancelled: () => {
            setStreaming(false);
            off();
          },
        });

        await sendChat(id, text);
      } catch (e) {
        onError({ id, message: String(e) } as ErrorPayload);
      }
    },
    [streaming, isCompanion],
  );

  const voice = useVoiceInput((text) => {
    setInput("");
    void doSend(text).catch((e) => { setVoiceStatus(String(e)); setShowControls(true); });
  }, (message) => { setVoiceStatus(message); setShowControls(true); });

  const startVoice = async () => {
    if (voiceStartPending.current) return;
    voiceStartPending.current = true;
    setVoiceStarting(true);
    setVoiceStatus("");
    // Unlock output during the click, but recording must not wait for WebKit playback.
    void speechRef.current?.unlock().catch(() => {});
    speechRef.current?.stop();
    try {
      if (streamId && streaming) await cancelChat(streamId);
      const { emit } = await import("@tauri-apps/api/event");
      await emit("avatar://stop-speech");
      await voice.start();
    } catch (e) {
      setVoiceStatus(String(e));
      setShowControls(true);
    } finally {
      voiceStartPending.current = false;
      setVoiceStarting(false);
    }
  };

  const microphoneButton = <MicrophoneButton active={voice.active} pending={voiceStarting}
    onClick={() => { if (voice.active) void voice.stop(); else void startVoice(); }} />;

  const refreshVoicevox = async () => {
    try {
      const status = await invoke<VoicevoxStatus>("cmd_voicevox_status");
      setVoicevox(status);
      setVoiceStatus(`VOICEVOX terhubung: ${status.selected_name}`);
    } catch (e) { setVoicevox(null); setVoiceStatus(String(e)); }
  };

  const cancel = useCallback(() => {
    speechRef.current?.stop();
    if (streamId) cancelChat(streamId);
  }, [streamId]);

  const saveSettings = async (patch: Partial<Settings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveSettingsCmd(next);
  };

  const connect = async () => {
    setConnStatus("testing…");
    try {
      if (apiKeyInput.trim()) {
        await setApiKeyCmd(apiKeyInput.trim());
        setApiKeyInput("");
        setKeyPresent(true);
      }
      setConnStatus(await testConnection());
    } catch (e) {
      setConnStatus(`✗ ${e}`);
    }
  };

  const switchModel = async (url: string) => {
    await saveSettings({ live2d_model_url: url, avatar_kind: "live2d" });
    setAvatarStatus("companion");
  };

  const triggerExpr = (name: string) => stageRef.current?.setExpression?.(name, 4000);

  // ---- render ----
  if (isCompanion) {
    return (
      <div className="app companion" onContextMenu={(e) => {
        e.preventDefault(); setShowControls((value) => !value);
      }} onKeyDown={(e) => { if (e.key === "Escape") setShowControls(false); }}>
        <div className="stage" onDoubleClick={() => setShowControls((value) => !value)}>
          <div className="avatar-surface" key={avatarAttempt}>
            <canvas ref={canvasRef} className="avatar-canvas" />
            <div className="drag-region" data-tauri-drag-region title="Seret untuk memindahkan. Klik kanan untuk kontrol." />
          </div>
          {avatarStatus !== "ready" && <div className="avatar-notice" role="status">
            <span>{avatarStatus}</span>
            {avatarStatus.startsWith("error:") && <button onClick={() => setAvatarAttempt((n) => n + 1)}>Muat ulang avatar</button>}
          </div>}
          {replyVisible && reply && <div className="reply-bubble" role="status" aria-live="polite">
            <button className="reply-dismiss" aria-label="Tutup jawaban" onClick={() => setReplyVisible(false)}>×</button>
            <span className="reply-label">{speaking ? "Sedang berbicara" : "Vivian"}</span>
            <div className="reply-text">{reply}</div>
          </div>}
          {voice.active && <div className="microphone-status" role="status">
            <span className="recording-dot" />
            <span>{voice.status}</span>
            {voice.transcript && <p>{voice.transcript}</p>}
            {microphoneButton}
          </div>}
          {showControls && <nav className="companion-menu" aria-label="Kontrol avatar">
            <button onClick={() => { setShowControls(false); }}>Tutup kontrol</button>
            <button onClick={() => openSettings().catch((e) => setVoiceStatus(String(e)))}>Pengaturan & chat</button>
            <button onClick={testVoice}>Tes suara</button>
            {microphoneButton}
            <p className="muted">Pengenalan ucapan memakai Apple dan dapat diproses online. Teks dikirim ke NVIDIA untuk dijawab.</p>
            <button onClick={() => speechRef.current?.stop()}>Hentikan suara</button>
            <button onClick={() => stageRef.current?.gesture?.("nod")}>Mengangguk</button>
            {exprInfo.expressions.map((name) => <button key={name} onClick={() => triggerExpr(name)}>{name}</button>)}
            <button onClick={() => closeCompanion().catch((e) => setVoiceStatus(String(e)))}>Sembunyikan avatar</button>
            {voiceStatus && <p role="status">{voiceStatus}</p>}
            {avatarStatus !== "ready" && <p role="status">Avatar: {avatarStatus}</p>}
          </nav>}
          {showControls && <div className="companion-chat">

            {streaming && <div className="typing">…</div>}
            <div className="composer">
              <textarea
                rows={1}
                value={input}
                placeholder={streaming ? "…" : "Ngobrol sama Vivian…"}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    const t = input;
                    setInput("");
                    doSend(t);
                  }
                }}
              />
              {streaming ? (
                <button className="danger" onClick={cancel}>
                  ■
                </button>
              ) : (
                <button
                  className="primary"
                  onClick={() => {
                    const t = input;
                    setInput("");
                    doSend(t);
                  }}
                >
                  ➤
                </button>
              )}
            </div>
          </div>}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <main className="stage-pane">
        <header className="topbar">
          <span className={`status-dot ${avatarStatus === "ready" ? "ok" : ""}`} />
          <span>Avatar: {avatarStatus}</span>
          <span className="spacer" />
          <span>
            emotion: {emotion.primary} ({emotion.intensity.toFixed(2)})
          </span>
          <button className="ghost" onClick={() => openCompanion().catch(String)}>
            🪄 Companion
          </button>
          <button className="ghost" onClick={() => setShowSettings((v) => !v)}>
            ⚙ Settings
          </button>
        </header>
        <div className="stage control-stage">
          <p>Avatar tampil di jendela companion.</p>
          <button onClick={() => openCompanion().catch((e) => setVoiceStatus(String(e)))}>Tampilkan avatar</button>
        </div>
      </main>

      <aside className="chat-pane">
        <div className="messages">
          {messages.length === 0 && (
            <div className="hint">
              Talk to your companion. Requires an NVIDIA NIM API key in Settings.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.text}
              {m.emo && (
                <div className="emo-tag">
                  {m.emo.primary} · {m.emo.gesture} · {m.emo.expression}
                </div>
              )}
            </div>
          ))}
          {streaming && <div className="typing">streaming…</div>}
        </div>
        {voiceStatus && <div className="voice-transcript" role="status">{voiceStatus}</div>}
        {voice.active && <div className="voice-transcript" role="status">● {voice.status} {voice.transcript}</div>}
        <div className="composer">
          {microphoneButton}
          <textarea
            value={input}
            placeholder={streaming ? "Wait or interrupt…" : "Type a message (Enter to send)"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const t = input;
                setInput("");
                doSend(t);
              }
            }}
          />
          {streaming ? (
            <button className="danger" onClick={cancel}>
              Stop
            </button>
          ) : (
            <>
              <button
                className="ghost"
                title="Clear conversation"
                onClick={() => {
                  setMessages([]);
                  clearHistory().catch(String);
                }}
              >
                Clear
              </button>
              <button
                className="primary"
                onClick={() => {
                  const t = input;
                  setInput("");
                  doSend(t);
                }}
              >
                Send
              </button>
            </>
          )}
        </div>
      </aside>

      {showSettings && settings && (
        <div className="settings-drawer">
          <button onClick={() => setShowSettings(false)}>Tutup pengaturan</button>
          <h3>Suara</h3>
          <label>Mesin suara
            <select value={settings.speech_provider ?? "voicevox"} onChange={(e) => saveSettings({ speech_provider: e.target.value as Settings["speech_provider"] })}>
              <option value="voicevox">VOICEVOX lokal</option>
              <option value="system">Suara sistem</option>
            </select>
          </label>
          <button onClick={refreshVoicevox}>Hubungkan / refresh VOICEVOX</button>
          {voicevox && <>
            <p className="muted">Aktif: {voicevox.selected_name}. {voicevox.source}</p>
            <label>Karakter & style
              <select value={settings.voicevox_style_id ?? "auto"} onChange={async (e) => {
                const id = e.target.value === "auto" ? null : Number(e.target.value);
                await saveSettings({ voicevox_style_id: id });
                await refreshVoicevox();
              }}>
                <option value="auto">Otomatis: default tersimpan VOICEVOX</option>
                {voicevox.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
          </>}
          <p className="muted">Seleksi aktif editor tidak tersedia lewat API VOICEVOX. Mode otomatis membaca default tersimpan setiap kali bicara. Pelafalan mengikuti dukungan bahasa VOICEVOX.</p>
          <h3>Input suara</h3>
          <p className="muted">Tekan ikon mikrofon untuk satu ucapan bahasa Indonesia. Setelah jeda, teks otomatis dikirim ke AI. Apple dapat memproses audio online; teks dikirim ke NVIDIA. Mikrofon berhenti sebelum jawaban dibacakan.</p>
          <button onClick={testVoice}>Tes suara</button>
          <button onClick={() => speechRef.current?.stop()}>Hentikan</button>
          {voiceStatus && <p role="status">{voiceStatus}</p>}
          <h3>AI Settings</h3>
          <label>
            NVIDIA API key
            <input
              type="password"
              value={apiKeyInput}
              placeholder={keyPresent ? "••• stored in Keychain" : "nvapi-..."}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
          </label>
          <button onClick={connect}>Save key & test connection</button>
          {connStatus && <p className="conn">{connStatus}</p>}

          <label>
            Model
            <input
              value={settings.nvidia_model}
              onChange={(e) => saveSettings({ nvidia_model: e.target.value })}
            />
          </label>
          <label>
            Temperature {settings.temperature.toFixed(2)}
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={settings.temperature}
              onChange={(e) => saveSettings({ temperature: +e.target.value })}
            />
          </label>
          <label>
            Max tokens
            <input
              type="number"
              value={settings.max_tokens}
              onChange={(e) => saveSettings({ max_tokens: +e.target.value })}
            />
          </label>

          <h3>Avatar</h3>
          <div className="row">
            <button
              className={settings.avatar_kind === "live2d" ? "primary" : ""}
              onClick={() => {
                saveSettings({ avatar_kind: "live2d" }).then(() => location.reload());
              }}
            >
              Live2D
            </button>
            <button
              className={settings.avatar_kind === "vrm" ? "primary" : ""}
              onClick={() => {
                saveSettings({ avatar_kind: "vrm" }).then(() => location.reload());
              }}
            >
              VRM (three.js)
            </button>
          </div>
          <label>
            Live2D model
            <select
              value={settings.live2d_model_url ?? ""}
              onChange={(e) => switchModel(e.target.value)}
            >
              <option value="models/Vivian/Vivian.model3.json">Vivian (薇薇安)</option>
              <option value="models/Nicole/Nicole.model3.json">Nicole</option>
            </select>
          </label>

          <h3>Expressions (debug)</h3>
          <div className="expr-grid">
            {exprInfo.expressions.map((name) => (
              <button key={name} className="ghost" onClick={() => triggerExpr(name)}>
                {name}
              </button>
            ))}
          </div>
          <p className="muted">Motions: {exprInfo.motions.join(", ") || "none"}</p>
        </div>
      )}
    </div>
  );
}
