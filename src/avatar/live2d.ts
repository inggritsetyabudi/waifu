/**
 * Live2D avatar renderer (Cubism 4/5 via pixi-live2d-display).
 * Owns: model loading, idle animation, expression switching, lip-sync hook,
 * and the animation director interface consumed by chat events.
 */
import { AvatarVitality } from "./vitality";
import { touchZone, reactionFor, type TouchRegion } from "./touch";
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

interface GestureParameter { Id:string; Value:number; Blend?:string }
const nativeGestureNames:Record<string,string>={heart:'love hand posture',peace:'y hand posture',sip_tea:'milk tea',check_phone:'phone hand posture',money:'money hand posture',dance:'y hand posture',wave:'y hand posture',excited_hands:'love hand posture'};

export class Live2DStage {
  app: PIXI.Application;
  model: Live2DModel<InternalModel> | null = null;
  onStatus: (s: string) => void = () => {};
  onModelInfo: (info: { expressions: string[]; motions: string[] }) => void =
    () => {};

  private tempExprToken = 0;
  private modelScale = 1;
  private sittingModel = true;
  private lastTouch = -Infinity;
  private affectionateMode = false;
  private smileUntil = 0;
  private motionScale = 1;
  private winkUntil = 0;
  private poseName = "neutral";
  private home = {x:0,y:0};
  private nativeGestures:Record<string,GestureParameter[]> = {};
  private poseStarted = 0;
  private poseUntil = 0;
  private mouthLevel = 0;
  private mouthActive = false;
  private loadToken = 0;
  private destroyed = false;
  private gaze = { x: 0, y: 0 };
  private vitality=new AvatarVitality();
  private pointerAt=-Infinity;
  private listening=false;
  private bodyRig:{x?:string;y?:string;z?:string;shift?:string}={};
  private gestureUntil = 0;
  private gestureStarted = 0;
  private parameterIds = new Set<string>();
  private shoulders: { x?: string; y?: string; z?: string; hand?: string } = {};
  private activeGesture = "none";
  private pointerMove = (event: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerAt=this.t;
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
    this.parameterIds.clear();
    this.shoulders = {};
    this.bodyRig={};
    if (settings.FileReferences?.DisplayInfo) {
      try {
        const metadata = await fetch(new URL(settings.FileReferences.DisplayInfo, absolute)).then((r) => r.json());
        this.parameterIds = new Set((metadata.Parameters ?? []).map((p: {Id: string}) => p.Id));
        this.shoulders = {};
        for (const parameter of metadata.Parameters ?? []) {
          const name = String(parameter.Name ?? "");
          if (name.includes("肩")) {
            for (const axis of ["x", "y", "z"] as const) if (name.toLowerCase().endsWith(axis)) this.shoulders[axis] = parameter.Id;
          }
          const body=name.replace(/\s+/g,'').toLowerCase();
          if(body==='身体x') this.bodyRig.x=parameter.Id;
          if(body==='身体y') this.bodyRig.y=parameter.Id;
          if(body==='身体z') this.bodyRig.z=parameter.Id;
          if(body==='身体位移') this.bodyRig.shift=parameter.Id;
          if (name === "手前后") this.shoulders.hand = parameter.Id;
        }
      } catch { /* Standard head/body gestures still work without optional metadata. */ }
    }
    // Nicole ships with an empty EyeBlink group. Repair it in memory so Cubism
    // drives the actual eyelid rig, without modifying the model asset files.
    const blinkIds=['ParamEyeLOpen','ParamEyeROpen'].filter(id=>this.parameterIds.has(id));
    if(blinkIds.length) {
      settings.Groups ??= [];
      let blink=settings.Groups.find((group:{Name:string})=>group.Name==='EyeBlink');
      if(!blink) {blink={Target:'Parameter',Name:'EyeBlink',Ids:[]};settings.Groups.push(blink);}
      if(!blink.Ids?.length) blink.Ids=blinkIds;
    }
    // Hand/prop poses have their own parameter layer, independent of facial expressions.
    this.nativeGestures={};
    const definitions=(settings.FileReferences?.Expressions ?? []) as {Name:string;File:string}[];
    const handDefinitions=definitions.filter(definition=>Object.values(nativeGestureNames).includes(definition.Name.toLowerCase()));
    const nativeData=await Promise.allSettled(handDefinitions.map(async definition=>{
      const response=await fetch(new URL(definition.File,absolute));
      if(!response.ok) throw new Error('Pose tidak tersedia');
      const data=await response.json();
      const name=definition.Name.toLowerCase();
      let parameters=(data.Parameters ?? []).filter((parameter:GestureParameter)=>typeof parameter.Id==='string' && Number.isFinite(parameter.Value)) as GestureParameter[];
      if(/\/Nicole\//i.test(absolute)) {
        // Nicole has separately toggled default hair/waist hands. Hide the replaced
        // hands as well, otherwise a two-handed heart would leave an extra arm.
        const hiddenHands=name==='love hand posture'?['Param23','Param24']:['Param23'];
        parameters=[...parameters.filter(parameter=>!hiddenHands.includes(parameter.Id)),...hiddenHands.map(Id=>({Id,Value:1,Blend:'Overwrite'}))];
      }
      return {name,parameters};
    }));
    if(this.destroyed || token!==this.loadToken) throw new Error('Loading dibatalkan');
    for(const result of nativeData) if(result.status==='fulfilled') {
      for(const [gesture,name] of Object.entries(nativeGestureNames)) if(name===result.value.name) this.nativeGestures[gesture]=result.value.parameters;
    }
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
      const texture = PIXI.Texture.from(atlas, { mipmap: PIXI.MIPMAP_MODES.ON, scaleMode: PIXI.SCALE_MODES.LINEAR });
      PIXI.Texture.addToCache(texture, source);
      this.textures.push(texture);
    }
    return settings;
  }

  async load(url: string, scale = 1) {
    this.sittingModel = url.includes("Vivian");
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
    this.vitality=new AvatarVitality();
    (model.internalModel as any).eyeBlink?.setBlinkingInterval(3.2);
    const coreIds = (model.internalModel.coreModel as any)._model?.parameters?.ids as string[] | undefined;
    coreIds?.forEach((id) => this.parameterIds.add(id));
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
    this.home={x:w/2,y:h/2+h*.04};
    m.position.set(this.home.x,this.home.y); // keep the full model in frame
    const base = Math.min(w / m.internalModel.originalWidth, h / m.internalModel.originalHeight);
    m.scale.set(base * 0.95 * scale);
  }

  /** Test actual drawable triangles first, so transparent space never reacts. */
  reactAt(clientX: number, clientY: number): TouchRegion | null {
    const model = this.model;
    if (!model || performance.now() - this.lastTouch < 300) return null;
    const rect = this.canvas.getBoundingClientRect();
    const global = new PIXI.Point((clientX - rect.left) * this.app.screen.width / rect.width,
      (clientY - rect.top) * this.app.screen.height / rect.height);
    const point = model.toModelPosition(global);
    const internal = model.internalModel;
    const core = internal.coreModel as any;
    let hit = false;
    const count = internal.getDrawableIDs().length;
    const cross = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => (bx-ax)*(py-ay)-(by-ay)*(px-ax);
    for (let index = count - 1; index >= 0 && !hit; index--) {
      if (core.getDrawableOpacity?.(index) < .1) continue;
      const bounds = internal.getDrawableBounds(index);
      if (point.x < bounds.x || point.y < bounds.y || point.x > bounds.x + bounds.width || point.y > bounds.y + bounds.height) continue;
      const vertices = internal.getDrawableVertices(index);
      const indices = core.getDrawableVertexIndices?.(index) as Uint16Array | undefined;
      if (!indices) { hit = true; break; }
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const a = indices[i] * 2, b = indices[i+1] * 2, c = indices[i+2] * 2;
        const d1 = cross(vertices[a],vertices[a+1],vertices[b],vertices[b+1],point.x,point.y);
        const d2 = cross(vertices[b],vertices[b+1],vertices[c],vertices[c+1],point.x,point.y);
        const d3 = cross(vertices[c],vertices[c+1],vertices[a],vertices[a+1],point.x,point.y);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) { hit = true; break; }
      }
    }
    if (!hit) return null;
    const region = touchZone(point.x / internal.originalWidth, point.y / internal.originalHeight, this.sittingModel);
    const reaction = reactionFor(region, this.affectionateMode);
    this.lastTouch = performance.now();
    this.pose("neutral"); this.winkUntil=0;
    if (region === "sensitive") this.smileUntil = 0;
    this.setEmotion(reaction.emotion, region === "sensitive" ? 1 : .7);
    this.gesture(reaction.gesture);
    if (region === "head" || region === "hand") this.smileUntil = this.t + 3;
    return region;
  }

  // ---- director API ----

  setExpression(name: string, durationMs = 4000) {
    const m = this.model;
    if (!m) return;
    const mgr = m.internalModel.motionManager.expressionManager;
    if (!mgr) return;
    const token = ++this.tempExprToken;
    try {
      const state=mgr as any;
      const index=(state.definitions as {Name?:string;name?:string}[]).findIndex(definition=>(definition.Name ?? definition.name)===name);
      if(index>=0 && state.expressions?.[index] && state.currentExpression===state.expressions[index]) state.restoreExpression();
      else void mgr.setExpression(name).catch(() => {});
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
  setEmotion(primary: string, intensity: number, durationMs?: number) {
    if (primary === "neutral" || intensity < 0.15) {
      this.smileUntil=0; this.winkUntil=0;
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
    if (hit) this.setExpression(hit, durationMs ?? (5000 + intensity * 5000));
  }

  setAffectionateMode(enabled: boolean) {
    this.affectionateMode = enabled;
  }

  setListening(enabled:boolean) { this.listening=enabled; }

  setReducedMotion(enabled: boolean) {
    this.motionScale = enabled ? .3 : 1;
    this.app.ticker.maxFPS = enabled ? 24 : 30;
  }

  setSemanticExpression(name: string, durationMs = 3000) {
    const emotion: Record<string,string> = {neutral:"neutral",smile:"happy",blush:"shy",pout:"annoyed",cry:"sad",surprised:"surprised",sleepy:"sleepy",serious:"angry",wink:"playful"};
    if (!emotion[name]) return;
    this.smileUntil = 0; this.winkUntil = 0;
    this.setEmotion(emotion[name], name === "neutral" ? 0 : .8, durationMs);
    if (name === "smile") this.smileUntil = this.t + durationMs / 1000;
    if (name === "wink") this.winkUntil = this.t + durationMs / 1000;
  }

  pose(name: string, durationMs = 3000) {
    if (!["neutral","shy","confident","thinking","greeting","relaxed","celebrate"].includes(name)) return;
    this.poseName = name; this.poseStarted = this.t;
    this.poseUntil = name === "neutral" ? this.t : this.t + Math.max(500,Math.min(8000,durationMs))/1000;
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

  gesture(gesture: string, durationMs?: number) {
    this.activeGesture = gesture.toLowerCase();
    this.gestureStarted = this.t;
    this.gestureUntil = this.t + (durationMs === undefined ? (/excited|wave/.test(this.activeGesture) ? 3.8 : 3) : Math.max(500,Math.min(8000,durationMs))/1000);
    if (this.activeGesture === "none") this.gestureUntil = this.t;
    if (/wave|excited|heart|peace/.test(this.activeGesture)) this.smileUntil = this.gestureUntil;
    const nativeRequired=['heart','peace','sip_tea','check_phone','money'];
    if(nativeRequired.includes(this.activeGesture) && !this.nativeGestures[this.activeGesture]) {
      const fallback:Record<string,string>={heart:'stretch',peace:'lean_right',sip_tea:'bow',check_phone:'lean_left',money:'dance'};
      this.activeGesture=fallback[this.activeGesture];
    }
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

    const life=this.vitality.sample({time:this.t,dt:this.app.ticker.deltaMS/1000,pointer:this.gaze,
      pointerAge:this.t-this.pointerAt,speaking:this.mouthActive?this.mouthLevel:0,listening:this.listening,
      acting:this.t<this.gestureUntil || this.t<this.poseUntil,reduced:this.motionScale<1});
    const addLife=(id:string|undefined,value:number)=>{if(id && this.parameterIds.has(id)) core.addParameterValueById(id,value);};
    if(this.parameterIds.has('ParamBreath')) core.setParameterValueById('ParamBreath',life.breath);
    addLife('ParamAngleX',life.headX);addLife('ParamAngleY',life.headY);addLife('ParamAngleZ',life.headZ);
    addLife('ParamEyeBallX',life.eyeX);addLife('ParamEyeBallY',life.eyeY);
    addLife('ParamBodyAngleX',life.bodyX);addLife('ParamBodyAngleY',life.bodyY);addLife('ParamBodyAngleZ',life.bodyZ);
    addLife(this.bodyRig.x,life.bodyX*.65);addLife(this.bodyRig.y,life.bodyY*.7);
    addLife(this.bodyRig.z,life.bodyZ);addLife(this.bodyRig.shift,life.weightShift);
    addLife('ParamBrowLY',life.brow);addLife('ParamBrowRY',life.brow);
    let shiftX=0,shiftY=0;
    if (this.t < this.gestureUntil) {
      const progress = (this.t - this.gestureStarted) / (this.gestureUntil - this.gestureStarted);
      const fade = Math.sin(Math.PI * Math.max(0, Math.min(1, progress))) * this.motionScale;
      const add = (id: string | undefined, amount: number) => {
        if (id && this.parameterIds.has(id)) core.addParameterValueById?.(id, amount * fade);
      };
      const elapsed=this.t-this.gestureStarted;
      const hold=Math.max(0,Math.min(1,elapsed/.3,(this.gestureUntil-this.t)/.3));
      for(const parameter of this.nativeGestures[this.activeGesture] ?? []) {
        if(!this.parameterIds.has(parameter.Id)) continue;
        const current=core.getParameterValueById(parameter.Id);
        const target=parameter.Blend==='Multiply'?current*parameter.Value:parameter.Blend==='Overwrite'?parameter.Value:current+parameter.Value;
        core.setParameterValueById(parameter.Id,current+(target-current)*hold);
      }

      if(this.activeGesture==='dance') {
        add('ParamBodyAngleZ',Math.sin(elapsed*5)*13);add(this.bodyRig.z,Math.sin(elapsed*5)*5);
        add('ParamBodyAngleY',Math.cos(elapsed*5)*9);
        add('ParamAngleZ',-Math.sin(elapsed*5)*7);
        add(this.shoulders.x,Math.sin(elapsed*6)*9);
        add(this.shoulders.y,Math.cos(elapsed*6)*7);
        shiftX=Math.sin(elapsed*5)*10*fade;
        shiftY=-Math.abs(Math.sin(elapsed*5))*4*fade;
      }
      if(this.activeGesture==='bow') {add(this.bodyRig.y,-5);add('ParamAngleY',-24);add('ParamBodyAngleY',-13);add('ParamEyeBallY',-.25);}
      if(this.activeGesture==='stretch') {add(this.bodyRig.y,5);add('ParamBodyAngleY',11);add('ParamAngleY',14);add(this.shoulders.y,13);add(this.shoulders.z,10);}
      if(this.activeGesture==='lean_left' || this.activeGesture==='lean_right') {
        const direction=this.activeGesture==='lean_left'?-1:1;
        add(this.bodyRig.z,direction*4);add('ParamBodyAngleZ',direction*11);add('ParamAngleZ',direction*9);
        shiftX=direction*5*fade;
      }
      if(this.activeGesture==='bounce') {
        shiftY=-Math.abs(Math.sin(elapsed*6))*11*fade;
        add('ParamBodyAngleY',Math.sin(elapsed*6)*7);add(this.shoulders.y,Math.sin(elapsed*6)*8);
      }
      if (/nod|agree|yes/.test(this.activeGesture)) core.addParameterValueById?.("ParamAngleY", Math.sin(this.t * 8) * 9 * fade);
      if (["shake", "no"].includes(this.activeGesture)) core.addParameterValueById?.("ParamAngleX", Math.sin(this.t * 8) * 12 * fade);
      if (/look_down/.test(this.activeGesture)) core.addParameterValueById?.("ParamAngleY", -9 * fade);
      if (/think|tilt|shy|heart|peace/.test(this.activeGesture)) core.addParameterValueById?.("ParamAngleZ", 9 * fade);
      if (/wave/.test(this.activeGesture)) {
        add("ParamAngleZ", Math.sin((this.t-this.gestureStarted)*7)*5);
        add("ParamBodyAngleZ", Math.sin((this.t-this.gestureStarted)*6)*3);
        add(this.shoulders.x, Math.sin((this.t-this.gestureStarted)*8)*5);
        add(this.shoulders.hand, Math.sin((this.t-this.gestureStarted)*7)*.35);
      }
      if (/shrug/.test(this.activeGesture)) { add(this.shoulders.y, 7); add("ParamBodyAngleY", 4); add("ParamAngleZ", -7); }
      if (/excited/.test(this.activeGesture)) { add("ParamBodyAngleY", Math.sin((this.t-this.gestureStarted)*10)*5); add("ParamAngleZ", Math.sin((this.t-this.gestureStarted)*8)*7); add(this.shoulders.z, 6); }
      if (/look_away/.test(this.activeGesture)) { add("ParamAngleX", -17); add("ParamEyeBallX", -.5); }
      if (/explain/.test(this.activeGesture)) { add("ParamBodyAngleZ", Math.sin((this.t-this.gestureStarted)*4)*2); add(this.shoulders.x, 5); }
      if (/think/.test(this.activeGesture)) { add("ParamEyeBallY", .5); add("ParamAngleY", 5); }
      if (/nervous/.test(this.activeGesture)) { add("ParamBodyAngleX", Math.sin((this.t-this.gestureStarted)*9)*2); add(this.shoulders.hand, .2); }
    }
    m.position.set(this.home.x+shiftX,this.home.y+shiftY);
    if (this.t < this.poseUntil) {
      const duration = this.poseUntil - this.poseStarted;
      const weight = Math.min(1,(this.t-this.poseStarted)/.35,(this.poseUntil-this.t)/.35) * this.motionScale;
      const profiles: Record<string,Record<string,number>> = {
        shy: {ParamAngleX:-10,ParamAngleY:-7,ParamAngleZ:8,ParamBodyAngleZ:-3,ParamEyeBallX:-.3},
        confident: {ParamAngleY:6,ParamAngleZ:-4,ParamBodyAngleY:3},
        thinking: {ParamAngleZ:10,ParamAngleY:5,ParamEyeBallY:.4},
        greeting: {ParamAngleZ:-4,ParamBodyAngleX:3},
        relaxed: {ParamAngleZ:4,ParamBodyAngleZ:2},
        celebrate: {ParamAngleY:5,ParamBodyAngleY:4},
      };
      if(duration>0) for(const [id,value] of Object.entries(profiles[this.poseName] ?? {})) {
        if(this.parameterIds.has(id)) core.addParameterValueById?.(id,value*weight);
      }
    }
    if (this.t < this.winkUntil && this.parameterIds.has("ParamEyeLOpen")) core.setParameterValueById("ParamEyeLOpen", 0);
    if (this.t < this.smileUntil) {
      core.setParameterValueById("ParamMouthForm", .8);
      core.setParameterValueById("ParamEyeLSmile", .5);
      core.setParameterValueById("ParamEyeRSmile", .5);
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
