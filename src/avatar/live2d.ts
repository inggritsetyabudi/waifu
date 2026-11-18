/**
 * Live2D avatar renderer (Cubism 4/5 via pixi-live2d-display).
 * Owns: model loading, idle animation, expression switching, lip-sync hook,
 * and the animation director interface consumed by chat events.
 */
import * as PIXI from "pixi.js";
import {
  Live2DModel,
  MotionPriority,
  type InternalModel,
} from "pixi-live2d-display/cubism4";

// pixi-live2d-display expects window.PIXI for its Ticker registration
(window as any).PIXI = PIXI;

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
  }
}

export interface Live2DDirector {
  setExpression(name: string, durationMs?: number): void;
  setEmotion(primary: string, intensity: number): void;
  startLipSync(): void;
  feedLipSync(level: number): void;
  stopLipSync(): void;
  gesture(gesture: string): void;
}

/**
 * Keyword groups per emotion. Matched case-insensitively against whatever
 * expressions the loaded model actually declares, so the same mapping works
 * for Vivian (cry/shy/panicked/eye_roll/black_face) and Nicole.
 */
const EMOTION_KEYWORDS: Record<string, string[]> = {
  happy: ["smile", "happy", "love eye", "joy", "fun"],
  excited: ["smile", "happy", "joy", "伞"],
  laughing: ["smile", "happy", "joy"],
  shy: ["shy", "害羞", "blush", "embarrass"],
  embarrassed: ["shy", "害羞", "blush", "black_face", "黑脸"],
  flustered: ["panic", "慌张", "shy"],
  nervous: ["panic", "慌张", "worried"],
  surprised: ["panic", "慌张", "surprise", "shock"],
  sad: ["cry", "哭", "sad", "tear"],
  angry: ["black", "黑脸", "angry", "frown"],
  annoyed: ["black", "黑脸", "eye_roll", "白眼"],
  teasing: ["eye_roll", "白眼", "smug", "tease"],
  playful: ["eye_roll", "smile", "smug"],
  sleepy: ["sleep", "close", "eye_roll"],
  concerned: ["worried", "sad"],
  neutral: [],
};

export class Live2DStage {
  app: PIXI.Application;
  model: Live2DModel<InternalModel> | null = null;
  onStatus: (s: string) => void = () => {};
  onModelInfo: (info: { expressions: string[]; motions: string[] }) => void =
    () => {};

  private tempExprToken = 0;
  private modelScale = 1;
  private mouthLevel = 0;
  private mouthActive = false;
  private loadToken = 0;
  private destroyed = false;
  private gaze = { x: 0, y: 0 };
  private smoothGaze = { x: 0, y: 0 };
  private gestureUntil = 0;
  private activeGesture = "none";
  private pointerMove = (event: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.gaze = { x: (event.clientX - rect.left) / rect.width * 2 - 1,
      y: (event.clientY - rect.top) / rect.height * 2 - 1 };
  };

  constructor(canvas: HTMLCanvasElement) {
    this.app = new PIXI.Application({
      view: canvas,
      resizeTo: canvas.parentElement ?? window,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 1.5),
      powerPreference: "low-power",
    });
    // Use the same Pixi 6 runtime as pixi-live2d-display.
    this.app.stage.interactive = false;
    this.app.stage.interactiveChildren = false;
    this.app.ticker.maxFPS = 30;
    canvas.addEventListener("webglcontextlost", this.contextLost);
    window.addEventListener("pointermove", this.pointerMove);

    // pixi's resizeTo is unreliable when the canvas parent mounts late;
    // observe the container ourselves so the canvas always matches.
    const parent = canvas.parentElement;
    if (parent) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(parent);
    }
  }

  private resizeObserver: ResizeObserver | null = null;
  private textures: PIXI.Texture[] = [];
  private contextLost = (event: Event) => {
    event.preventDefault();
    this.onStatus("error: WebGL terputus. Tekan Muat ulang avatar.");
  };

  private releaseModel() {
    this.model?.destroy({ children: true });
    this.model = null;
    for (const texture of this.textures) texture.destroy(true);
    this.textures = [];
  }

  private async prepareTextures(url: string, token: number) {
    const absolute = new URL(url, document.baseURI).href;
    const response = await fetch(absolute);
    if (!response.ok) throw new Error(`Model tidak ditemukan (${response.status})`);
    const settings = await response.json();
    settings.url = absolute;
    const files: string[] = settings.FileReferences?.Textures ?? [];
    // Decode one image at a time and retain only a 2048px canvas per atlas.
    for (const file of files) {
      if (this.destroyed || token !== this.loadToken) throw new Error("Loading dibatalkan");
      const source = new URL(file, absolute).href;
      const image = new Image();
      image.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(`Gagal memuat tekstur: ${file}`));
        image.src = source;
      });
      if (this.destroyed || token !== this.loadToken) { image.src = ""; throw new Error("Loading dibatalkan"); }
      const ratio = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
      const atlas = document.createElement("canvas");
      atlas.width = Math.round(image.naturalWidth * ratio);
      atlas.height = Math.round(image.naturalHeight * ratio);
      const context = atlas.getContext("2d");
      if (!context) throw new Error("Canvas 2D tidak tersedia untuk tekstur");
      context.drawImage(image, 0, 0, atlas.width, atlas.height);
      image.src = "";
      const texture = PIXI.Texture.from(atlas, { mipmap: PIXI.MIPMAP_MODES.OFF, scaleMode: PIXI.SCALE_MODES.LINEAR });
      PIXI.Texture.addToCache(texture, source);
      this.textures.push(texture);
    }
    return settings;
  }

  async load(url: string, scale = 1) {
    const token = ++this.loadToken;
    this.modelScale = scale;
    this.onStatus(`loading ${url}`);
    this.releaseModel();
    const settings = await this.prepareTextures(url, token);
    const model = await Live2DModel.from(settings, {
      autoInteract: false,
      autoUpdate: true,
      idleMotionGroup: "idle",
    });
    if (this.destroyed || token !== this.loadToken) { model.destroy(); return; }
    this.model = model;
    model.internalModel.on("beforeModelUpdate", () => this.tick());

    const root = this.app.stage;
    root.removeChildren();
    root.addChild(model as unknown as PIXI.DisplayObject);

    this.fitModel(scale);

    const internal = model.internalModel;
    const expressions = internal.motionManager.expressionManager
      ? (internal.motionManager.expressionManager.definitions as { Name?: string; name?: string }[]).map((d) => d.Name ?? d.name ?? "")
      : [];
    const motions = Object.keys(
      (internal.motionManager.definitions as any) ?? {},
    );
    this.onModelInfo({ expressions, motions });
    this.onStatus("ready");
    const idle = motions.find((name) => name.toLowerCase() === "idle");
    if (idle) void model.motion(idle, undefined, MotionPriority.IDLE);
  }

  fitModel(scale = 1) {
    if (!this.model) return;
    const w = this.app.renderer.width / this.app.renderer.resolution;
    const h = this.app.renderer.height / this.app.renderer.resolution;

    const m = this.model;
    m.anchor.set(0.5, 0.5);
    m.position.set(w / 2, h / 2 + h * 0.04); // keep the full model in frame
    const base = Math.min(w / m.internalModel.originalWidth, h / m.internalModel.originalHeight);
    m.scale.set(base * 0.95 * scale);
  }

  // ---- director API ----

  setExpression(name: string, durationMs = 4000) {
    const m = this.model;
    if (!m) return;
    const mgr = m.internalModel.motionManager.expressionManager;
    if (!mgr) return;
    const token = ++this.tempExprToken;
    try {
      void mgr.setExpression(name).catch(() => {});
    } catch {
      return;
    }
    if (durationMs > 0) {
      setTimeout(() => {
        if (!this.destroyed && this.model === m && token === this.tempExprToken) mgr.resetExpression();
      }, durationMs);
    }
  }

  /** Map a semantic emotion to the best available expression. */
  setEmotion(primary: string, intensity: number) {
    if (primary === "neutral" || intensity < 0.15) {
      ++this.tempExprToken;
      this.model?.internalModel.motionManager.expressionManager?.resetExpression();
      return;
    }
    const candidates = EMOTION_KEYWORDS[primary] ?? [];
    const m = this.model;
    if (!m) return;
    const mgr = m.internalModel.motionManager.expressionManager;
    if (!mgr) return;
    const available = (mgr.definitions as { Name?: string; name?: string }[]).map((d) => d.Name ?? d.name ?? "");
    const hit = candidates
      .map((c) => available.find((a) => a.toLowerCase().includes(c)))
      .find(Boolean);
    if (hit) this.setExpression(hit, 5000 + intensity * 5000);
  }

  playMotion(group: string) {
    const m = this.model;
    if (!m) return;
    m.motion(group, undefined, MotionPriority.FORCE).catch(() => {});
  }

  /** Audio-driven mouth open: level 0..1 */
  feedLipSync(level: number) {
    this.mouthLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    this.mouthActive = true;
  }

  stopLipSync() {
    this.mouthLevel = 0;
    this.mouthActive = false;
    const core = this.model?.internalModel.coreModel as any;
    core?.setParameterValueById?.("ParamMouthOpenY", 0);
  }

  gesture(gesture: string) {
    this.activeGesture = gesture.toLowerCase();
    this.gestureUntil = this.t + 3;
    const groups = Object.keys(this.model?.internalModel.motionManager.definitions ?? {});
    const group = groups.find((g) => g.toLowerCase() === this.activeGesture);
    if (group && this.activeGesture !== "none") this.playMotion(group);
  }

  // ---- per-frame idle layer (breathing, subtle sway, blink fallback) ----
  private t = 0;
  private tick() {
    this.t += this.app.ticker.deltaMS / 1000;
    const m = this.model;
    if (!m) return;
    const core = m.internalModel.coreModel as any;
    if (!core.setParameterValueById) return;

    const blend = 1 - Math.exp(-this.app.ticker.deltaMS / 180);
    this.smoothGaze.x += (Math.max(-1, Math.min(1, this.gaze.x)) - this.smoothGaze.x) * blend;
    this.smoothGaze.y += (Math.max(-1, Math.min(1, this.gaze.y)) - this.smoothGaze.y) * blend;
    const breath = Math.sin(this.t * 1.2);
    core.setParameterValueById("ParamBreath", 0.5 + breath * 0.3);
    core.addParameterValueById?.("ParamBodyAngleX", Math.sin(this.t * 0.4) * 2.5);
    core.addParameterValueById?.("ParamAngleX", this.smoothGaze.x * 10);
    core.addParameterValueById?.("ParamAngleY", -this.smoothGaze.y * 6);
    core.addParameterValueById?.("ParamEyeBallX", this.smoothGaze.x * 0.6);
    core.addParameterValueById?.("ParamEyeBallY", -this.smoothGaze.y * 0.6);
    if (this.t < this.gestureUntil) {
      const fade = Math.min(1, this.gestureUntil - this.t);
      if (/nod|agree|yes/.test(this.activeGesture)) core.addParameterValueById?.("ParamAngleY", Math.sin(this.t * 8) * 9 * fade);
      if (/shake|no/.test(this.activeGesture)) core.addParameterValueById?.("ParamAngleX", Math.sin(this.t * 8) * 12 * fade);
      if (/think|tilt|shy/.test(this.activeGesture)) core.addParameterValueById?.("ParamAngleZ", 9 * fade);
    }
    if (this.mouthActive) {
      const ids = (m.internalModel as any).lipSyncIds as string[] | undefined;
      for (const id of ids?.length ? ids : ["ParamMouthOpenY"]) {
        core.setParameterValueById(id, this.mouthLevel);
      }
    }
  }

  resize() {
    const parent = this.canvas!.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w > 0 && h > 0) {
      this.app.renderer.resize(w, h);
      this.fitModel(this.modelScale);
    }
  }

  destroy() {
    this.destroyed = true;
    ++this.loadToken;
    ++this.tempExprToken;
    window.removeEventListener("pointermove", this.pointerMove);
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener("webglcontextlost", this.contextLost);
    this.releaseModel();
    this.app.destroy(false, { children: true });
  }

  get canvas() {
    return this.app.view as HTMLCanvasElement;
  }
}

/** Load the Cubism Core runtime script once. */
export async function loadCubismCore() {
  if (window.Live2DCubismCore) return;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/live2dcubismcore.min.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("failed to load live2dcubismcore"));
    document.head.appendChild(s);
  });
}
