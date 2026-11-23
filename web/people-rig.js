"use strict";
window.MundoPeopleRig=(()=>{
  const TAU=2*Math.PI,clamp=(n,a,b)=>Math.max(a,Math.min(b,n)),mix=(a,b,v)=>a+(b-a)*v;
  const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  function mul(a,b){const out=new Array(16);for(let j=0;j<4;j++)for(let i=0;i<4;i++)out[j*4+i]=a[i]*b[j*4]+a[4+i]*b[j*4+1]+a[8+i]*b[j*4+2]+a[12+i]*b[j*4+3];return out;}
  const tr=(x,y,z)=>{const a=identity();a[12]=x;a[13]=y;a[14]=z;return a;};
  function rot(x,y,z){
    const a=Math.cos(x),b=Math.sin(x),c=Math.cos(y),d=Math.sin(y),e=Math.cos(z),f=Math.sin(z);
    return [e*c,f*c,-d,0,e*d*b-f*a,f*d*b+e*a,c*b,0,e*d*a+f*b,f*d*a-e*b,c*a,0,0,0,0,1];
  }
  const sub=(a,b)=>a.map((x,i)=>x-b[i]);
  const bones=[
    [0,.842,0],[0,1.097,0],[0,1.400,.001],[0,1.468,.014],
    [-.137,1.378,0],[-.268,1.147,-.014],[-.372,.926,.022],
    [.137,1.378,0],[.268,1.147,-.014],[.372,.926,.022],
    [-.088,.886,.010],[-.121,.512,.013],[-.166,.125,.002],
    [.088,.886,.010],[.121,.512,.013],[.166,.125,.002]];
  const parent=[-1,0,1,2,1,4,5,1,7,8,0,10,11,0,13,14];
  function rig(state) {
    const time=state.t,phase=state.phase,w=state.weight,walk=Math.sin(phase*TAU),sway=w*.024*walk;
    const bob=w*(.016*Math.cos(2*phase*TAU)-.011),rest=Math.sin(time*1.45)*.003;
    const angles=Array.from({length:16},()=>[0,0,0]);
    angles[0]=[-.035*w,.050*walk*w,.036*walk*w];angles[1]=[.018*w,-.125*walk*w,-.060*walk*w];angles[2]=[-.015,.03*Math.sin(time*.65),.016*walk*w];angles[3]=[.011*Math.sin(time*.81),.019*Math.sin(time*.55),.006*Math.sin(time*.94)];
    for(let j=0;j<2;j++){
      const sign=j?1:-1, index=j?7:4, leg=j?13:10, u=(phase+j*.5)%1, stance=.60;
      const stepZ=u<stance?.65*(.5-u/stance):.65*((1-Math.cos(Math.PI*(u-stance)/(1-stance)))*.5-.5);
      const swing=u<stance?0:Math.sin(Math.PI*(u-stance)/(1-stance));
      const lift=.125*swing,vertical=.751+bob-lift,dist=Math.hypot(vertical,stepZ);
      const thigh=.389,shin=.399,limit=clamp(dist,.03,thigh+shin-.0005);
      const beta=Math.atan2(stepZ,vertical)+Math.acos(clamp((thigh*thigh+limit*limit-shin*shin)/(2*thigh*limit),-1,1));
      const bend=Math.PI-Math.acos(clamp((thigh*thigh+shin*shin-limit*limit)/(2*thigh*shin),-1,1));
      angles[leg]=[mix(-.075,-beta,w),0,-sign*(.081+.015*swing*w)];
      angles[leg+1]=[mix(.148,bend,w),0,0];angles[leg+2]=[-angles[leg][0]-angles[leg+1][0]-.045*w*swing,0,sign*.046];
      angles[index]=[.04+w*stepZ*1.27,sign*.02,-sign*(.38+.027*w*walk)];
      angles[index+1]=[-.16-w*(.11+.16*swing),0,sign*.012];
      angles[index+2]=[.06,sign*.05,.02*sign];
    }
    if(state.seated){
      angles[0]=[.045,0,0];angles[1]=[-.06,0,0];
      for(let j=0;j<2;j++){
        const leg=j?13:10,arm=j?7:4,side=j?1:-1;
        angles[leg]=[-1.40,0,side*.06];angles[leg+1]=[1.48,0,0];angles[leg+2]=[-.04,0,0];
        angles[arm]=[-.57,0,-side*.45];angles[arm+1]=[-.65,0,side*.08];
      }
    }else if(state.air>0){
      const a=state.air;
      for(const [leg,bend] of [[10,.32],[13,.55]]){
        angles[leg][0]=mix(angles[leg][0],-bend,a);
        angles[leg+1][0]=mix(angles[leg+1][0],.72,a);
      }
    }
    const globals=[],skin=[];
    let root=mul(tr(state.pos[0],state.pos[1]-.004,state.pos[2]),rot(0,state.facing,0));
    for(let i=0;i<16;i++){
      const point=bones[i],par=parent[i],rel=par<0?[point[0]+sway,point[1]+bob+rest,point[2]]:sub(point,bones[par]);
      const g=mul(par<0?root:globals[par],mul(tr(...rel),rot(...angles[i])));
      globals.push(g);skin.push(...mul(g,tr(-point[0],-point[1],-point[2])));
    }
    // Seat origins use the existing online avatar's hip height (0.78 m).
    if(state.seated){
      const offset=state.pos[1]+.78-globals[0][13];
      for(let i=0;i<16;i++)skin[i*16+13]+=offset;
      return skin;
    }
    if(state.air>.01)return skin;
    // Register both boot soles to the support plane after skinning. Include toe and heel:
    // the lowest point switches as weight rolls from one foot to the other.
    let bottom=Infinity;
    for(const sign of [-1,1]){
      const o=(sign<0?12:15)*16;
      for(const [x,y,z] of [[.1873,.0069,.1395],[.1873,.0069,-.0842],[.1274,.012,.0559],[.2436,.012,.0559],[.1812,.0344,.1616]]){
        bottom=Math.min(bottom,skin[o+1]*x*sign+skin[o+5]*y+skin[o+9]*z+skin[o+13]);
      }
    }
    const support=state.pos[1]+.005-bottom;
    for(let i=0;i<16;i++)skin[i*16+13]+=support;
    return skin;
  }
  function decode(buffer){
    const head=new DataView(buffer);if(head.getUint32(0,true)!==0x35334d42||head.getUint32(12,true)!==1)throw Error("La malla no corresponde a Bajamar.");
    const count=head.getUint32(4,true),indices=head.getUint32(8,true);
    if(count<1||count>65535||indices<3||indices%3)throw Error("Malla incompleta.");
    let off=16;
    function take(Type,n){const a=new Type(buffer,off,n);off=Math.ceil((off+n*Type.BYTES_PER_ELEMENT)/4)*4;return a;}
    const m={count,p:take(Float32Array,count*3),n:take(Int8Array,count*3),uv:take(Float32Array,count*2),c:take(Uint8Array,count*4),j:take(Uint8Array,count*4),idx:take(Uint16Array,indices)};
    if(off!==buffer.byteLength)throw Error("Longitud de malla incorrecta.");return m;
  }
  return Object.freeze({rig,decode});
})();
