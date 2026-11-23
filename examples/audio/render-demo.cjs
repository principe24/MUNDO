"use strict";
// Recreates the 12-second waterfront demo using the same DSP that plays rooms.
// Usage: node examples/audio/render-demo.cjs path/to/demo.wav
const fs = require("node:fs");
const DSP = require("../../web/audio-dsp.js");
const Clips = require("../../web/audio-clips.js");

function chime() {
  const rate = 24000, duration = 2.2;
  const partials = [[624,.26,1.75],[1235,.12,2.7],[1746,.08,3.1],[2840,.045,5.4]];
  return Float32Array.from({length:rate*duration}, (_,i) => {
    const t = i/rate, envelope = Math.min(t/.006, 1, (duration-t)/.035);
    const sum = partials.reduce((sample,[hz,amplitude,decay]) =>
      sample + amplitude*Math.exp(-decay*t)*Math.sin(2*Math.PI*t*hz),0);
    return envelope*sum;
  });
}

async function render() {
  const hz = 48000, seconds = 12, frames = hz*seconds, block = 960;
  const clip = await Clips.prepare(Clips.encodeMono(chime()));
  const mixer = DSP.create(hz);
  mixer.setClip(clip.key, await Clips.verify(clip.key,clip.bytes,clip.digest));
  const source = (id,preset,position,radius,volume) => ({id,preset,position,radius,volume});
  const water = source("1","agua",[-2.2,1,-3],13,.65);
  const wind = source("2","brisa",[1,3,-2],24,.68);
  const motor = source("3","maquina",[-10,1,-6],13,.84);
  const bell = {...source("4",clip.key,[3.4,2,-3.6],18,.92),group:"efectos",loop:false};
  const scene = [water,wind,motor], left = new Float32Array(block), right = new Float32Array(block);
  const wav = Buffer.alloc(44 + 4*frames);
  wav.write("RIFF",0); wav.writeUInt32LE(wav.length-8,4); wav.write("WAVEfmt ",8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(2,22);
  wav.writeUInt32LE(hz,24); wav.writeUInt32LE(4*hz,28); wav.writeUInt16LE(4,32);
  wav.writeUInt16LE(16,34); wav.write("data",36); wav.writeUInt32LE(wav.length-44,40);
  for (let offset=0;offset<frames;offset+=block) {
    const t = offset/hz;
    // The listener approaches the water while a boat crosses its field of hearing.
    const listener = [1.1*Math.sin(t*.32),1.65,4.8-.55*t];
    motor.position = [-11+1.85*t,.85,-2.8-.5*Math.cos(t*.48)];
    if (offset===2*hz) scene.push(bell);
    mixer.setSources(scene);
    mixer.setListener(listener,.25*Math.sin(t*.55));
    if (offset===8*hz) mixer.trigger("4");
    mixer.render(left,right);
    for (let i=0;i<block;i++) {
      const time=(offset+i)/hz,fade=Math.max(0,Math.min(1,time/.4,(seconds-time)/1.05));
      const scale=32767*fade;
      wav.writeInt16LE(Math.round(left[i]*scale),44+4*(offset+i));
      wav.writeInt16LE(Math.round(right[i]*scale),46+4*(offset+i));
    }
  }
  return wav;
}
module.exports={chime,render};
if(require.main===module){
  const output=process.argv[2];
  if(!output)throw Error("Indica el archivo WAV de destino.");
  render().then(wav=>fs.writeFileSync(output,wav)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
