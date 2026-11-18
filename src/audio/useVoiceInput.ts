import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface RecognitionEvent { id: string; kind: "authorizing" | "listening" | "partial" | "final" | "error" | "stopped"; text: string }

/** One explicit microphone session. Final transcripts are sent once. */
export function useVoiceInput(onFinal: (text: string) => void, onError: (message: string) => void) {
  const [state, setState] = useState<"idle" | "authorizing" | "listening">("idle");
  const [status, setStatus] = useState("");
  const [transcript, setTranscript] = useState("");
  const session = useRef<string | null>(null);
  const callbacks = useRef({ onFinal, onError });
  callbacks.current = { onFinal, onError };
  const mounted = useRef(true);
  const off = useRef<(() => void) | null>(null);
  const stop = async () => {
    const wasActive = session.current !== null;
    session.current = null;
    off.current?.(); off.current = null;
    if (mounted.current) { setState("idle"); setTranscript(""); setStatus(""); }
    if (wasActive) await invoke("cmd_stop_listening").catch(() => {});
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void stop(); };
  }, []);

  const start = async () => {
    await stop();
    const id = `speech-${crypto.randomUUID()}`;
    session.current = id;
    setState("authorizing"); setTranscript(""); setStatus("Meminta izin mikrofon…");
    try {
      const unlisten = await listen<RecognitionEvent>("speech://event", ({ payload: event }) => {
        if (session.current !== event.id || !mounted.current) return;
        if (event.kind === "authorizing") {
          setState("authorizing"); setStatus(event.text || "Meminta izin mikrofon…");
        }
        if (event.kind === "listening") { setState("listening"); setStatus("Mendengarkan…"); }
        if (event.kind === "partial") setTranscript(event.text);
        if (["final", "error", "stopped"].includes(event.kind)) {
          session.current = null;
          off.current?.(); off.current = null;
          setState("idle"); setTranscript(""); setStatus("");
          if (event.kind === "final" && event.text.trim()) callbacks.current.onFinal(event.text.trim());
          if (event.kind === "error") callbacks.current.onError(event.text);
        }
      });
      if (session.current !== id || !mounted.current) { unlisten(); return; }
      off.current = unlisten;
      await invoke("cmd_start_listening", { id });
    } catch (error) {
      if (session.current === id) {
        await stop();
        if (mounted.current) callbacks.current.onError(String(error));
      }
    }
  };
  return { state, status, transcript, start, stop, active: state !== "idle" };
}
