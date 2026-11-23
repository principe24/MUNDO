"use strict";
(() => {
const historyLimit=8;
const savedFields=new Set(["run","passed","total","phase","elapsedMs","bestMs","nextId","armed","timing","startMode"]);
const ms=value=>Number.isSafeInteger(value) && value>=0;
const object=value=>value!==null && typeof value==="object" && !Array.isArray(value);
const unknown=count=>Array(count).fill(null);

// An old checkpoint can be missing a prefix. Once a host has seen a crossing,
// every subsequent split on that lap is known, in chronological order.
function validSplits(values,count,ceiling,flying=false){
  if(!Array.isArray(values) || values.length!==count)return false;
  if(flying && count && values[0]!==0)return false;
  let previous=null;
  // Flying starts have a known zero even when a compact checkpoint lost the following prefix.
  for(let i=flying?1:0;i<count;++i){
    const value=values[i];
    if(value===null && previous===null)continue;
    if(!ms(value) || value>ceiling || (previous!==null && value<previous))return false;
    previous=value;
  }
  return true;
}
function complete(values,count,time){
  return ms(time) && validSplits(values,count,time) && values[0]!==null && values[count-1]===time;
}
function referenceOf(count,time,series){
  if(series!==null)return series.slice();
  const values=unknown(count);
  if(count)values[count-1]=time;
  return values;
}
function validReference(values,count,time){
  if(!Array.isArray(values) || values.length!==count)return false;
  if(time===null)return values.every(v=>v===null);
  return complete(values,count,time) || (ms(time) && values[count-1]===time && values.slice(0,-1).every(v=>v===null));
}
function copyLap(lap){
  return {run:lap.run,elapsedMs:lap.elapsedMs,splits:lap.splits.slice(),
    reference:lap.reference.slice(),referenceTotalMs:lap.referenceTotalMs};
}
function sameSeries(a,b){return a.length===b.length && a.every((v,i)=>v===b[i]);}
function knownReference(best,time){return time===null || (ms(best) && best<=time);}
function validSavedTiming(data){
  const t=data.timing,count=data.total,flying=data.startMode==="flying";
  if(!object(t) || t.version!==1 || !validSplits(t.splits,data.passed,data.elapsedMs,flying) ||
     !validReference(t.reference,count,t.referenceTotalMs) || !knownReference(data.bestMs,t.referenceTotalMs) ||
     (flying && t.reference[0]!==null && t.reference[0]!==0) ||
     (t.bestSplits!==null && (!complete(t.bestSplits,count,data.bestMs) || (flying && t.bestSplits[0]!==0))) ||
     (data.phase==="finished" && t.splits[count-1]!==data.elapsedMs) ||
     !Array.isArray(t.history) || t.history.length>historyLimit)return false;
  let lastRun=0;
  for(const lap of t.history){
    if(!object(lap) || !Number.isSafeInteger(lap.run) || lap.run<=lastRun || lap.run>data.run ||
       !ms(lap.elapsedMs) || data.bestMs===null || lap.elapsedMs<data.bestMs ||
       !validSplits(lap.splits,count,lap.elapsedMs,flying) || lap.splits[count-1]!==lap.elapsedMs ||
       !validReference(lap.reference,count,lap.referenceTotalMs) || !knownReference(data.bestMs,lap.referenceTotalMs) ||
       (flying && lap.reference[0]!==null && lap.reference[0]!==0))return false;
    if(lap.run===data.run && (data.phase!=="finished" || lap.elapsedMs!==data.elapsedMs ||
       lap.referenceTotalMs!==t.referenceTotalMs || !sameSeries(lap.splits,t.splits) ||
       !sameSeries(lap.reference,t.reference)))return false;
    lastRun=lap.run;
  }
  return true;
}

// Only the accepted motion of the host's chassis reaches this clock.
class CircuitRun {
  constructor(gates,record=null,startMode="movement"){
    if(!Array.isArray(gates) || gates.length<1 || gates.length>32)throw RangeError("El circuito requiere de 1 a 32 puertas.");
    if(!["movement","flying"].includes(startMode) || (startMode==="flying" && gates.length<2))
      throw RangeError("La salida lanzada necesita al menos dos puertas y un modo válido.");
    this.startMode=startMode;
    this.record=record;this.gates=gates;this.run=1;this.bestMs=null;this.bestSplits=null;this.history=[];this.clear();
  }
  clear(){
    this.passed=0;this.started=null;this.finished=null;this.carriedMs=0;this.armed=false;this.notBefore=-Infinity;
    this.splits=[];this.reference=null;this.referenceTotalMs=null;
  }
  restart(now){
    if(this.run>=Number.MAX_SAFE_INTEGER)throw RangeError("Se agotó el contador de vueltas de esta sala.");
    this.run++;this.clear();this.notBefore=now;
  }
  best(){
    const disk=this.record?.best??null;
    return this.bestMs===null?disk:disk===null?this.bestMs:Math.min(this.bestMs,disk);
  }
  bestSeries(time){
    if(time===null)return null;
    if(this.record?.best===time){
      const series=this.record.splits;
      if(complete(series,this.gates.length,time) && (this.startMode!=="flying" || series[0]===0))return series.slice();
    }
    return this.bestMs===time && this.bestSplits!==null?this.bestSplits.slice():null;
  }
  currentLap(elapsedMs){
    const referenceTotalMs=this.started===null?this.best():this.referenceTotalMs;
    const series=this.started===null?this.bestSeries(referenceTotalMs):this.reference;
    return {run:this.run,elapsedMs,splits:this.splits.slice(),referenceTotalMs,
      reference:referenceOf(this.gates.length,referenceTotalMs,series)};
  }
  start(at){
    this.started=at;this.referenceTotalMs=this.best();this.reference=this.bestSeries(this.referenceTotalMs);
  }
  move(x0,z0,x1,z1,y,t0,t1){
    if(this.finished!==null || (x0===x1 && z0===z1) || t1<=this.notBefore)return;
    if(t0<this.notBefore){
      const cut=(this.notBefore-t0)/(t1-t0);
      x0+=(x1-x0)*cut;z0+=(z1-z0)*cut;t0=this.notBefore;
    }
    if(this.started===null && this.startMode==="movement")this.start(t0);
    let previous=-1;
    for(;this.passed<this.gates.length;){
      const gate=this.gates[this.passed], [cx,floor,cz]=gate.point;
      const d0=(x0-cx)*gate.forwardX+(z0-cz)*gate.forwardZ;
      const d1=(x1-cx)*gate.forwardX+(z1-cz)*gate.forwardZ;
      if(d0<=-.01)this.armed=true;
      if(!this.armed || !(d0<0 && d1>=0))break;
      this.armed=false;
      const hit=d0/(d0-d1);
      if(hit<=previous)break;
      const side=(x0+(x1-x0)*hit-cx)*gate.rightX+(z0+(z1-z0)*hit-cz)*gate.rightZ;
      if(Math.abs(side)>gate.width/2 || y<floor || y>floor+gate.height)break;
      const crossing=t0+(t1-t0)*hit;
      if(this.started===null)this.start(crossing);
      const duration=this.elapsed(crossing);
      this.splits.push(duration);
      this.passed++;previous=hit;
      if(this.passed===this.gates.length){
        this.finished=crossing;
        const series=complete(this.splits,this.gates.length,duration)?this.splits.slice():null;
        if(this.bestMs===null || duration<this.bestMs || (duration===this.bestMs && !this.bestSplits && series)){
          this.bestMs=duration;this.bestSplits=series;
        }
        this.record?.offer(this.bestMs,this.bestSplits);
        this.history.push(this.currentLap(duration));
        if(this.history.length>historyLimit)this.history.shift();
      }
    }
  }
  elapsed(now){
    if(this.started===null)return 0;
    const localMs=Math.max(0,Math.floor((this.finished??now)-this.started));
    return Math.min(Number.MAX_SAFE_INTEGER,this.carriedMs+localMs);
  }
  checkpoint(now){
    const {split,...base}=this.snapshot(now);
    const lap=this.currentLap(base.elapsedMs);
    return {...base,armed:this.armed,...(this.startMode==="flying"?{startMode:"flying"}:{}),timing:{version:1,splits:lap.splits,reference:lap.reference,
      referenceTotalMs:lap.referenceTotalMs,bestSplits:this.bestSeries(base.bestMs),history:this.history.map(copyLap)}};
  }
  canRestoreCheckpoint(data,now){
    if(!Number.isFinite(now) || !object(data) || Object.keys(data).some(key=>!savedFields.has(key)) ||
       (Object.hasOwn(data,"startMode")?data.startMode!=="flying" || this.startMode!=="flying":this.startMode!=="movement"))return false;
    const {run,total,passed,phase,elapsedMs,bestMs,nextId,armed}=data;
    if(!Number.isSafeInteger(run) || run<1 || total!==this.gates.length ||
       !Number.isInteger(passed) || passed<0 || passed>total || typeof armed!=="boolean" ||
       !ms(elapsedMs) || (bestMs!==null && !ms(bestMs)))return false;
    if(nextId!==(passed<total?String(this.gates[passed].id):null) ||
       (Object.hasOwn(data,"timing") && !validSavedTiming(data)))return false;
    switch(phase){
      case "ready": return passed===0 && elapsedMs===0 && (!armed || this.startMode==="flying");
      case "running": return passed<total && (passed>0 || this.startMode==="movement");
      case "finished": return passed===total && !armed && bestMs!==null && bestMs<=elapsedMs;
      default: return false;
    }
  }
  restoreCheckpoint(data,now){
    if(!this.canRestoreCheckpoint(data,now))return false;
    this.run=data.run;this.passed=data.passed;this.carriedMs=data.elapsedMs;
    this.started=data.phase==="ready"?null:now;this.finished=data.phase==="finished"?now:null;
    this.armed=data.armed;this.notBefore=now;this.bestMs=data.bestMs;
    const t=data.timing;
    this.bestSplits=t?.bestSplits?.slice()??null;
    this.splits=t?t.splits.slice():unknown(this.passed);
    if(this.passed && this.startMode==="flying")this.splits[0]=0;
    if(this.finished!==null)this.splits[this.passed-1]=data.elapsedMs;
    this.referenceTotalMs=t?.referenceTotalMs??null;
    this.reference=t && complete(t.reference,this.gates.length,this.referenceTotalMs)?t.reference.slice():null;
    this.history=t?t.history.map(copyLap):[];
    if(this.finished!==null && this.history.at(-1)?.run!==this.run){
      this.history.push(this.currentLap(data.elapsedMs));
      if(this.history.length>historyLimit)this.history.shift();
    }
    // A compacted checkpoint may still contain the record lap in its retained history.
    if(this.bestSplits===null && this.bestMs!==null){
      const record=this.history.find(lap=>lap.elapsedMs===this.bestMs && complete(lap.splits,this.gates.length,this.bestMs));
      if(record)this.bestSplits=record.splits.slice();
    }
    return true;
  }
  snapshot(now){
    const i=this.passed-1,atMs=this.splits[i];
    const referenceMs=this.reference?.[i]??(i===this.gates.length-1?this.referenceTotalMs:null);
    return {run:this.run,passed:this.passed,total:this.gates.length,
      phase:this.finished!==null?"finished":this.started!==null?"running":"ready",elapsedMs:this.elapsed(now),
      bestMs:this.best(),nextId:this.passed<this.gates.length?String(this.gates[this.passed].id):null,
      split:atMs==null?null:{atMs,referenceMs}};
  }
  timing(now){
    const lap=this.currentLap(this.elapsed(now));
    return {...lap,startMode:this.startMode,phase:this.finished!==null?"finished":this.started!==null?"running":"ready",
      passed:this.passed,total:this.gates.length,bestMs:this.best(),history:this.history.map(copyLap)};
  }
}
if(typeof module!=="undefined" && module.exports)module.exports={CircuitRun};
else globalThis.MundoCircuitRun=CircuitRun;
})();
