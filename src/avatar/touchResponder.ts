import type { TouchRegion } from './touch';
export interface TouchReply { text:string; speech_text:string|null; emo:string|null }
export interface TouchContext { region:TouchRegion; taps:number; recent_replies:string[] }
/** Coalesce bursts and discard cancelled responses, even if transport completes late. */
export class TouchResponder {
  private timer:ReturnType<typeof setTimeout>|undefined;
  private generation=0;
  private requestId:string|null=null;
  private lastRequest=-Infinity;
  private pending:{region:TouchRegion;taps:number}|null=null;
  private recent:string[]=[];
  constructor(private request:(id:string,context:TouchContext)=>Promise<TouchReply>,
    private cancelRequest:(id:string)=>void, private blocked:()=>boolean,
    private deliver:(reply:TouchReply,region:TouchRegion)=>void, private error:(message:string)=>void,
    private thinking:(active:boolean)=>void) {}
  cancel() {
    ++this.generation;
    clearTimeout(this.timer); this.pending=null;
    if(this.requestId) this.cancelRequest(this.requestId);
    this.requestId=null; this.thinking(false);
  }
  touch(region:TouchRegion) {
    if(this.blocked()) return;
    const taps=Math.min(12,(this.pending?.taps ?? 0)+1);
    this.cancel();
    this.pending={region,taps}; this.thinking(true);
    const generation=this.generation;
    const wait=Math.max(650,3500-(Date.now()-this.lastRequest));
    this.timer=setTimeout(()=>void this.flush(generation),wait);
  }
  private async flush(generation:number) {
    if(generation!==this.generation || !this.pending || this.blocked()) { this.cancel(); return; }
    const pending=this.pending; this.pending=null;
    const id=`touch-${Date.now()}-${generation}`;
    this.requestId=id; this.lastRequest=Date.now();
    try {
      const reply=await this.request(id,{...pending,recent_replies:this.recent.slice(-3)});
      if(generation!==this.generation || this.blocked()) return;
      this.recent=[...this.recent.slice(-2),reply.text];
      this.deliver(reply,pending.region);
    } catch(error) {
      if(generation===this.generation && !this.blocked()) this.error(String(error));
    } finally {
      if(generation===this.generation) {this.requestId=null;this.thinking(false);}
    }
  }
}
