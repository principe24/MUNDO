"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const Clips = require("../web/audio-clips.js");

function chunk(kind, payload) {
  const bytes = Buffer.alloc(8 + payload.length + payload.length % 2);
  bytes.write(kind,0); bytes.writeUInt32LE(payload.length,4); payload.copy(bytes,8);
  return bytes;
}

function riff(parts) {
  const size = parts.reduce((sum,p) => sum+p.length, 4);
  const header = Buffer.alloc(12);
  header.write("RIFF"); header.writeUInt32LE(size,4); header.write("WAVE",8);
  return Buffer.concat([header,...parts]);
}

function wav({format=1,bits=16,channels=1,hz=24000,values=[0],metadata=false,extended=false}) {
  const fmt = Buffer.alloc(extended ? 18 : 16);
  fmt.writeUInt16LE(format); fmt.writeUInt16LE(channels,2);
  fmt.writeUInt32LE(hz,4); fmt.writeUInt32LE(hz*channels*bits/8,8);
  fmt.writeUInt16LE(channels*bits/8,12); fmt.writeUInt16LE(bits,14);
  const data = Buffer.alloc(bits/8*values.length);
  values.forEach((value,i) => {
    const at = i*bits/8;
    if (format === 3) data.writeFloatLE(value,at);
    else if (bits === 8) data.writeUInt8(value,at);
    else data.writeIntLE(value,at,bits/8);
  });
  const parts = [chunk("fmt ",fmt)];
  if (metadata) parts.push(chunk("JUNK",Buffer.from("nombre original")));
  parts.push(chunk("data",data));
  return riff(parts);
}

test("PCM de 8/16/24/32 bits conserva signo, orden y valores fronterizos", () => {
  for (const bits of [8,16,24,32]) {
    const half = 2**(bits-1);
    const signed = [-half,-half/2,-1,0,1,half/2,half-1];
    const values = signed.map(n => bits === 8 ? n+128 : n);
    const sample = Clips.decode(wav({bits,values,metadata:true,extended:true}));
    assert.equal(sample.sampleRate,24000);
    assert.deepEqual(sample.samples,Float32Array.from(signed,n => n/half));
  }
});

test("float estéreo se promedia por cuadro y rechaza NaN o infinito", async () => {
  const bytes = wav({format:3,bits:32,channels:2,values:[.5,-.5,.875,.125,-1.2,-.5]});
  assert.deepEqual(Clips.decode(bytes).samples, Float32Array.of(0,.5,-.75));
  const result = await Clips.prepare(bytes), decoded = await Clips.verify(result.key,result.bytes,result.digest);
  assert.deepEqual(decoded.samples, Float32Array.of(0,.5,-.75));
  for (const value of [NaN,Infinity,-Infinity])
    assert.throws(() => Clips.decode(wav({format:3,bits:32,values:[value]})));
  for (const value of [NaN,Infinity,-Infinity]) assert.throws(() => Clips.encodeMono([value]));
});

test("el audio netamente antisimétrico se cancela al convertirlo a mono", async () => {
  const frames = Array.from({length:8000},(_,i) => Math.round(12000*Math.sin(2*Math.PI*377*i/8000)));
  const values = frames.flatMap(v => [v,-v]);
  const {bytes} = await Clips.prepare(wav({channels:2,hz:8000,values}));
  assert.equal(Clips.decode(bytes).samples.length,24000);
  assert.ok(Clips.decode(bytes).samples.every(v => v === 0));
});

test("la conversión de tasa conserva el tiempo, el nivel de continua y la frecuencia audible", async () => {
  for (const hz of [8000,11025,22050,44100,48000,96000]) {
    const n = Math.round(hz*.113), values = Array(n).fill(4096);
    const a = await Clips.prepare(wav({hz,values}));
    const sample = Clips.decode(a.bytes);
    assert.equal(sample.sampleRate,24000);
    assert.equal(sample.samples.length,Math.round(n*24000/hz));
    assert.ok(sample.samples.every(x => x === .125));
  }
  const tone = async frequency => {
    const values = Array.from({length:4800},(_,i) => Math.round(16000*Math.sin(2*Math.PI*frequency*i/48000)));
    const {bytes} = await Clips.prepare(wav({hz:48000,values}));
    return Clips.decode(bytes).samples.slice(48,-48);
  };
  const rms = a => Math.sqrt(a.reduce((sum,n) => sum+n*n,0)/a.length);
  const outside = await tone(18000), inside = await tone(2000);
  assert.ok(rms(inside) > .34);
  assert.ok(rms(outside) < .002,"el filtro debe atenuar un tono sobre el Nyquist de la salida");
});

test("las publicaciones solo conservan las muestras canónicas y una huella independiente", async () => {
  const input = wav({values:[-32768,-16384,0,16384,32767],metadata:true,extended:true});
  assert.throws(() => Clips.canonical(input));
  const {key,digest,bytes} = await Clips.prepare(input);
  assert.equal(bytes.length,54);
  assert.equal(Buffer.from(bytes).includes(Buffer.from("nombre original")),false);
  assert.equal(createHash("sha256").update(bytes).digest("hex"),digest);
  assert.equal(key,"s"+digest.slice(0,16));
  assert.deepEqual(await Clips.prepare(bytes),{key,digest,bytes});
  await assert.rejects(Clips.verify(key,bytes,"0".repeat(64)));
  await assert.rejects(Clips.verify("s0000000000000000",bytes));
  assert.deepEqual(Clips.canonical(bytes),bytes);
});

test("se descartan cabeceras, formatos e índices de datos corruptos y límites sobrepasados", async () => {
  const original = wav({values:[1,2,3]});
  const changed = modify => {const b=Buffer.from(original); modify(b);return b;};
  const fmt = original.subarray(12,36), data = original.subarray(36);
  for (const bytes of [new Uint8Array(),original.subarray(0,43),changed(b=>b.write("RF64")),
    changed(b=>b.write("RIFF",8)),changed(b=>b.writeUInt32LE(1,4)),changed(b=>b.writeUInt32LE(0xffffffff,40)),
    changed(b=>b.writeUInt16LE(0xfffe,20)),changed(b=>b.writeUInt16LE(6,22)),
    changed(b=>b.writeUInt32LE(7999,24)),changed(b=>b.writeUInt32LE(96001,24)),
    changed(b=>b.writeUInt32LE(12345,28)),changed(b=>b.writeUInt16LE(3,32)),
    changed(b=>b.writeUInt16LE(20,34)),riff([fmt,fmt,data]),riff([fmt,data,data]),riff([fmt]),
    riff([fmt,chunk("data",Buffer.alloc(0))]),riff([fmt,chunk("data",Buffer.alloc(3))]),
    riff([fmt,data,Buffer.from([1])])]) assert.throws(() => Clips.decode(bytes));
  const edge = wav({hz:8000,bits:8,values:Array(8000*16).fill(128)});
  assert.equal(Clips.decode(edge).samples.length,8000*16);
  await assert.rejects(Clips.prepare(wav({hz:8000,bits:8,values:Array(8000*16+1).fill(128)})));
  assert.throws(() => Clips.encodeMono(new Float32Array(16*24000+1)));
  assert.throws(() => Clips.decode(new Uint8Array(16*1024*1024+1)));
});

test("el banco exige correspondencia completa de fuentes, claves, longitudes y huellas", async () => {
  const a = await Clips.prepare(Clips.encodeMono([.25,.1]));
  const b = await Clips.prepare(Clips.encodeMono([-.75]));
  const room = new Uint8Array(64);
  const file = await Clips.pack(room,[b,a]);
  assert.deepEqual(file,await Clips.pack(room,[a,b]));
  const {items} = Clips.unpack(file);
  Clips.match([{preset:a.key},{preset:"agua"},{preset:b.key},{preset:a.key}],items);
  assert.throws(() => Clips.match([{preset:a.key},{preset:b.key}],[a,a]));
  assert.throws(() => Clips.match([{preset:a.key}],items));
  assert.throws(() => Clips.match([{preset:a.key},{preset:b.key}],[a]));
  assert.throws(() => Clips.unpack(file.subarray(0,-1)));
  assert.throws(() => Clips.unpack(Buffer.concat([file,Buffer.alloc(1)])));
  for (const mem of [0,8,12,16+room.length+32]) {
    const edited = Buffer.from(file);
    edited.writeUInt32LE(0xffffffff,mem);
    assert.throws(() => Clips.unpack(edited));
  }
  await assert.rejects(Clips.pack(room,[a,a]));
  await assert.rejects(Clips.pack(room,Array(17).fill(a)));
  await assert.rejects(Clips.pack(room,[{...a,key:b.key}]));
  const large = {...a,bytes:new Uint8Array(Clips.maxClipBytes)};
  await assert.rejects(Clips.pack(room,Array(12).fill(large)));
  const damaged = file.slice();
  damaged[damaged.length-1] ^= 1;
  const last = Clips.unpack(damaged).items.at(-1);
  await assert.rejects(Clips.verify(last.key,last.bytes,last.digest));
});

test("el códec publica y reproduce los mismos bytes que verificó antes de ceder la ejecución", async () => {
  const a = await Clips.prepare(Clips.encodeMono([.25,.5]));
  const b = await Clips.prepare(Clips.encodeMono([-.25,-.5]));
  // A Buffer slice is itself a writable view; use one as input for both APIs.
  const input = Buffer.from(a.bytes);
  const verifying = Clips.verify(a.key,input,a.digest);
  input.fill(0,44);
  assert.deepEqual((await verifying).samples, Float32Array.of(.25,.5));
  const first = {...a,bytes:Buffer.from(a.bytes)},second = {...b,bytes:Buffer.from(b.bytes)};
  const packing = Clips.pack(new Uint8Array(60),[first,second]);
  first.bytes.fill(0,44); second.bytes.fill(0,44); first.digest="";
  const bank = Clips.unpack(await packing);
  for (const item of bank.items) {
    const original = item.key === a.key ? a : b;
    assert.deepEqual(Uint8Array.from(item.bytes),original.bytes);
    await Clips.verify(item.key,item.bytes,item.digest);
  }
});
