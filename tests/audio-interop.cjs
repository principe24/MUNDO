"use strict";
// Render the same authored world through the native player mixer and the browser's
// offline mixer. Include real encoded PCM, channel interleaving and clip identity.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const {spawnSync} = require("node:child_process");
const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const {MundoWorld: World} = require("../server/room-runtime.cjs");
const Audio = require("../web/audio-scene.js"), DSP = require("../web/audio-dsp.js"), Clips = require("../web/audio-clips.js");

const binary = process.argv[2];
if (!binary) throw Error("Pass the native audio mixer test executable.");
const directory = fs.mkdtempSync(path.join(os.tmpdir(),"mundo-audio-interop-"));
const worldPath = path.join(directory,"studio.mworld"), out = path.join(directory,"native.f32"), wav = path.join(directory,"clip.wav");
const frames = 32768;
let comparisons = 0, largestDifference = 0;

function run(args, status = 0) {
  const result = spawnSync(binary, [worldPath,out,...args], {encoding:"utf8"});
  if (result.error) throw result.error;
  assert.equal(result.status,status,result.stderr);
}
function compare(world,rate,clip,live=false) {
  fs.writeFileSync(worldPath, World.encode(world));
  const mix = DSP.create(rate);
  const sources = Audio.read(world);
  mix.setSources(sources);
  const args = [String(rate)];
  if (clip) {
    fs.writeFileSync(wav, clip.bytes);
    mix.setClip(clip.key, Clips.decode(clip.bytes));
    args.push(clip.key,wav);
  }
  if (live) args.push("live");
  run(args);
  const left = new Float32Array(frames), right = new Float32Array(frames);
  if (live) {
    let cursor=0;
    function to(end) {mix.render(left.subarray(cursor,end),right.subarray(cursor,end));cursor=end;}
    to(37);
    mix.setListener([.3,-.1,2],.81); to(888);
    mix.setGroupVolume("musica",.25); mix.setVolume(.63); to(2801);
    mix.setPaused(true); to(3721); mix.setPaused(false);
    sources[0] = {...sources[0], position:[-2,1,0], playbackRate:3.4};
    mix.setSources(sources);
    for (const s of sources) if (!s.loop) assert.ok(mix.trigger(s.id));
    to(5603); mix.clearClips(); to(9611);
    mix.setClip(clip.key, Clips.decode(clip.bytes)); to(16381);
    mix.setListener([9999,1,0],-1.3); to(24017);
    mix.setListener([.2,0,0],2.2); to(frames);
  } else mix.render(left,right);
  const native = fs.readFileSync(out);
  assert.equal(native.length,frames*8);
  let energy = 0, error = 0;
  for (let i=0; i<frames; ++i) {
    energy += left[i]*left[i]+right[i]*right[i];
    error = Math.max(error,Math.abs(native.readFloatLE(i*8)-left[i]),Math.abs(native.readFloatLE(i*8+4)-right[i]));
  }
  assert.ok(energy>0,"fixture must be audible");
  assert.ok(error<0.000002,"cross-renderer PCM amplitude difference "+error);
  largestDifference = Math.max(largestDifference,error);
  comparisons += frames*2;
}
try {
  const base = {label:"Arroyo / Norte",radius:12,volume:.85,position:[1,.5,-1]};
  const bytes = Clips.encodeMono(Float32Array.from({length:389},(_,i)=>Math.sin(i*.47)*.7+.1));
  const clip = {key:"s"+createHash("sha256").update(bytes).digest("hex").slice(0,16),bytes};
  const world = World.empty();
  // Exercise IDs that exceed JavaScript's exact integer range as decimal RNG seeds.
  world.next = 9007199254741200n;
  for (const [preset,extras] of [
    ["brisa",{}],["agua",{playbackRate:1.75,spatial:"2d",group:"efectos",loop:false}],
    ["maquina",{playbackRate:.25,position:[0,1,3]}],
    [clip.key,{playbackRate:2.17,group:"musica",position:[-.75,0,0]}],
    [clip.key,{playbackRate:.53,loop:false,spatial:"2d",group:"voces"}]]) {
    Audio.add(world,{...base,preset,...extras});
  }
  for (const rate of [8000,44100,48000,192000]) {
    compare(world,rate,clip);
    compare(world,rate,clip,true);
  }
  for (const preset of Audio.presets) {
    const single = World.empty();
    Audio.add(single,{...base,preset});
    compare(single,48000);
  }
  const broken = World.fork(world);
  const first = [...broken.nodes.values()][0];
  broken.nodes.set(first.id,{...first,name:"MUNDO/Audio/v2/agua/1200/400/2d/100/once/desconocido/Prueba"});
  assert.throws(()=>Audio.read(broken));
  fs.writeFileSync(worldPath,World.encode(broken)); run([],2);
  fs.writeFileSync(worldPath,World.encode(world)); fs.writeFileSync(wav,bytes);
  run(["48000","s0000000000000000",wav],3);
  console.log(comparisons+" native/browser channel samples matched. Maximum absolute difference "+largestDifference);
} finally {
  fs.rmSync(directory,{force:true,recursive:true});
}
