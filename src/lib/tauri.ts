/**
 * Typed bridge to the Rust backend.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface Settings {
  nvidia_model: string;
  nim_base_url: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
  presence_penalty: number;
  frequency_penalty: number;
  stream: boolean;
  system_prompt: string;
  personality: Record<string, number>;
  avatar_kind: "live2d" | "vrm";
  live2d_model_url: string | null;
  vrm_model_url: string | null;
  avatar_scale: number;
  remember_context_turns: number;
  speech_provider: "voicevox" | "system";
  voicevox_style_id: number | null;
  affectionate_mode: boolean;
}

export const getSettings = () => invoke<Settings>("cmd_get_settings");
export const saveSettings = (s: Settings) => invoke("cmd_save_settings", { settings: s });
export const hasApiKey = () => invoke<boolean>("cmd_has_api_key");
export const setApiKey = (key: string, persist = true) => invoke("cmd_set_api_key", { key, persist });
export const testConnection = () => invoke<string>("cmd_test_connection");
export const cancelChat = (id: string) => invoke("cmd_cancel_chat", { id });
export const commitTurn = (user: string, assistant: string) =>
  invoke("cmd_commit_turn", { user, assistant });
export const clearHistory = () => invoke("cmd_clear_history");
export const openCompanion = () => invoke("cmd_open_companion");
export const closeCompanion = () => invoke("cmd_close_companion");
export const openSettings = () => invoke("cmd_open_settings");

export interface ChunkPayload {
  id: string;
  delta: string;
  text: string;
  complete: boolean;
}
export interface DonePayload {
  id: string;
  text: string;
  speech_text: string | null;
  emo: string | null;
}
export interface ErrorPayload {
  id: string;
  message: string;
}

export async function sendChat(id: string, message: string, screenText?: string) {
  return invoke("cmd_chat", { id, message, screenText: screenText ?? null });
}

export function listenChatEvents(
  id: string,
  handlers: {
    onChunk: (p: ChunkPayload) => void;
    onDone: (p: DonePayload) => void;
    onError: (p: ErrorPayload) => void;
    onCancelled: (id: string) => void;
  },
): Promise<UnlistenFn[]> {
  const matches = (e: { id: string }) => e.id === id;
  return Promise.all([
    listen<ChunkPayload>("nim://chunk", (e) => matches(e.payload) && handlers.onChunk(e.payload)),
    listen<DonePayload>("nim://done", (e) => matches(e.payload) && handlers.onDone(e.payload)),
    listen<ErrorPayload>("nim://error", (e) => matches(e.payload) && handlers.onError(e.payload)),
    listen<{ id: string }>("nim://cancelled", (e) => matches(e.payload) && handlers.onCancelled(e.payload.id)),
  ]);
}
