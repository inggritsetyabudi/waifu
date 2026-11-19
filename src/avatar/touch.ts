export type TouchRegion = "head" | "face" | "hand" | "body" | "feet" | "accessory" | "sensitive";
export const touchReactions: Record<TouchRegion, { label: string; emotion: string; gesture: string; speech_ja: string; symbol: string }> = {
  sensitive: { label: "Jangan sentuh bagian itu. Aku tidak nyaman.", emotion: "angry", gesture: "shake", speech_ja: "そこは触らないでください。", symbol: "!" },
  head: { label: "Kepala · senang", emotion: "happy", gesture: "excited_hands", speech_ja: "えへへ、ありがとう！", symbol: "✦" },
  face: { label: "Pipi · malu", emotion: "shy", gesture: "tilt", speech_ja: "ちょっと恥ずかしいな。", symbol: "✿" },
  hand: { label: "Tangan · menyapa", emotion: "playful", gesture: "wave", speech_ja: "ハイタッチ！", symbol: "✋" },
  body: { label: "Badan · penasaran", emotion: "curious", gesture: "think", speech_ja: "どうしたの？", symbol: "?" },
  feet: { label: "Kaki · kaget", emotion: "surprised", gesture: "look_down", speech_ja: "わっ、びっくりした！", symbol: "!" },
  accessory: { label: "Aksesori · usil", emotion: "annoyed", gesture: "shake", speech_ja: "もう、いたずらしないで。", symbol: "✧" },
};

const affectionateReactions: typeof touchReactions = {
  head: { label: "Hehe, aku suka dielus begini.", emotion: "happy", gesture: "tilt", speech_ja: "えへへ、なでてくれてうれしいな。", symbol: "♡" },
  face: { label: "Kamu bikin aku malu, nih…", emotion: "shy", gesture: "look_away", speech_ja: "もう、照れちゃうよ。", symbol: "✿" },
  hand: { label: "Sini, high five dulu!", emotion: "happy", gesture: "wave", speech_ja: "ねえ、ハイタッチしよう！", symbol: "♡" },
  body: { label: "Mau ditemani? Aku di sini.", emotion: "happy", gesture: "nod", speech_ja: "一緒にお話しする？ここにいるよ。", symbol: "♡" },
  feet: { label: "Ih, geli! Kamu usil, ya~", emotion: "playful", gesture: "look_down", speech_ja: "あっ、くすぐったいよ！いたずらっ子だね。", symbol: "✧" },
  accessory: { label: "Lucu, kan? Kamu suka?", emotion: "playful", gesture: "tilt", speech_ja: "かわいいでしょ？気に入ってくれた？", symbol: "✦" },
  sensitive: touchReactions.sensitive,
};

export function reactionFor(region: TouchRegion, affectionateMode = false) {
  if(region === "sensitive") return touchReactions.sensitive;
  return (affectionateMode ? affectionateReactions : touchReactions)[region];
}

/** Fallback zones for bundled models whose manifests omit Cubism HitAreas. */
export function touchZone(x: number, y: number, sitting: boolean): TouchRegion {
  if (sitting) {
    // Reserved clothing areas: refuse contact before considering ordinary body/hand zones.
    if ((x >= .49 && x <= .73 && y >= .46 && y <= .55) ||
        (x >= .30 && x <= .68 && y >= .55 && y <= .76)) return "sensitive";
    if (y < .29) return "accessory";
    if (y < .37 && x > .4 && x < .85) return "head";
    if (y < .46 && x > .45 && x < .85) return "face";
    if ((y < .55 && x < .48) || (y > .52 && y < .69 && x > .66)) return "hand";
    if (y > .76) return "feet";
    return "body";
  }
  // Nicole's visible chest is at y=.24–.35, pelvis at .425–.51.
  // Model coordinates include the transparent margins; screen-height percentages do not.
  if ((x >= .30 && x <= .65 && y >= .24 && y <= .35) ||
      (x >= .29 && x <= .65 && y >= .425 && y <= .51) ||
      (x >= .29 && x <= .67 && y >= .49 && y <= .69)) return "sensitive";
  if (y < .09) return "accessory";
  if (y < .15) return "head";
  if (y < .235 && x >= .32 && x <= .68) return "face";
  if (y > .73) return "feet";
  if (x < .30 || x > .67) return "hand";
  return "body";
}
