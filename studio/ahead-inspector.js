"use strict";

window.MundoAheadInspector=(()=>{
  const width=64;
  function segment(a,b){
    if(!a || !b || a.length!==2 || b.length!==2 || ![...a,...b].every(Number.isFinite))return null;
    const x=a[0],z=a[1],distance=Math.hypot(b[0]-x,b[1]-z);
    if(!Number.isFinite(distance) || distance===0)return null;
    const dx=(b[0]-x)/distance,dz=(b[1]-z)/distance;
    return {x,z,endX:b[0],endZ:b[1],dx,dz,length:distance,yaw:Math.atan2(dx,-dz)};
  }
  function tolerance(s){
    return Math.max(1e-7,16*Number.EPSILON*Math.max(Math.abs(s.x),Math.abs(s.z),s.length,1));
  }

  // Intersections with the X and Z grid lines form two arithmetic sequences
  // of distances along the segment. Even a long authoring segment costs O(1).
  function grid(s){
    const lines=[];
    for(const [p,v] of [[s.x,s.dx],[s.z,s.dz]]){
      if(v===0)continue;
      const edge=MundoZones.cell(p)*width+Math.sign(v)*width/2;
      lines.push({first:Math.max(0,(edge-p)/v),period:width/Math.abs(v)});
    }
    return lines;
  }
  function nearCrossing(s,meters,speed,step){
    if(!s || !Number.isFinite(meters) || !Number.isFinite(speed) || (step!==1 && step!==-1))return null;
    const pos=Math.max(0,Math.min(s.length,meters)), eps=tolerance(s);
    const lines=grid(s),distances=[];
    for(const {first,period} of lines){
      const center=Math.max(0,Math.floor((pos-first)/period));
      for(let i=Math.max(0,center-3);i<=center+3;++i){
        const d=first+i*period;
        if(d>=0 && d<=s.length+eps)distances.push(Math.min(d,s.length));
      }
    }
    const probes=[];
    for(const edge of distances){
      let before=0;
      for(const {first,period} of lines){
        const i=Math.floor((edge-eps-first)/period);
        if(i>=0)before=Math.max(before,first+i*period);
      }
      // Place the car inside the approach cell, including very short diagonal slivers.
      const probe=edge-Math.min(Math.max(.5,Math.abs(speed)*1.2),(edge-before)/2);
      if((probe-pos)*step>eps)probes.push(probe);
    }
    return probes.length?(step>0?Math.min(...probes):Math.max(...probes)):null;
  }
  function sample(s,meters,speed){
    const d=Math.max(0,Math.min(s.length,meters));
    const x=d===s.length?s.endX:s.x+s.dx*d,z=d===s.length?s.endZ:s.z+s.dz*d;
    // In reverse the nose points toward A, while the path of the vehicle is still A to B.
    let aim=d<s.length?MundoZones.aheadWindow(x,z,s.yaw+(speed<0?Math.PI:0),speed):null;
    if(aim){
      // A diagonal prediction may include a second edge just past the stop.
      // Display only predicted centres actually reached by this straight segment.
      if(aim.axisX*(MundoZones.cell(s.endX)-aim.cx)<0 ||
         aim.axisZ*(MundoZones.cell(s.endZ)-aim.cz)<0)aim=null;
    }
    return {x,z,aim};
  }

  // The adjacent squares and all cells share one integer lattice. Large world
  // coordinates affect only labels, never the pixel coordinates sent to the canvas.
  function draw(canvas,aim,profile,lookup,selected,via=null){
    const ctx=canvas.getContext("2d");
    if(!ctx)return;
    const w=canvas.width,h=canvas.height;
    ctx.clearRect(0,0,w,h);
    if(!aim)return;
    const r=profile==="mobile"?1:2;
    const mx=via==="x"?aim.cx:aim.fromX,mz=via==="z"?aim.cz:aim.fromZ;
    const hasMiddle=via!==null && MundoZones.diagonalVia(aim,mx,mz)===via;
    const left=Math.min(aim.fromX,aim.cx)-r,top=Math.min(aim.fromZ,aim.cz)-r;
    const right=Math.max(aim.fromX,aim.cx)+r,bottom=Math.max(aim.fromZ,aim.cz)+r;
    const side=Math.min((w-28)/(right-left+1),(h-26)/(bottom-top+1));
    if(side<=0)return;
    const ox=(w-(right-left+1)*side)/2,oz=(h-(bottom-top+1)*side)/2;
    const px=x=>ox+(x-left)*side,pz=z=>oz+(z-top)*side;
    const rank=new Map(selected.map((row,i)=>[row.x+","+row.z,i+1]));
    ctx.save();ctx.textAlign="center";ctx.textBaseline="middle";
    ctx.font="bold "+Math.max(12,Math.min(19,Math.floor(side*.43)))+"px system-ui";
    for(let z=top;z<=bottom;++z){
      for(let x=left;x<=right;++x){
        const current=Math.abs(x-aim.fromX)<=r && Math.abs(z-aim.fromZ)<=r;
        const future=Math.abs(x-aim.cx)<=r && Math.abs(z-aim.cz)<=r;
        const middle=hasMiddle && Math.abs(x-mx)<=r && Math.abs(z-mz)<=r;
        if(!current && !future && !middle)continue;
        const row=lookup(x,z),n=rank.get(x+","+z);
        ctx.fillStyle=current?"#294451":n?(row?.road?"#aee5c7":"#f0c382"):row?"#705a49":"#3a434b";
        ctx.fillRect(px(x)+1,pz(z)+1,side-2,side-2);
        if(n){ctx.fillStyle="#15211e";ctx.fillText(String(n),px(x)+side/2,pz(z)+side/2);}
      }
    }
    const outline=(cx,cz,color,dash,inset)=>{
      ctx.strokeStyle=color;ctx.setLineDash(dash);ctx.lineWidth=2;
      ctx.strokeRect(px(cx-r)+inset,pz(cz-r)+inset,(2*r+1)*side-2*inset,(2*r+1)*side-2*inset);
    };
    outline(aim.fromX,aim.fromZ,"#90ccef",[],1);
    outline(aim.cx,aim.cz,"#ffc76f",[6,4],4);
    if(hasMiddle)outline(mx,mz,"#c3a9ff",[2,3],7);
    ctx.restore();
  }
  return {segment,sample,nearCrossing,draw};
})();
