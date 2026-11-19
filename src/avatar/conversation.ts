export interface ActionStage {
  setEmotion?(name: string, intensity: number, durationMs?: number): void;
  setSemanticExpression?(name: string, durationMs?: number): void;
  gesture?(name: string, durationMs?: number): void;
  pose?(name: string, durationMs?: number): void;
}
interface Action { pose?: string; expression?: string; emotion?: string; gesture?: string; intensity: number; duration_ms: number; speech_ja?: string }
const gestures = new Set(['none','wave','nod','shake','tilt','look_away','look_down','shrug','explain','think','excited_hands','nervous_hands','heart','peace','sip_tea','check_phone','money','dance','bow','stretch','lean_left','lean_right','bounce']);
const poses = new Set(['neutral','shy','confident','thinking','greeting','relaxed','celebrate']);
const expressions = new Set(['neutral','smile','blush','pout','cry','surprised','sleepy','serious','wink']);
const emotions = new Set(['neutral','happy','excited','shy','embarrassed','nervous','sad','angry','annoyed','playful','teasing','curious','confused','surprised','thinking','proud','calm','sleepy','concerned','laughing','flustered']);
const names: Record<string,string> = {shy:'Pose malu',confident:'Pose percaya diri',thinking:'Berpikir',greeting:'Menyapa',relaxed:'Santai',celebrate:'Gembira',wave:'Menyapa',look_away:'Melirik',look_down:'Melihat ke bawah',tilt:'Memiringkan kepala',shake:'Menggeleng',nod:'Mengangguk',wink:'Mengedipkan mata',neutral:'Kembali normal',dance:'Dance kecil',bow:'Membungkuk',stretch:'Meregangkan badan',lean_left:'Condong kiri',lean_right:'Condong kanan',bounce:'Memantul riang',heart:'Tangan hati',peace:'Pose peace',sip_tea:'Minum teh',check_phone:'Melihat ponsel',money:'Pamer gaya'};
const japanese = (value: unknown): value is string => typeof value==='string' && value.length<=4000 && /[\u3040-\u30ff\u3400-\u9fff]/.test(value) && !/[<>]/.test(value);
const selected = (value: unknown, choices: Set<string>) => typeof value==='string' && choices.has(value) ? value : undefined;
export function conversationActions(raw: unknown): Action[] {
  if (!raw || typeof raw!=='object') return [];
  const meta = raw as Record<string,unknown>;
  const list = Array.isArray(meta.actions) && meta.actions.length ? meta.actions.slice(0,6) : [{emotion:meta.primary,gesture:meta.gesture,expression:meta.expression,intensity:meta.intensity,duration_ms:meta.duration_ms}];
  let total=0;
  return list.flatMap(value=>{
    if (!value || typeof value!=='object' || total>=30000) return [];
    const item=value as Record<string,unknown>;
    const action: Action = {
      pose:selected(item.pose,poses),expression:selected(item.expression,expressions),
      emotion:selected(item.emotion,emotions),gesture:selected(item.gesture,gestures),
      intensity:typeof item.intensity==='number' && Number.isFinite(item.intensity)?Math.max(0,Math.min(1,item.intensity)):.7,
      duration_ms:Math.min(30000-total,typeof item.duration_ms==='number' && Number.isFinite(item.duration_ms)?Math.max(500,Math.min(8000,item.duration_ms)):3000),
      speech_ja:japanese(item.speech_ja)?item.speech_ja:undefined,
    };
    if (!action.pose && !action.expression && !action.emotion && !action.gesture) return [];
    total+=action.duration_ms;
    return [action];
  });
}

/** Promote underspecified conversational metadata to a visible hand/body action. */
export function withBodyActions(raw:unknown):unknown {
  const meta=raw && typeof raw==='object'?raw as Record<string,unknown>:{};
  if(Array.isArray(meta.actions) && meta.actions.length) return meta;
  if(['angry','annoyed','sad','concerned'].includes(String(meta.primary)) || meta.gesture==='shake' || (meta.gesture==='none' && (!meta.primary || meta.primary==='neutral'))) return meta;
  const physical=new Set(['wave','heart','peace','sip_tea','check_phone','money','dance','bow','stretch','lean_left','lean_right','bounce','excited_hands']);
  const primary=String(meta.primary ?? 'calm');
  const first=physical.has(String(meta.gesture))?String(meta.gesture):/shy|embarrass/.test(primary)?'heart':/think|curious|confused/.test(primary)?'check_phone':/excited|laugh/.test(primary)?'dance':/playful|teas/.test(primary)?'peace':'wave';
  return {...meta,actions:[
    {emotion:primary,expression:meta.expression,pose:/shy|embarrass/.test(primary)?'shy':'greeting',gesture:first,intensity:meta.intensity,duration_ms:2400},
    {pose:'relaxed',expression:'smile',gesture:first==='heart'?'peace':'lean_right',intensity:.7,duration_ms:1800}
  ]};
}

/** Serialized action/voice steps; interrupted queues can never resume later. */
export class ConversationDirector {
  private generation=0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (()=>void) | undefined;
  constructor(private stage:()=>ActionStage|null, private speak:(text:string)=>Promise<void>, private status:(label:string)=>void) {}
  cancel(reset=true) {
    ++this.generation;
    clearTimeout(this.timer); this.wake?.(); this.wake=undefined;
    if(reset) { this.stage()?.gesture?.('none'); this.stage()?.pose?.('neutral'); this.stage()?.setSemanticExpression?.('neutral'); }
    this.status('');
  }
  async run(metadata: unknown, fallbackSpeech: string | null) {
    this.cancel();
    const generation=this.generation;
    const actions=conversationActions(metadata);
    if(!actions.length) { if(fallbackSpeech && japanese(fallbackSpeech)) await this.speak(fallbackSpeech); return; }
    const perStepSpeech=actions.some(action=>Boolean(action.speech_ja));
    let wholeSpeech:Promise<void>|undefined;
    let speechFinished=true;
    let speechError:unknown;
    const apply=(action:Action,index:number)=>{
      const stage=this.stage();
      this.status(`${names[action.gesture ?? action.pose ?? action.expression ?? ''] ?? 'Beraksi'} · ${index+1}/${actions.length}`);
      if(action.emotion) stage?.setEmotion?.(action.emotion,action.intensity,action.duration_ms);
      if(action.expression) stage?.setSemanticExpression?.(action.expression,action.duration_ms);
      stage?.pose?.(action.pose ?? 'neutral',action.duration_ms);
      stage?.gesture?.(action.gesture ?? 'none',action.duration_ms);
    };
    const wait=(duration:number)=>new Promise<void>(resolve=>{
      this.wake=resolve;this.timer=setTimeout(resolve,duration);
    });
    try {
      for(let index=0;index<actions.length;index++) {
        if(generation!==this.generation) return;
        const action=actions[index];
        apply(action,index);
        if(index===0 && !perStepSpeech && fallbackSpeech && japanese(fallbackSpeech)) {
          speechFinished=false;
          wholeSpeech=this.speak(fallbackSpeech).catch(error=>{speechError=error;}).finally(()=>{speechFinished=true;});
        }
        await Promise.all([wait(action.duration_ms),perStepSpeech && action.speech_ja?this.speak(action.speech_ja):Promise.resolve()]);
        if(generation!==this.generation) return;
        if(speechError) throw speechError;
      }
      // Keep moving while a whole-response utterance outlasts its first action cycle.
      // The utterance starts once; only the visual sequence repeats.
      let index=0;
      while(wholeSpeech && !speechFinished && generation===this.generation) {
        apply(actions[index],index);
        await Promise.race([wait(actions[index].duration_ms),wholeSpeech]);
        index=(index+1)%actions.length;
      }
      if(generation!==this.generation) return;
      await wholeSpeech;
      if(speechError) throw speechError;
    } finally {
      if(generation===this.generation) { clearTimeout(this.timer); this.wake=undefined; this.status(''); }
    }
  }
}
