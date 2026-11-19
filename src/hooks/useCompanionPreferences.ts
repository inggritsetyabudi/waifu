import { useEffect, useState } from "react";
export interface CompanionPreferences {
  theme: "violet" | "peach" | "mint";
  voiceEnabled: boolean;
  touchSounds: boolean;
  reducedMotion: boolean;
  idleEnabled: boolean;
  aiTouchEnabled: boolean;
  idleChatter: boolean;
}
const key = "honey.preferences";
function decode(
  raw: string | null,
  fallback: CompanionPreferences,
): CompanionPreferences {
  try {
    const stored = JSON.parse(raw ?? "{}");
    if (!stored || typeof stored !== "object") return fallback;
    return {
      ...fallback,
      theme: ["violet", "peach", "mint"].includes(stored.theme)
        ? stored.theme
        : fallback.theme,
      ...Object.fromEntries(
        [
          "voiceEnabled",
          "touchSounds",
          "reducedMotion",
          "idleEnabled",
          "aiTouchEnabled",
          "idleChatter",
        ]
          .filter((name) => typeof stored[name] === "boolean")
          .map((name) => [name, stored[name]]),
      ),
    };
  } catch {
    return fallback;
  }
}
export function useCompanionPreferences() {
  const [preferences, setPreferences] = useState<CompanionPreferences>(() => {
    const fallback: CompanionPreferences = {
      theme: "violet",
      voiceEnabled: true,
      touchSounds: false,
      idleEnabled: true,
      aiTouchEnabled: true,
      idleChatter: true,
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches,
    };
    try {
      return decode(localStorage.getItem(key), fallback);
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    document.documentElement.dataset.reducedMotion = String(
      preferences.reducedMotion,
    );
    try {
      localStorage.setItem(key, JSON.stringify(preferences));
    } catch {}
  }, [preferences]);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key !== key) return;
      setPreferences((current) => {
        const next = decode(event.newValue, current);
        return JSON.stringify(current) === JSON.stringify(next)
          ? current
          : next;
      });
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  return [
    preferences,
    (patch: Partial<CompanionPreferences>) =>
      setPreferences((current) => ({ ...current, ...patch })),
  ] as const;
}
