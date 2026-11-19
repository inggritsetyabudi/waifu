export interface VitalityInput {
  time:number; dt:number; pointer:{x:number;y:number}; pointerAge:number;
  speaking:number; listening:boolean; acting:boolean; reduced:boolean;
}
/** Continuous rig motion between deliberate actions; eyes lead the head and torso. */
export class AvatarVitality {
  private nextLook=0;
  private target={x:0,y:0};
  private eyes={x:0,y:0};
  private head={x:0,y:0};
  private talk=0;
  private attention=0;
  constructor(private random=Math.random) {}
  sample(input:VitalityInput) {
    const {time:t}=input,dt=Math.min(.1,Math.max(0,input.dt));
    if(t>=this.nextLook) {
      const center=this.random()<.4;
      this.target=center?{x:0,y:0}:{x:(this.random()-.5)*.9,y:(this.random()-.5)*.45};
      this.nextLook=t+2+this.random()*3.5;
    }
    const pointerWeight=Math.max(0,Math.min(1,(3-input.pointerAge)/.8));
    let targetX=this.target.x*(1-pointerWeight)+Math.max(-.85,Math.min(.85,input.pointer.x))*pointerWeight;
    let targetY=this.target.y*(1-pointerWeight)+Math.max(-.6,Math.min(.6,input.pointer.y))*pointerWeight;
    const lerp=(current:number,target:number,seconds:number)=>current+(target-current)*(1-Math.exp(-dt/seconds));
    this.attention=lerp(this.attention,input.listening?1:0,.65);
    targetX*=1-this.attention*.7;targetY*=1-this.attention*.7;
    this.eyes.x=lerp(this.eyes.x,targetX,.11);this.eyes.y=lerp(this.eyes.y,targetY,.11);
    this.head.x=lerp(this.head.x,this.eyes.x,.65);this.head.y=lerp(this.head.y,this.eyes.y,.65);
    this.talk=lerp(this.talk,input.speaking,.14);
    const strength=(input.reduced?.3:1)*(input.acting?.35:1);
    const breath=.5+Math.sin(t*1.65)*.21+Math.sin(t*2.7)*.025;
    const weightShift=Math.sin(t*.47)*.65+Math.sin(t*.23+.8)*.35;
    return {
      eyeX:this.eyes.x*.65,eyeY:-this.eyes.y*.6,
      headX:(this.head.x*9+Math.sin(t*.67)*1.1)*strength,
      headY:(-this.head.y*6+Math.sin(t*.91)*1.3+Math.sin(t*5.8)*this.talk*3-this.attention*2)*strength,
      headZ:(Math.sin(t*.53)*1.8-this.head.x*2)*strength,
      bodyX:(Math.sin(t*.63)*1.8+this.head.x)*strength,
      bodyY:((breath-.5)*3+this.talk*Math.sin(t*3.1)*1.5-this.attention)*strength,
      bodyZ:(weightShift*2.3+this.talk*Math.sin(t*2.8)*1.5)*strength,
      weightShift:weightShift*.11*strength,
      brow:(.035*Math.sin(t*1.1)+this.talk*.25+this.attention*.06)*(input.acting?.3:1),breath,
    };
  }
}
