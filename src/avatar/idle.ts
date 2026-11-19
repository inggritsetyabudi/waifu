import type { ActionStage } from './conversation';

type Step = { pose: string; expression: string; gesture: string; duration: number };
type Routine = { id: string; label: string; steps: Step[] };
const routines: Routine[] = [
  { id:'heart',label:'Pose hati',steps:[
    {pose:'shy',expression:'blush',gesture:'heart',duration:2600},
    {pose:'greeting',expression:'wink',gesture:'peace',duration:2200}] },
  { id:'tea',label:'Istirahat minum teh',steps:[
    {pose:'relaxed',expression:'smile',gesture:'sip_tea',duration:3200},
    {pose:'thinking',expression:'neutral',gesture:'check_phone',duration:2400}] },

  { id:'peek', label:'Melirik penasaran', steps:[
    {pose:'thinking',expression:'neutral',gesture:'lean_left',duration:2200},
    {pose:'relaxed',expression:'smile',gesture:'lean_right',duration:2300}] },
  { id:'wink', label:'Lagi usil', steps:[
    {pose:'confident',expression:'wink',gesture:'peace',duration:1800},
    {pose:'greeting',expression:'smile',gesture:'wave',duration:2400}] },
  { id:'ponder', label:'Melamun sebentar', steps:[
    {pose:'thinking',expression:'neutral',gesture:'check_phone',duration:2800},
    {pose:'relaxed',expression:'smile',gesture:'stretch',duration:2000}] },
  { id:'proud', label:'Pamer pose', steps:[
    {pose:'confident',expression:'smile',gesture:'money',duration:2200},
    {pose:'celebrate',expression:'wink',gesture:'excited_hands',duration:1800}] },
  { id:'shy', label:'Malu sendiri', steps:[
    {pose:'shy',expression:'blush',gesture:'heart',duration:2400},
    {pose:'relaxed',expression:'smile',gesture:'lean_right',duration:2200}] },
  {id:'dance',label:'Dance kecil',steps:[
    {pose:'celebrate',expression:'smile',gesture:'dance',duration:3200},
    {pose:'greeting',expression:'wink',gesture:'bow',duration:2000}]},
  {id:'stretch',label:'Meregangkan badan',steps:[
    {pose:'relaxed',expression:'neutral',gesture:'stretch',duration:3000},
    {pose:'relaxed',expression:'smile',gesture:'lean_right',duration:2200}]},
  {id:'peekaboo',label:'Main cilukba',steps:[
    {pose:'thinking',expression:'wink',gesture:'lean_left',duration:1800},
    {pose:'greeting',expression:'smile',gesture:'lean_right',duration:1800},
    {pose:'celebrate',expression:'smile',gesture:'bounce',duration:2200}]},
  {id:'showtime',label:'Pamer gaya',steps:[
    {pose:'confident',expression:'smile',gesture:'money',duration:2600},
    {pose:'greeting',expression:'wink',gesture:'peace',duration:2200}]},
  { id:'sleepy', label:'Santai sebentar', steps:[
    {pose:'relaxed',expression:'sleepy',gesture:'sip_tea',duration:3000},
    {pose:'relaxed',expression:'smile',gesture:'stretch',duration:2200}] },
];

/** Local, silent routines. One owner; interactions always take priority. */
export class IdleCompanion {
  private nextAt: number;
  private routine: Routine | null = null;
  private step = 0;
  private stepUntil = 0;
  private previous = '';
  private quietSince: number;
  constructor(private stage:()=>ActionStage|null, private label:(text:string)=>void,
    private random= Math.random, now=Date.now()) {
    this.quietSince=now;
    this.nextAt=now+this.delay(false);
  }
  get active() { return this.routine !== null; }
  private delay(reduced:boolean) { return (reduced?16000:9000)+this.random()*(reduced?12000:9000); }
  interrupt(now=Date.now(), reduced=false) {
    if(this.active) {
      const stage=this.stage();
      stage?.gesture?.('none'); stage?.pose?.('neutral'); stage?.setSemanticExpression?.('neutral');
      this.routine=null; this.label('');
    }
    this.quietSince=now;
    this.nextAt=now+this.delay(reduced);
  }
  tick(now:number, blocked:boolean, affectionate:boolean, reduced:boolean) {
    if(blocked || !this.stage()) { this.interrupt(now,reduced); return; }
    if(this.routine) {
      if(now<this.stepUntil) return;
      ++this.step;
      if(this.step>=this.routine.steps.length) {
        const quietSince=this.quietSince;
        this.interrupt(now,reduced);
        this.quietSince=quietSince;
        return;
      }
    } else {
      if(now<this.nextAt) return;
      // No consecutive repeats. Sleepy routines only after a longer quiet period.
      const choices=routines.filter(r=>r.id!==this.previous && (r.id!=='sleepy' || now-this.quietSince>=60000));
      const pool=affectionate && this.previous!=='shy' && this.random()<.35
        ? choices.filter(r=>r.id==='shy') : choices;
      this.routine=pool[Math.min(pool.length-1,Math.floor(this.random()*pool.length))];
      this.previous=this.routine.id;
      this.step=0;
      this.label(this.routine.label);
    }
    const action=this.routine.steps[this.step];
    const duration=action.duration*(reduced?1.25:1);
    const stage=this.stage();
    stage?.pose?.(action.pose,duration);
    stage?.setSemanticExpression?.(action.expression,duration);
    stage?.gesture?.(action.gesture,duration);
    this.stepUntil=now+duration;
  }
}
