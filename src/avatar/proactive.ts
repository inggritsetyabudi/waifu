import type { TouchReply } from './touchResponder';
export interface IdleContext { recent_replies:string[]; quiet_seconds:number }
/** Occasional AI initiative, with cancellation and a quiet interval after any interaction. */
export class ProactiveCompanion {
  private nextAt:number;
  private quietSince:number;
  private id:string|null=null;
  private generation=0;
  private recent:string[]=[];
  constructor(private request:(id:string,context:IdleContext)=>Promise<TouchReply>,
    private cancelRequest:(id:string)=>void, private deliver:(reply:TouchReply,isCurrent:()=>boolean)=>Promise<void>,
    private thinking:(active:boolean)=>void, private random=Math.random, now=Date.now()) {
    this.quietSince=now;this.nextAt=now+30000+this.random()*15000;
  }
  interrupt(now=Date.now()) {
    ++this.generation;
    if(this.id) this.cancelRequest(this.id);
    this.id=null;this.thinking(false);
    this.quietSince=now;this.nextAt=now+45000+this.random()*45000;
  }
  tick(now:number,blocked:boolean) {
    if(blocked) {this.interrupt(now);return;}
    if(this.id || now<this.nextAt) return;
    const generation=++this.generation;
    const id=`idle-${now}-${generation}`;this.id=id;this.thinking(true);
    void this.request(id,{recent_replies:this.recent.slice(-3),quiet_seconds:Math.floor((now-this.quietSince)/1000)})
      .then(async reply=>{
        if(generation!==this.generation) return;
        this.recent=[...this.recent.slice(-2),reply.text];
        this.thinking(false);
        await this.deliver(reply,()=>generation===this.generation);
      }).catch(()=>{/* Idle failures stay quiet; ordinary conversation remains available. */})
      .finally(()=>{if(generation===this.generation) this.interrupt(Date.now());});
  }
}
