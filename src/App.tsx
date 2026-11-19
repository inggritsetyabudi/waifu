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
import { reactionFor, type TouchRegion } from "./avatar/touch";
import { ProactiveCompanion } from "./avatar/proactive";
import { TouchResponder, type TouchReply } from "./avatar/touchResponder";
import { IdleCompanion } from "./avatar/idle";
import { useCompanionPreferences } from "./hooks/useCompanionPreferences";
import {
  CompanionPlayground,
  type QuickAction,
} from "./components/CompanionPlayground";
import { withBodyActions, ConversationDirector } from "./avatar/conversation";
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
    actions?: { speech_ja?: string; [key: string]: unknown }[];
    [key: string]: unknown;
  } | null;
}
/** Common capability surface shared by Live2DStage and VRMStage. */
interface AvatarStage {
  setReducedMotion?(enabled: boolean): void;
  setListening?(enabled:boolean):void;
  setAffectionateMode?(enabled: boolean): void;
  setEmotion?(primary: string, intensity: number, durationMs?: number): void;
  setSemanticExpression?(name: string, durationMs?: number): void;
  pose?(name: string, durationMs?: number): void;
  setExpression?(name: string, durationMs?: number): void;
  playMotion?(group: string): void;
  gesture?(g: string, durationMs?: number): void;
  feedLipSync?(level: number): void;
  stopLipSync?(): void;
  resize?(): void;
  destroy?(): void;
  dispose?(): void;
  reactAt?(clientX: number, clientY: number): TouchRegion | null;
}

interface ScreenDraft {
  preview_url: string;
  text: string;
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
  } catch {
    return null;
  }
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<AvatarStage | null>(null);
  const loadedSettings = useRef<Settings | null>(null);
  const isCompanion =
    new URLSearchParams(window.location.search).get("mode") === "companion";

  const [preferences, setPreferences] = useCompanionPreferences();
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [replyPinned, setReplyPinned] = useState(false);
  const pinnedRef = useRef(false);
  const latestReply = useRef<DonePayload | null>(null);
  const [utilityNotice, setUtilityNotice] = useState("");
  const [tapBurst, setTapBurst] = useState<{
    x: number;
    y: number;
    symbol: string;
    id: number;
  } | null>(null);
  const tapVoiceAt = useRef(0);
  const touchResponderRef = useRef<TouchResponder | null>(null);
  const touchOutput = useRef(false);
  const touchBlocked = useRef(true);
  const [touchThinking, setTouchThinking] = useState(false);
  const [screenDraft, setScreenDraft] = useState<ScreenDraft | null>(null);
  const [capturingScreen, setCapturingScreen] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [replyBusy, setReplyBusy] = useState(false);
  const [proactiveThinking, setProactiveThinking] = useState(false);
  const [touchLabel, setTouchLabel] = useState("");
  const [touchWarning, setTouchWarning] = useState(false);
  const touchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const pointerStart = useRef<{
    x: number;
    y: number;
    dragged: boolean;
  } | null>(null);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [voiceStarting, setVoiceStarting] = useState(false);
  const voiceStartPending = useRef(false);
  const [voicevox, setVoicevox] = useState<VoicevoxStatus | null>(null);
  const [reply, setReply] = useState("");
  const [replySide, setReplySide] = useState<"left" | "right">("left");
  const bubbleTurn = useRef("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [replyVisible, setReplyVisible] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const replyPhase = useRef<"streaming" | "preparing" | "speaking" | "idle">(
    "idle",
  );
  const bubbleReply = (
    text: string,
    phase: typeof replyPhase.current,
    turnId?: string,
  ) => {
    if (turnId && turnId !== bubbleTurn.current) {
      bubbleTurn.current = turnId;
      setReplySide(Math.random() < 0.5 ? "left" : "right");
    }
    clearTimeout(replyTimer.current);
    replyPhase.current = phase;
    setReply(text);
    setReplyVisible(Boolean(text));
  };
  const dismissLater = () => {
    clearTimeout(replyTimer.current);
    if (!pinnedRef.current)
      replyTimer.current = setTimeout(() => setReplyVisible(false), 15000);
  };
  const speechRef = useRef<AvatarSpeech | null>(null);
  const directorRef = useRef<ConversationDirector | null>(null);
  const idleRef = useRef<IdleCompanion | null>(null);
  const proactiveRef = useRef<ProactiveCompanion | null>(null);
  const proactiveBlocked = useRef(true);
  const pauseVoiceRef = useRef<() => Promise<void>>(async () => {});
  const remoteThinking = useRef(false);
  const [idleStatus, setIdleStatus] = useState("");
  const handledReplies = useRef(new Set<string>());
  const [actionStatus, setActionStatus] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyPresent, setKeyPresent] = useState(false);
  const [connStatus, setConnStatus] = useState<string>("");
  const [avatarStatus, setAvatarStatus] = useState("init");
  const [avatarAttempt, setAvatarAttempt] = useState(0);
  const [exprInfo, setExprInfo] = useState<ExprInfo>({
    expressions: [],
    motions: [],
  });
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [emotion, setEmotion] = useState<{
    primary: string;
    intensity: number;
  }>({
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
      if (isCompanion)
        void invoke("cmd_report_avatar_status", { status }).catch(() => {});
    };
    (async () => {
      let s: Settings | null = null;
      try {
        s = await getSettings();
        loadedSettings.current = s;
        setSettings(s);
        if (!isCompanion)
          void hasApiKey()
            .then((present) => {
              if (!disposed) setKeyPresent(present);
            })
            .catch(() => {});
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
          stage.setReducedMotion(preferencesRef.current.reducedMotion);
          stage.setAffectionateMode(
            loadedSettings.current?.affectionate_mode ?? false,
          );
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
    const speech = new AvatarSpeech(
      (level) => {
        if (level === 0) stageRef.current?.stopLipSync?.();
        else stageRef.current?.feedLipSync?.(level);
      },
      (active) => {
        setSpeaking(active);
        if (active) {
          replyPhase.current = "speaking";
          clearTimeout(replyTimer.current);
        } else if (replyPhase.current === "speaking") {
          replyPhase.current = "idle";
          dismissLater();
        }
      },
    );
    speechRef.current = speech;
    const director = new ConversationDirector(
      () => stageRef.current,
      (text) =>
        preferencesRef.current.voiceEnabled
          ? speech.speak(text)
          : Promise.resolve(),
      setActionStatus,
    );
    directorRef.current = director;
    return () => {
      director.cancel();
      directorRef.current = null;
      speech.destroy();
      speechRef.current = null;
      clearTimeout(replyTimer.current);
    };
  }, []);

  // The companion owns speech even when a reply was requested in the control panel.
  useEffect(() => {
    if (!isCompanion) return;
    document.body.classList.add("companion");
    let disposed = false;
    let un: Array<() => void> = [];
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const listeners = await Promise.all([
        listen<ChunkPayload>("nim://chunk", (e) => {
          proactiveRef.current?.interrupt();
          touchResponderRef.current?.cancel();
          remoteThinking.current = true;
          idleRef.current?.interrupt();
          if (e.payload.text)
            bubbleReply(e.payload.text, "streaming", e.payload.id);
        }),
        listen<DonePayload>("nim://done", (e) => {
          proactiveRef.current?.interrupt();
          touchResponderRef.current?.cancel();
          touchOutput.current = false;
          remoteThinking.current = false;
          idleRef.current?.interrupt();
          if (handledReplies.current.has(e.payload.id)) return;
          latestReply.current = e.payload;
          handledReplies.current.add(e.payload.id);
          if (handledReplies.current.size > 40)
            handledReplies.current.delete(
              handledReplies.current.values().next().value!,
            );
          if (e.payload.text.trim()) {
            bubbleReply(e.payload.text, "preparing", e.payload.id);
            const metadata = parseEmotion(e.payload.emo);
            if (
              preferencesRef.current.voiceEnabled &&
              !e.payload.speech_text?.trim() &&
              !(
                Array.isArray(metadata?.actions) &&
                metadata.actions.some((action) => Boolean(action?.speech_ja))
              )
            ) {
              replyPhase.current = "idle";
              dismissLater();
              setVoiceStatus(
                "AI belum menghasilkan ucapan Jepang. Jawaban Indonesia tetap ditampilkan.",
              );
            }
            setReplyBusy(true);
            directorRef.current
              ?.run(withBodyActions(metadata), e.payload.speech_text)
              .finally(() => setReplyBusy(false))
              .then(() => {
                if (replyPhase.current !== "speaking") dismissLater();
              })
              .catch((e) => {
                replyPhase.current = "idle";
                dismissLater();
                setVoiceStatus(String(e));
                setShowControls(true);
              });
          }
        }),
        listen<Settings>("settings://changed", (e) => {
          const previous = loadedSettings.current;
          const next = e.payload;
          if (
            previous &&
            (previous.avatar_kind !== next.avatar_kind ||
              previous.live2d_model_url !== next.live2d_model_url ||
              previous.vrm_model_url !== next.vrm_model_url ||
              previous.avatar_scale !== next.avatar_scale)
          )
            window.location.reload();
          loadedSettings.current = next;
          setSettings(next);
          stageRef.current?.setAffectionateMode?.(
            next.affectionate_mode ?? false,
          );
        }),
        listen("nim://cancelled", () => {
          remoteThinking.current = false;
          idleRef.current?.interrupt();
          directorRef.current?.cancel();
          speechRef.current?.stop();
        }),
        listen("avatar://stop-speech", () => {
          proactiveRef.current?.interrupt();
          touchResponderRef.current?.cancel();
          touchOutput.current = false;
          idleRef.current?.interrupt();
          directorRef.current?.cancel();
          speechRef.current?.stop();
        }),
        listen<ErrorPayload>("nim://error", (e) => {
          remoteThinking.current = false;
          idleRef.current?.interrupt();
          directorRef.current?.cancel();
          stageRef.current?.setEmotion?.("sad", 0.5);
          bubbleReply(e.payload.message, "idle", e.payload.id);
          dismissLater();
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
    invoke<VoicevoxStatus>("cmd_voicevox_status")
      .then((status) => {
        if (!disposed) setVoicevox(status);
      })
      .catch((e) => {
        if (!disposed) setVoiceStatus(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [showSettings]);

  const testVoice = () => {
    setPreferences({ voiceEnabled: true });
    setVoiceStatus("Menyiapkan suara…");
    speechRef.current
      ?.speak("こんにちは。今日もあなたとお話しできてうれしいです。")
      .then(() => {
        setVoiceStatus("");
      })
      .catch((e) => setVoiceStatus(String(e)));
  };

  // ---- chat streaming ----
  const doSend = useCallback(
    async (text: string, screenText?: string) => {
      if (!text.trim() || streaming) return;
      proactiveRef.current?.interrupt();
      touchResponderRef.current?.cancel();
      touchOutput.current = false;
      await invoke("cmd_stop_listening").catch(() => {});
      speechRef.current?.stop();
      const { emit } = await import("@tauri-apps/api/event");
      await emit("avatar://stop-speech");
      const id = `${isCompanion ? "companion" : "main"}-${Date.now()}-${++idRef.current}`;
      setStreamId(id);
      setStreaming(true);
      if (isCompanion) setReplyVisible(false);
      setMessages((m) => [
        ...m,
        { role: "user", text },
        { role: "assistant", text: "" },
      ]);

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
          setEmotion({
            primary: emo.primary ?? "neutral",
            intensity: emo.intensity ?? 0,
          });
        }
        commitTurn(text, p.text);
        setStreaming(false);
        off();
      };
      const onError = (p: ErrorPayload) => {
        if (isCompanion) {
          bubbleReply(p.message, "idle", p.id);
          dismissLater();
        }
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

        await sendChat(id, text, screenText);
        return true;
      } catch (e) {
        onError({ id, message: String(e) } as ErrorPayload);
        return false;
      }
    },
    [streaming, isCompanion],
  );

  const voice = useVoiceInput(
    (text) => {
      setInput("");
      void doSend(text).catch((e) => {
        setVoiceStatus(String(e));
        setShowControls(true);
      });
    },
    (message) => {
      setVoiceStatus(message);
    },
    streaming ||
      speaking ||
      replyBusy ||
      Boolean(actionStatus) ||
      capturingScreen ||
      Boolean(screenDraft) ||
      proactiveThinking ||
      touchThinking,
  );

  const startVoice = async () => {
    if (voiceStartPending.current) return;
    proactiveRef.current?.interrupt();
    touchResponderRef.current?.cancel();
    touchOutput.current = false;
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

  pauseVoiceRef.current = voice.pause;

  const microphoneButton = (
    <MicrophoneButton
      active={voice.enabled}
      pending={voiceStarting}
      onClick={() => {
        if (voice.enabled) void voice.stop();
        else void startVoice();
      }}
    />
  );

  const refreshVoicevox = async () => {
    try {
      const status = await invoke<VoicevoxStatus>("cmd_voicevox_status");
      setVoicevox(status);
      setVoiceStatus(`VOICEVOX terhubung: ${status.selected_name}`);
    } catch (e) {
      setVoicevox(null);
      setVoiceStatus(String(e));
    }
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

  const connect = async (persist: boolean) => {
    setConnStatus("testing…");
    try {
      if (apiKeyInput.trim()) {
        await setApiKeyCmd(apiKeyInput.trim(), persist);
        setApiKeyInput("");
        setKeyPresent(true);
      }
      setConnStatus(await testConnection());
      setKeyPresent(await hasApiKey());
    } catch (e) {
      setConnStatus(`✗ ${e}`);
    }
  };

  const switchModel = async (url: string) => {
    await saveSettings({ live2d_model_url: url, avatar_kind: "live2d" });
    setAvatarStatus("companion");
  };

  const triggerExpr = (name: string) => {
    directorRef.current?.cancel();
    stageRef.current?.setExpression?.(name, 4000);
  };
  const triggerGesture = (name: string) => {
    directorRef.current?.cancel();
    stageRef.current?.gesture?.(name);
  };

  useEffect(() => () => clearTimeout(touchTimer.current), []);
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    pointerStart.current = {
      x: event.clientX,
      y: event.clientY,
      dragged: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current;
    if (
      !start ||
      start.dragged ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) < 7
    )
      return;
    start.dragged = true;
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().startDragging())
      .catch(() => {});
  };
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start || start.dragged || event.button !== 0) return;
    const region = stageRef.current?.reactAt?.(event.clientX, event.clientY);
    if (!region) return;
    if (region === "sensitive") {
      directorRef.current?.cancel(false);
      speechRef.current?.stop();
      touchOutput.current = true;
      touchBlocked.current =
        voice.state === "authorizing" ||
        Boolean(voice.transcript) ||
        streaming ||
        capturingScreen ||
        Boolean(screenDraft);
    } else if (!touchBlocked.current) {
      directorRef.current?.cancel(false);
      if (touchOutput.current) speechRef.current?.stop();
    }
    const reaction = reactionFor(region, settings?.affectionate_mode ?? false);
    setTouchLabel(reaction.label);
    setTapBurst({
      x: event.clientX,
      y: event.clientY,
      symbol: reaction.symbol,
      id: Date.now(),
    });
    if (preferences.aiTouchEnabled) touchResponderRef.current?.touch(region);
    else if (
      preferences.voiceEnabled &&
      preferences.touchSounds &&
      !speaking &&
      !streaming &&
      !voice.active &&
      Date.now() - tapVoiceAt.current > 2500
    ) {
      tapVoiceAt.current = Date.now();
      void speechRef.current
        ?.speak(reaction.speech_ja)
        .catch((e) => setVoiceStatus(String(e)));
    }
    setTouchWarning(region === "sensitive");
    clearTimeout(touchTimer.current);
    touchTimer.current = setTimeout(
      () => setTouchLabel(""),
      region === "sensitive" ? 4000 : 2200,
    );
  };

  const captureScreen = async () => {
    touchResponderRef.current?.cancel();
    touchOutput.current = false;
    proactiveRef.current?.interrupt();
    setCapturingScreen(true);
    setVoiceStatus("");
    directorRef.current?.cancel();
    speechRef.current?.stop();
    await voice.pause();
    try {
      const draft = await invoke<ScreenDraft | null>("cmd_capture_screen");
      if (draft) setScreenDraft(draft);
    } catch (e) {
      setVoiceStatus(String(e));
    } finally {
      setCapturingScreen(false);
    }
  };
  const sendComposer = async () => {
    if (streaming) return;
    const text =
      input.trim() ||
      (screenDraft
        ? "Jelaskan isi layar ini dan bantu langkah berikutnya."
        : "");
    if (!text) return;
    if (screenDraft && !screenDraft.text.trim()) {
      setVoiceStatus(
        "Tidak ada teks yang terbaca. Isi konteks layar atau pilih area lain.",
      );
      return;
    }
    const accepted = await doSend(text, screenDraft?.text);
    if (accepted) {
      setInput("");
      setScreenDraft(null);
    }
  };
  const screenButton = (
    <button
      type="button"
      className="icon-button"
      title="Bantu layar Mac"
      aria-label="Bantu layar Mac"
      disabled={capturingScreen || streaming}
      onClick={() => void captureScreen()}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="13" rx="3" />
        <path d="M8 21h8m-4-4v4M7 8h4m-4 4h8" />
      </svg>
    </button>
  );

  useEffect(() => {
    stageRef.current?.setReducedMotion?.(preferences.reducedMotion);
  }, [preferences.reducedMotion]);
  useEffect(() => {
    stageRef.current?.setAffectionateMode?.(
      settings?.affectionate_mode ?? false,
    );
  }, [settings?.affectionate_mode]);
  useEffect(() => {
    if (!preferences.voiceEnabled) speechRef.current?.stop();
  }, [preferences.voiceEnabled]);
  useEffect(() => {
    if (!utilityNotice) return;
    const timer = setTimeout(() => setUtilityNotice(""), 2400);
    return () => clearTimeout(timer);
  }, [utilityNotice]);
  useEffect(() => {
    if (!tapBurst) return;
    const timer = setTimeout(() => setTapBurst(null), 850);
    return () => clearTimeout(timer);
  }, [tapBurst]);
  const idleBlocked = useRef(true);
  idleBlocked.current =
    touchThinking ||
    !preferences.idleEnabled ||
    avatarStatus !== "ready" ||
    (voice.active && Boolean(voice.transcript)) ||
    voiceStarting ||
    streaming ||
    speaking ||
    Boolean(actionStatus) ||
    capturingScreen ||
    Boolean(screenDraft) ||
    replyBusy ||
    proactiveThinking ||
    showControls ||
    showComposer ||
    showSettings ||
    Boolean(input.trim());
  useEffect(() => {
    if (!isCompanion) return;
    const idle = new IdleCompanion(() => stageRef.current, setIdleStatus);
    idleRef.current = idle;
    if (import.meta.env.DEV) (window as any).__idle = idle;
    const interrupt = () =>
      idle.interrupt(Date.now(), preferencesRef.current.reducedMotion);
    const timer = setInterval(
      () =>
        idle.tick(
          Date.now(),
          idleBlocked.current || remoteThinking.current || document.hidden,
          loadedSettings.current?.affectionate_mode ?? false,
          preferencesRef.current.reducedMotion,
        ),
      250,
    );
    document.addEventListener("pointerdown", interrupt, true);
    document.addEventListener("keydown", interrupt, true);
    document.addEventListener("visibilitychange", interrupt);
    return () => {
      clearInterval(timer);
      idle.interrupt();
      idleRef.current = null;
      document.removeEventListener("pointerdown", interrupt, true);
      document.removeEventListener("keydown", interrupt, true);
      document.removeEventListener("visibilitychange", interrupt);
      if (import.meta.env.DEV) delete (window as any).__idle;
    };
  }, [isCompanion]);

  touchBlocked.current =
    voice.state === "authorizing" ||
    Boolean(voice.transcript) ||
    voiceStarting ||
    streaming ||
    replyBusy ||
    proactiveThinking ||
    capturingScreen ||
    Boolean(screenDraft) ||
    ((speaking || Boolean(actionStatus)) && !touchOutput.current);
  useEffect(() => {
    if (!isCompanion) return;
    const responder = new TouchResponder(
      (id, context) =>
        invoke<TouchReply>("cmd_touch_reaction", { id, context }),
      (id) => {
        void cancelChat(id).catch(() => {});
      },
      () =>
        touchBlocked.current ||
        remoteThinking.current ||
        !preferencesRef.current.aiTouchEnabled,
      (reply, region) => {
        idleRef.current?.interrupt();
        const id = `touch-reply-${Date.now()}`;
        latestReply.current = { id, ...reply };
        setVoiceStatus(
          preferencesRef.current.touchSounds &&
            preferencesRef.current.voiceEnabled &&
            !reply.speech_text
            ? "AI belum menghasilkan ucapan Jepang. Balasan sentuhan tetap ditampilkan."
            : "",
        );
        bubbleReply(reply.text, "preparing", latestReply.current?.id);
        touchOutput.current = true;
        const meta = parseEmotion(reply.emo);
        // Touch speech follows its own switch. Keep a single short response.
        const metadata =
          region === "sensitive"
            ? {
                primary: "angry",
                expression: "serious",
                gesture: "shake",
                intensity: 1,
                duration_ms: 3500,
              }
            : meta
              ? {
                  primary: meta.primary,
                  expression: meta.expression,
                  gesture: meta.gesture,
                  intensity: meta.intensity,
                  duration_ms: meta.duration_ms,
                }
              : null;
        void directorRef.current
          ?.run(
            withBodyActions(metadata),
            preferencesRef.current.touchSounds ? reply.speech_text : null,
          )
          .catch((error) => setVoiceStatus(String(error)))
          .finally(() => {
            if (latestReply.current?.id === id) {
              touchOutput.current = false;
              dismissLater();
            }
          });
      },
      (message) => {
        setVoiceStatus(message);
      },
      setTouchThinking,
    );
    touchResponderRef.current = responder;
    return () => {
      responder.cancel();
      touchResponderRef.current = null;
    };
  }, [isCompanion]);
  useEffect(() => {
    touchResponderRef.current?.cancel();
  }, [settings?.affectionate_mode, preferences.aiTouchEnabled]);

  proactiveBlocked.current =
    !preferences.idleEnabled ||
    !preferences.idleChatter ||
    !preferences.voiceEnabled ||
    avatarStatus !== "ready" ||
    voiceStarting ||
    Boolean(voice.transcript) ||
    streaming ||
    speaking ||
    replyBusy ||
    Boolean(actionStatus) ||
    touchThinking ||
    capturingScreen ||
    Boolean(screenDraft) ||
    showControls ||
    showComposer ||
    showSettings ||
    Boolean(input.trim());
  useEffect(() => {
    if (!isCompanion) return;
    const proactive = new ProactiveCompanion(
      (id, context) => invoke<TouchReply>("cmd_idle_reaction", { id, context }),
      (id) => {
        void cancelChat(id).catch(() => {});
      },
      async (reply, isCurrent) => {
        idleRef.current?.interrupt();
        setReplyBusy(true);
        await pauseVoiceRef.current();
        if (!isCurrent()) {
          setReplyBusy(false);
          return;
        }
        latestReply.current = { id: `idle-reply-${Date.now()}`, ...reply };
        bubbleReply(reply.text, "preparing", latestReply.current?.id);
        try {
          await directorRef.current?.run(
            withBodyActions(parseEmotion(reply.emo)),
            reply.speech_text,
          );
        } catch (error) {
          setVoiceStatus(String(error));
        } finally {
          setReplyBusy(false);
          dismissLater();
        }
      },
      setProactiveThinking,
    );
    proactiveRef.current = proactive;
    if (import.meta.env.DEV) (window as any).__proactive = proactive;
    const interrupt = () => proactive.interrupt();
    const timer = setInterval(
      () =>
        proactive.tick(
          Date.now(),
          proactiveBlocked.current || remoteThinking.current || document.hidden,
        ),
      500,
    );
    document.addEventListener("pointerdown", interrupt, true);
    document.addEventListener("keydown", interrupt, true);
    document.addEventListener("visibilitychange", interrupt);
    return () => {
      clearInterval(timer);
      proactive.interrupt();
      proactiveRef.current = null;
      document.removeEventListener("pointerdown", interrupt, true);
      document.removeEventListener("keydown", interrupt, true);
      document.removeEventListener("visibilitychange", interrupt);
      if (import.meta.env.DEV) delete (window as any).__proactive;
    };
  }, [isCompanion]);

  const stopActivity = () => {
    proactiveRef.current?.interrupt();
    touchResponderRef.current?.cancel();
    touchOutput.current = false;
    idleRef.current?.interrupt();
    directorRef.current?.cancel();
    speechRef.current?.stop();
    if (streaming && streamId) void cancelChat(streamId);
  };
  const playQuickAction = async (action: QuickAction) => {
    await voice.pause();
    stopActivity();
    setUtilityNotice(`Aksi cepat · ${action.title}`);
    try {
      await directorRef.current?.run(action.metadata, null);
    } catch (e) {
      setVoiceStatus(String(e));
    }
  };
  const replayReply = async () => {
    if (!latestReply.current) return;
    await voice.pause();
    stopActivity();
    setPreferences({ voiceEnabled: true });
    preferencesRef.current = { ...preferencesRef.current, voiceEnabled: true };
    try {
      await directorRef.current?.run(
        withBodyActions(parseEmotion(latestReply.current.emo)),
        latestReply.current.speech_text,
      );
    } catch (e) {
      setVoiceStatus(String(e));
    }
  };
  const togglePin = () => {
    pinnedRef.current = !pinnedRef.current;
    setReplyPinned(pinnedRef.current);
    if (pinnedRef.current) clearTimeout(replyTimer.current);
    else dismissLater();
  };
  const copyReply = () => {
    void navigator.clipboard
      .writeText(reply)
      .then(() => setUtilityNotice("Jawaban disalin"))
      .catch(() => setUtilityNotice("Blok teks jawaban untuk menyalinnya"));
  };
  const activity =
    avatarStatus !== "ready"
      ? "Memuat avatar"
      : voice.active
        ? voice.status
        : capturingScreen
          ? "Memilih area layar"
          : streaming
            ? "Sedang berpikir"
            : speaking
              ? "Sedang berbicara"
              : touchThinking
                ? "Menyiapkan reaksi"
                : actionStatus
                  ? "Sedang berekspresi"
                  : idleStatus || "Siap menemani";
  const activityKind = voice.active
    ? "listening"
    : streaming
      ? "thinking"
      : speaking
        ? "speaking"
        : "idle";
  const voiceToggle = (
    <button
      className={`icon-button${!preferences.voiceEnabled ? " selected" : ""}`}
      aria-label={preferences.voiceEnabled ? "Bisukan suara" : "Aktifkan suara"}
      title={preferences.voiceEnabled ? "Bisukan suara" : "Aktifkan suara"}
      aria-pressed={!preferences.voiceEnabled}
      onClick={() =>
        setPreferences({ voiceEnabled: !preferences.voiceEnabled })
      }
    >
      <svg
        width="19"
        height="19"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <path d="M11 4 6 8H3v8h3l5 4V4Z" />
        {preferences.voiceEnabled ? (
          <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
        ) : (
          <path d="m16 9 6 6m0-6-6 6" />
        )}
      </svg>
    </button>
  );

  const effectiveReplySide =
    showControls || showComposer || screenDraft ? "right" : replySide;
  const replyBubble = replyVisible && reply && (
    <div className="reply-bubble bubble-panel" role="status" aria-live="polite">
      <button
        className="reply-dismiss"
        aria-label="Tutup jawaban"
        onClick={() => setReplyVisible(false)}
      >
        ×
      </button>
      <span className="reply-label">
        {speaking ? "Sedang berbicara" : "Vivian"}
      </span>
      <div className="reply-text">{reply}</div>
      <div className="reply-tools">
        <button aria-label="Salin jawaban" onClick={copyReply}>
          Salin
        </button>
        <button
          aria-label="Dengarkan lagi"
          disabled={!latestReply.current}
          onClick={() => void replayReply()}
        >
          Dengarkan
        </button>
        <button
          aria-label={
            replyPinned ? "Lepas sematan jawaban" : "Sematkan jawaban"
          }
          aria-pressed={replyPinned}
          onClick={togglePin}
        >
          {replyPinned ? "Disematkan" : "Sematkan"}
        </button>
      </div>
    </div>
  );
  useEffect(() => {
    if (showComposer) composerRef.current?.focus();
  }, [showComposer]);
  useEffect(() => {
    const input = composerRef.current;
    if (input) {
      input.style.height = "0px";
      input.style.height = `${Math.max(68, Math.min(144, input.scrollHeight))}px`;
    }
  }, [input, showComposer]);

  // ---- render ----
  if (isCompanion) {
    return (
      <div
        className="app companion"
        onContextMenu={(e) => {
          if (
            (e.target as HTMLElement).closest(
              ".companion-rail,.reply-lane,.companion-dock",
            )
          )
            return;
          e.preventDefault();
          setShowControls((value) => !value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setShowControls(false);
            setShowComposer(false);
          }
        }}
      >
        <div
          className="stage"
          data-activity={activityKind}
          data-reply-side={effectiveReplySide}
        >
          {tapBurst && (
            <span
              key={tapBurst.id}
              className="tap-spark"
              style={{ left: tapBurst.x, top: tapBurst.y }}
              aria-hidden="true"
            >
              {tapBurst.symbol}
            </span>
          )}
          <div className="avatar-surface" key={avatarAttempt}>
            <canvas ref={canvasRef} className="avatar-canvas" />
            <div
              className="drag-region"
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={() => {
                pointerStart.current = null;
              }}
              title="Klik untuk bereaksi, seret untuk memindahkan. Klik kanan untuk kontrol."
            />
          </div>
          <aside className="companion-rail" aria-label="Bubble companion">
            <header hidden className="companion-identity">
              <span className="brand-orbit" aria-hidden="true">
                ✿
              </span>
              <div>
                <strong>
                  Honey<span> / Vivian</span>
                </strong>
                <span className={`activity-label ${activityKind}`}>
                  <i />
                  {activity}
                </span>
              </div>
            </header>
            <div className="rail-content">
              {avatarStatus !== "ready" && (
                <div className="avatar-notice bubble-panel" role="status">
                  <span>{avatarStatus}</span>
                  {avatarStatus.startsWith("error:") && (
                    <button onClick={() => setAvatarAttempt((n) => n + 1)}>
                      Muat ulang avatar
                    </button>
                  )}
                </div>
              )}
              {touchLabel && (
                <div
                  className={`touch-feedback bubble-panel${touchWarning ? " is-warning" : ""}`}
                  role={touchWarning ? "alert" : "status"}
                >
                  {touchLabel}
                </div>
              )}
              {effectiveReplySide === "left" && replyBubble}
              {streaming && !replyVisible && (
                <div className="thinking-bubble bubble-panel" role="status">
                  <span className="thinking-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>{" "}
                  Aku sedang memikirkan jawabanmu…
                </div>
              )}
              {utilityNotice && (
                <div className="utility-notice bubble-panel" role="status">
                  {utilityNotice}
                </div>
              )}
              {showControls && actionStatus && (
                <div className="action-status bubble-panel" role="status">
                  {actionStatus}
                </div>
              )}
              {voice.enabled && (
                <div className="microphone-status bubble-panel" role="status">
                  <span className="recording-dot" />
                  <span>{voice.status}</span>
                  {voice.transcript && <p>{voice.transcript}</p>}
                </div>
              )}
              {capturingScreen && (
                <div className="bubble-panel" role="status">
                  Pilih area layar. Escape untuk batal.
                </div>
              )}
              {screenDraft && (
                <section
                  className="screen-preview bubble-panel"
                  aria-label="Tinjau teks layar"
                >
                  <header>
                    <span>Teks dari layar</span>
                    <button
                      className="ghost"
                      aria-label="Buang tangkapan layar"
                      onClick={() => setScreenDraft(null)}
                    >
                      ×
                    </button>
                  </header>
                  <img
                    src={screenDraft.preview_url}
                    alt="Area layar yang dipilih"
                  />
                  <p>Gambar tetap lokal. Periksa teks sebelum dikirim ke AI.</p>
                  <textarea
                    aria-label="Teks layar untuk AI"
                    value={screenDraft.text}
                    maxLength={20000}
                    onChange={(e) =>
                      setScreenDraft({ ...screenDraft, text: e.target.value })
                    }
                  />
                  <div className="screen-suggestions">
                    {[
                      "Jelaskan error ini",
                      "Bantu langkah berikutnya",
                      "Ringkas teks ini",
                    ].map((text) => (
                      <button key={text} onClick={() => setInput(text)}>
                        {text}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {voiceStatus && (
                <div className="voice-notice bubble-panel" role="status">
                  {voiceStatus}
                </div>
              )}
              {showControls && (
                <nav
                  className="companion-menu bubble-panel"
                  aria-label="Kontrol avatar"
                >
                  <button onClick={() => setShowControls(false)}>
                    Tutup kontrol
                  </button>
                  <button
                    onClick={() =>
                      openSettings().catch((e) => setVoiceStatus(String(e)))
                    }
                  >
                    Pengaturan & chat
                  </button>
                  <div className="compact-tools">
                    {voiceToggle}
                    {screenButton}
                    <button
                      className="icon-button"
                      aria-label="Pengaturan"
                      title="Pengaturan"
                      onClick={() => void openSettings()}
                    >
                      ⚙
                    </button>
                  </div>
                  <details className="companion-extras">
                    <summary>Aksi & kepribadian</summary>
                    <button onClick={testVoice}>Tes suara</button>
                    <button className="stop-activity" onClick={stopActivity}>
                      Hentikan aksi & suara
                    </button>
                    <section className="quick-play">
                      <span className="eyebrow">AKSI CEPAT</span>
                      <CompanionPlayground
                        disabled={streaming}
                        onPlay={(action) => void playQuickAction(action)}
                      />
                    </section>
                    <section className="appearance-controls">
                      <span className="eyebrow">SUASANA</span>
                      <div className="theme-swatches">
                        {(
                          [
                            ["violet", "Lavender"],
                            ["peach", "Senja"],
                            ["mint", "Matcha"],
                          ] as const
                        ).map(([theme, label]) => (
                          <button
                            key={theme}
                            className={`theme-swatch ${theme}`}
                            aria-label={`Tema ${label}`}
                            aria-pressed={preferences.theme === theme}
                            onClick={() => setPreferences({ theme })}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <label className="preference-toggle">
                        <input
                          type="checkbox"
                          checked={settings?.affectionate_mode ?? false}
                          disabled={!settings}
                          onChange={(e) =>
                            void saveSettings({
                              affectionate_mode: e.target.checked,
                            }).catch((error) => setVoiceStatus(String(error)))
                          }
                        />{" "}
                        Mode Manja
                      </label>
                      <label className="preference-toggle">
                        <input
                          type="checkbox"
                          checked={preferences.idleEnabled}
                          onChange={(e) =>
                            setPreferences({ idleEnabled: e.target.checked })
                          }
                        />{" "}
                        Tingkah spontan
                      </label>
                      <small>
                        Obrolan akrab dan sentuhan biasa yang hangat. Area
                        sensitif tetap memicu penolakan tegas.
                      </small>
                      <label className="preference-toggle">
                        <input
                          type="checkbox"
                          checked={preferences.idleChatter}
                          onChange={(e) =>
                            setPreferences({ idleChatter: e.target.checked })
                          }
                        />{" "}
                        Mengobrol sendiri saat sepi
                      </label>
                      <label className="preference-toggle">
                        <input
                          type="checkbox"
                          checked={preferences.aiTouchEnabled}
                          onChange={(e) =>
                            setPreferences({ aiTouchEnabled: e.target.checked })
                          }
                        />{" "}
                        Balasan sentuhan AI
                      </label>
                      <label className="preference-toggle">
                        <input
                          type="checkbox"
                          checked={preferences.touchSounds}
                          onChange={(e) =>
                            setPreferences({ touchSounds: e.target.checked })
                          }
                        />{" "}
                        Suara saat disentuh
                      </label>
                      <label className="preference-toggle">
                        <input
                          type="checkbox"
                          checked={preferences.reducedMotion}
                          onChange={(e) =>
                            setPreferences({ reducedMotion: e.target.checked })
                          }
                        />{" "}
                        Gerakan lebih lembut
                      </label>
                    </section>
                    <details className="avatar-actions">
                      <summary>Aksi & ekspresi</summary>
                      <div className="action-chips">
                        {[
                          ["wave", "Menyapa"],
                          ["nod", "Mengangguk"],
                          ["think", "Berpikir"],
                          ["shrug", "Mengangkat bahu"],
                          ["excited_hands", "Gembira"],
                          ["look_away", "Melirik"],
                        ].map(([action, label]) => (
                          <button
                            key={action}
                            onClick={() => triggerGesture(action)}
                          >
                            {label}
                          </button>
                        ))}
                        {exprInfo.expressions.map((name) => (
                          <button key={name} onClick={() => triggerExpr(name)}>
                            {name}
                          </button>
                        ))}
                      </div>
                    </details>
                  </details>
                  <button
                    onClick={() =>
                      closeCompanion().catch((e) => setVoiceStatus(String(e)))
                    }
                  >
                    Sembunyikan avatar
                  </button>
                </nav>
              )}
            </div>
            {(showComposer || screenDraft) && (
              <div className="companion-chat bubble-panel">
                {streaming && <div className="typing">Menyiapkan jawaban…</div>}
                <header className="message-card-heading">
                  <div>
                    <span className="eyebrow">NGOBROL SEBENTAR</span>
                    <strong>Ada cerita apa?</strong>
                  </div>
                  <button
                    type="button"
                    aria-label="Tutup kolom pesan"
                    onClick={() => {
                      setShowComposer(false);
                      setScreenDraft(null);
                    }}
                  >
                    ×
                  </button>
                </header>
                <div className="message-input-wrap">
                  <textarea
                    ref={composerRef}
                    rows={3}
                    value={input}
                    aria-label="Pesan untuk Vivian"
                    placeholder={
                      screenDraft
                        ? "Mau dibantu apa dari layar ini?"
                        : "Cerita, tanya, atau minta aku beraksi…"
                    }
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void sendComposer();
                      }
                    }}
                  />
                </div>
                <footer className="message-card-footer">
                  <small>
                    Enter untuk kirim
                    <br />
                    Shift + Enter untuk baris baru
                  </small>
                  {streaming ? (
                    <button
                      className="message-send is-stop"
                      onClick={cancel}
                      aria-label="Hentikan jawaban"
                    >
                      ■
                    </button>
                  ) : (
                    <button
                      className="message-send"
                      aria-label={
                        screenDraft ? "Kirim teks layar" : "Kirim pesan"
                      }
                      disabled={!input.trim() && !screenDraft}
                      onClick={() => void sendComposer()}
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m4 4 17 8-17 8 3-8-3-8Zm3 8h14" />
                      </svg>
                    </button>
                  )}
                </footer>
              </div>
            )}
          </aside>
          {effectiveReplySide === "right" && replyVisible && (
            <aside
              className="reply-lane right"
              aria-label="Bubble jawaban kanan"
            >
              {replyBubble}
            </aside>
          )}
          <div
            className="companion-dock bubble-toolbar bubble-panel"
            aria-label="Aksi companion"
          >
            {microphoneButton}
            <button
              className={`icon-button${showComposer ? " selected" : ""}`}
              aria-label="Tulis pesan dan kontrol"
              title="Tulis pesan"
              aria-expanded={showComposer}
              onClick={() => setShowComposer((value) => !value)}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H3V6a2 2 0 0 1 2-2Z" />
                <path d="M7 8h10M7 12h7" />
              </svg>
            </button>
            <button
              className={`icon-button${showControls ? " selected" : ""}`}
              aria-label="Menu companion"
              title="Menu companion"
              aria-expanded={showControls}
              onClick={() => setShowControls((value) => !value)}
            >
              ⋯
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <main className="stage-pane">
        <header className="topbar">
          <strong className="studio-brand">✿ Honey</strong>
          <span className="status-dot ok" />
          <span>Companion desktop</span>
          <span className="spacer" />
          <span>
            emotion: {emotion.primary} ({emotion.intensity.toFixed(2)})
          </span>
          <button
            className="ghost"
            onClick={() => openCompanion().catch(String)}
          >
            🪄 Companion
          </button>
          <button className="ghost" onClick={() => setShowSettings((v) => !v)}>
            ⚙ Settings
          </button>
        </header>
        <div className="stage control-stage">
          <section className="studio-welcome">
            <span className="eyebrow">COMPANION STUDIO</span>
            <h1>
              Teman untuk ide,
              <br />
              obrolan, dan jeda kecil.
            </h1>
            <p>
              Vivian menunggumu di desktop. Atur suaranya, pilih suasananya, dan
              ajak dia melakukan sesuatu.
            </p>
            <div className="studio-buttons">
              <button
                className="primary"
                onClick={() =>
                  openCompanion().catch((e) => setVoiceStatus(String(e)))
                }
              >
                Tampilkan avatar
              </button>
              <button onClick={() => setShowSettings(true)}>
                Atur kepribadian
              </button>
            </div>
            <div className="studio-cards">
              <article>
                <span>01 / NGOBROL</span>
                <h3>Cerita atau cari ide</h3>
                <p>
                  Gunakan teks atau mikrofon. Jawaban tampil dalam bahasa
                  Indonesia, dengan suara Jepang.
                </p>
              </article>
              <article>
                <span>02 / BERMAIN</span>
                <h3>Minta pose & ekspresi</h3>
                <p>
                  Coba “pose malu, lalu kedipkan mata”. Aksi dan suara berjalan
                  berurutan.
                </p>
              </article>
              <article>
                <span>03 / DIBANTU</span>
                <h3>Pahami layar Mac</h3>
                <p>
                  Pilih area layar, periksa teksnya, lalu tanyakan langkah
                  berikutnya.
                </p>
              </article>
            </div>
          </section>
        </div>
      </main>

      <aside className="chat-pane">
        <header className="chat-heading">
          <div>
            <span className="eyebrow">RUANG OBROLAN</span>
            <h2>Kamu & Vivian</h2>
          </div>
          <div className="chat-header-tools">
            <span className="language-badge">ID / 日本語</span>
            <button
              className="icon-button"
              aria-label="Hapus percakapan"
              title="Hapus percakapan"
              onClick={() => {
                setMessages([]);
                void clearHistory().catch((e) => setVoiceStatus(String(e)));
              }}
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                aria-hidden="true"
              >
                <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" />
              </svg>
            </button>
          </div>
        </header>
        <div className="messages">
          {messages.length === 0 && (
            <div className="hint">
              Mulai dengan menyapa atau meminta bantuan. Pastikan NVIDIA_API_KEY
              sudah diisi di .env.
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
        {voiceStatus && (
          <div className="voice-transcript" role="status">
            {voiceStatus}
          </div>
        )}
        {voice.active && (
          <div className="voice-transcript" role="status">
            ● {voice.status} {voice.transcript}
          </div>
        )}
        <div className="composer">
          {microphoneButton}
          <textarea
            value={input}
            placeholder={
              streaming
                ? "Menyiapkan jawaban…"
                : "Tulis pesan, Enter untuk mengirim"
            }
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
                className="primary"
                onClick={() => {
                  const t = input;
                  setInput("");
                  doSend(t);
                }}
              >
                Kirim
              </button>
            </>
          )}
        </div>
      </aside>

      {showSettings && settings && (
        <div className="settings-drawer">
          <button onClick={() => setShowSettings(false)}>
            Tutup pengaturan
          </button>
          <h3>Suara</h3>
          <label>
            Mesin suara
            <select
              value={settings.speech_provider ?? "voicevox"}
              onChange={(e) =>
                saveSettings({
                  speech_provider: e.target
                    .value as Settings["speech_provider"],
                })
              }
            >
              <option value="voicevox">VOICEVOX lokal</option>
              <option value="system">Suara sistem</option>
            </select>
          </label>
          <button onClick={refreshVoicevox}>
            Hubungkan / refresh VOICEVOX
          </button>
          {voicevox && (
            <>
              <p className="muted">
                Aktif: {voicevox.selected_name}. {voicevox.source}
              </p>
              <label>
                Karakter & style
                <select
                  value={settings.voicevox_style_id ?? "auto"}
                  onChange={async (e) => {
                    const id =
                      e.target.value === "auto" ? null : Number(e.target.value);
                    await saveSettings({ voicevox_style_id: id });
                    await refreshVoicevox();
                  }}
                >
                  <option value="auto">
                    Otomatis: default tersimpan VOICEVOX
                  </option>
                  {voicevox.voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <p className="muted">
            Seleksi aktif editor tidak tersedia lewat API VOICEVOX. Mode
            otomatis membaca default tersimpan setiap kali bicara. Pelafalan
            mengikuti dukungan bahasa VOICEVOX.
          </p>
          <h3>Input suara</h3>
          <p className="muted">
            Tekan ikon mikrofon untuk mode ngobrol berkelanjutan. Setelah kamu
            selesai bicara, AI menjawab lalu mikrofon otomatis mendengarkan
            lagi. Ketika AI menyiapkan suara atau berbicara, penangkapan suara
            dijeda agar tidak mendengar dirinya sendiri. Tekan ikon lagi untuk
            berhenti. Apple dapat memproses audio online; teks dikirim ke
            NVIDIA.
          </p>
          <button onClick={testVoice}>Tes suara</button>
          <button onClick={() => speechRef.current?.stop()}>Hentikan</button>
          {voiceStatus && <p role="status">{voiceStatus}</p>}
          <h3>Kepribadian Vivian</h3>
          <label className="preference-toggle">
            <input
              type="checkbox"
              checked={settings.affectionate_mode ?? false}
              onChange={(e) =>
                void saveSettings({
                  affectionate_mode: e.target.checked,
                }).catch((error) => setVoiceStatus(String(error)))
              }
            />{" "}
            Mode Manja
          </label>
          <p className="muted">
            Reaksi sentuhan malu-malu dan gaya obrolan lebih akrab seperti
            pasangan virtual. Bisa dimatikan kapan saja.
          </p>
          {(
            [
              ["cheerfulness", "Keceriaan"],
              ["playfulness", "Keusilan"],
              ["shyness", "Rasa malu"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label} · {settings.personality[key] ?? 50}
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={settings.personality[key] ?? 50}
                onChange={(e) =>
                  saveSettings({
                    personality: {
                      ...settings.personality,
                      [key]: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
          ))}
          <h3>Koneksi AI</h3>
          <label>
            NVIDIA API key
            <input
              type="password"
              value={apiKeyInput}
              placeholder={
                keyPresent
                  ? "API key aktif di sesi ini"
                  : "NVIDIA_API_KEY dari .env"
              }
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
          </label>
          <div className="row">
            <button
              onClick={() => connect(false)}
              disabled={!apiKeyInput.trim()}
            >
              Pakai sesi ini
            </button>
            <button onClick={() => connect(true)}>
              {apiKeyInput.trim() ? "Simpan ke .env" : "Muat .env"}
            </button>
          </div>
          <p className="muted">
            Pakai sesi ini menyimpan key di memori sampai aplikasi ditutup. Muat
            .env membaca NVIDIA_API_KEY tanpa Keychain atau password macOS; chat
            berikutnya memakai key dari memori.
          </p>
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
                saveSettings({ avatar_kind: "live2d" }).then(() =>
                  location.reload(),
                );
              }}
            >
              Live2D
            </button>
            <button
              className={settings.avatar_kind === "vrm" ? "primary" : ""}
              onClick={() => {
                saveSettings({ avatar_kind: "vrm" }).then(() =>
                  location.reload(),
                );
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
              <option value="models/Vivian/Vivian.model3.json">
                Vivian (薇薇安)
              </option>
              <option value="models/Nicole/Nicole.model3.json">Nicole</option>
            </select>
          </label>

          <h3>Expressions (debug)</h3>
          <div className="expr-grid">
            {exprInfo.expressions.map((name) => (
              <button
                key={name}
                className="ghost"
                onClick={() => triggerExpr(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <p className="muted">
            Motions: {exprInfo.motions.join(", ") || "none"}
          </p>
        </div>
      )}
    </div>
  );
}
