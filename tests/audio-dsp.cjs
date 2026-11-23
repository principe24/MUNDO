"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const dsp = require("../web/audio-dsp.js");
const sampleRate=24000;
const source=(fields={})=>({id:"19",label:"Sonido",preset:"maquina",position:[0,0,0],radius:10,volume:1,...fields});
const rms = a => Math.sqrt(a.reduce((sum,x)=>sum+x*x,0)/a.length);
function render(mix,n=8192) {
  const l=new Float32Array(n),r=new Float32Array(n);
  mix.render(l,r);return [l,r];
}
function setup(s=source(),rate=sampleRate) {const m=dsp.create(rate);m.setSources([s]);return m;}

test("los tres ambientes originales producen PCM estéreo finito, distinto y reproducible",()=>{
  const crypto=require("node:crypto");
  const hashes=new Set();
  for(const preset of ["brisa","agua","maquina"]) {
    const s=source({preset}), [left,right]=render(setup(s),18000);
    assert.ok(rms(left)>.002 && left.every(Number.isFinite));
    assert.deepEqual(left,right);
    assert.deepEqual(render(setup(s),18000)[0],left);
    hashes.add(crypto.createHash("sha256").update(Buffer.from(left.buffer)).digest("hex"));
  }
  assert.equal(hashes.size,3);
});

test("el alcance 3D, la altura y la orientación deciden atenuación y lado",()=>{
  const at=(p,yaw=0) => {const m=setup(source({position:p})); m.setListener([0,0,0],yaw);return render(m).map(rms);};
  const mid=at([0,0,0]),near=at([0,0,2]),far=at([0,0,8]);
  assert.ok(mid[0]>near[0] && near[0]>far[0]*7 && far[0]>0);
  assert.deepEqual(at([0,10,0]),[0,0]);
  const right=at([2,0,0]),left=at([2,0,0],Math.PI);
  assert.equal(right[0],0);assert.ok(right[1]>.01);
  assert.equal(left[1],0);assert.ok(left[0]>.01);
  const m=setup(source({position:[2,0,0]}));
  render(m,500);m.setListener([200,0,1000],0);
  const a=render(m,500);assert.ok(a[1].subarray(240).every(v=>v===0));
});

test("una fuente 2D se mantiene centrada incluso lejos del oyente",()=>{
  const a=setup(source({spatial:"2d",position:[3,70,-2]})),b=setup(source({spatial:"2d"}));
  b.setListener([1e5,1000,-200],Math.PI/3);
  assert.deepEqual(render(a),render(b));
});

test("la mezcla conserva fase y semilla entre bloques, ediciones y pausas",()=>{
  const m=setup(),a=render(m,221)[0];
  m.setPaused(true);assert.equal(rms(render(m,121)[0]),0);
  m.setPaused(false);m.setSources([source({label:"editado"})]);const b=render(m,979)[0];
  assert.deepEqual(Float32Array.from([...a,...b]),render(setup(),1200)[0]);
  m.reset();assert.equal(rms(render(m)[0]),0);
  m.setSources([source()]);assert.deepEqual(render(m,221)[0],a);
});

test("el tono de la máquina cambia con la velocidad de reproducción",()=>{
  const rising=v=>{let n=0;for(let i=1;i<v.length;i++)if(v[i-1]<0 && v[i]>=0)n++;return n;};
  const slow=rising(render(setup(source({playbackRate:.5})),24000)[0]);
  const fast=rising(render(setup(source({playbackRate:2})),24000)[0]);
  assert.ok(Math.abs(fast-4*slow)<=5);
});

test("los niveles de grupo y volumen general actúan en la mezcla y mantienen la salida acotada",()=>{
  const fx=source({group:"efectos"}),mus=source({group:"musica",id:"9007199254740993",preset:"agua"});
  const m=dsp.create(sampleRate);m.setSources([fx,mus]);m.setGroupVolume("efectos",0);
  assert.deepEqual(render(m)[0],render(setup(mus))[0]);
  const solo=setup(fx),base=setup(fx);solo.setVolume(.25);
  const scaled=render(solo)[0],raw=render(base)[0];
  raw.forEach((v,i)=>assert.ok(Math.abs(scaled[i]-v*.25)<1e-6));
  m.setSources(Array.from({length:16},(_,i)=>source({id:String(i+1)})));
  const [out]=render(m);assert.ok(out.every(v=>v>-1 && v<1));assert.ok(rms(out)>.1);
});

test("one-shot sintetizado termina, permanece consumido con el mismo ID y admite un nuevo disparo",()=>{
  const s=source({preset:"agua",loop:false,playbackRate:2}),m=setup(s);
  const [first]=render(m,12000);
  assert.ok(rms(first)>.001);assert.equal(rms(render(m)[0]),0);
  m.setSources([s]);assert.equal(rms(render(m)[0]),0);
  assert.equal(m.trigger(s.id),true);assert.deepEqual(render(m,12000)[0],first);
  assert.equal(setup().trigger("19"),false);
});

test("un clip tardío se activa sin redescarga, se remuestrea y reproduce una sola vez",()=>{
  const key="s0011223344556677",m=setup(source({preset:key,loop:false}),48000);
  assert.equal(rms(render(m)[0]),0);
  const samples=Float32Array.of(.25,.5,1,-.5);
  m.setClip(key,{sampleRate,samples});
  samples.fill(0);
  const [out]=render(m,12);
  for(let i=0;i<8;i++)assert.notEqual(out[i],0);
  assert.ok(out.slice(8).every(v=>v===0));
  assert.equal(rms(render(m)[0]),0);
  assert.ok(m.trigger("19"));assert.deepEqual(render(m,12)[0],out);
  m.clearClips();assert.equal(rms(render(m)[0]),0);
});

test("un bucle de clip interpola hacia el primer fotograma y no altera la fuente compartida",()=>{
  const key="sfedcba9876543210",s=source({preset:key,spatial:"2d",group:"musica",playbackRate:.5});
  const m=setup(s);m.setClip(key,{sampleRate,samples:Float32Array.of(1,-1)});
  const [out]=render(m,600);
  assert.ok(out[596]>.4 && out[598]<-.4);
  assert.equal(out[597],0);
  assert.equal(out[599],0);
  m.reset();m.setSources([s]);assert.deepEqual(render(m,6)[0],new Float32Array(6));
});

test("una fuente one-shot inaudible espera al oyente sin rearmarse al salir del alcance",()=>{
  const s=source({position:[50,0,0],preset:"agua",loop:false,playbackRate:4}),m=setup(s);
  assert.equal(rms(render(m,18000)[0]),0);
  m.setListener([49,0,0],0);assert.ok(rms(render(m,3000)[1])>.001);
  m.setListener([0,0,0],0);render(m,6000);
  m.setListener([49,0,0],0);assert.equal(rms(render(m)[1]),0);
});

test("validación atómica de fuentes, clips, tasas y búferes",()=>{
  for (const rate of [NaN,4000,192001]) assert.throws(()=>dsp.create(rate));
  const m=setup();
  assert.throws(()=>m.setSources([source(),source()]));
  assert.throws(()=>m.setSources(Array(1)));
  assert.throws(()=>m.setSources([source({id:"18446744073709551616"})]));
  assert.throws(()=>m.setSources([source({position:[0,,0]})]));
  assert.throws(()=>m.setSources([source({playbackRate:0})]));
  assert.deepEqual(render(m,256),render(setup(),256));
  assert.throws(()=>m.setVolume(2));assert.throws(()=>m.setGroupVolume("voz",1));
  assert.throws(()=>m.setListener([0,NaN,0],1));assert.throws(()=>m.setPaused("false"));
  const overlap=new Float32Array(10);
  assert.throws(()=>m.render(overlap.subarray(0,6),overlap.subarray(4)));
  assert.throws(()=>m.setClip("s0000000000000001",{sampleRate,samples:Float32Array.of(Infinity)}));
  assert.throws(()=>m.setClip("s0000000000000001",{sampleRate:48000,samples:Float32Array.of(.2)}));
  for(let i=0;i<16;i++)m.setClip("s"+i.toString(16).padStart(16,"0"),{sampleRate,samples:Float32Array.of(.2)});
  assert.throws(()=>m.setClip("sffffffffffffffff",{sampleRate,samples:Float32Array.of(0)}));
  m.clearClips();m.setClip("sffffffffffffffff",{sampleRate,samples:Float32Array.of(0)});
});

test("el bus de voces se puede mezclar y silenciar de forma independiente",()=>{
  const speech=source({group:"voces",id:"2"}),music=source({group:"musica",id:"3"});
  const m=dsp.create(sampleRate);
  m.setSources([speech,music]);m.setGroupVolume("musica",0);
  assert.deepEqual(render(m,512),render(setup(speech),512));
  m.setGroupVolume("voces",0);
  assert.equal(rms(render(m)[0]),0);
});

test("pausar una voz mantiene su muestra exacta y las demás siguen avanzando",()=>{
  const m=dsp.create(sampleRate);
  const first=source({preset:"brisa",position:[-1,0,0]}),other=source({id:"20",position:[1,0,0]});
  const reference=setup(first),isolated=setup(other);
  m.setSources([first,other]);
  render(m,333);render(reference,333);render(isolated,333);
  assert.equal(m.setSourcePaused("999",true),false);
  assert.equal(m.setSourcePaused(first.id,true),true);
  assert.throws(()=>m.setSourcePaused(first.id,0));
  m.setSources([first,other]);
  const [l,r]=render(m,741);
  assert.ok(l.every(v=>v===0));assert.deepEqual(r,render(isolated,741)[1]);
  m.setSourcePaused(first.id,false);
  assert.deepEqual(render(m,1051)[0],render(reference,1051)[0]);

  const event={...first,loop:false,preset:"agua"};
  m.setSources([event]);m.setSourcePaused(event.id,true);assert.ok(m.trigger(event.id));
  assert.ok(render(m,600)[0].every(v=>v===0));
  m.setSourcePaused(event.id,false);
  assert.deepEqual(render(m,801)[0],render(setup(event),801)[0]);
  m.setSourcePaused(event.id,true);m.setSources([]);m.setSources([event]);
  assert.deepEqual(render(m,801)[0],render(setup(event),801)[0]);
  m.setSourcePaused(event.id,true);m.setSources([first]);
  assert.deepEqual(render(m,910)[0],render(setup(first),910)[0]);
});
