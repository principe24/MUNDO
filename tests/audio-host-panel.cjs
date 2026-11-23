"use strict";
// Uses the actual authoring and administrative entry points. The game listener
// binds its usual loopback port; state, uploads and fixture files are temporary.
const test = require("node:test");
const assert = require("node:assert/strict");
const {spawn, execFile} = require("node:child_process");
const {promisify} = require("node:util");
const {once} = require("node:events");
const {createInterface} = require("node:readline");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {createHash, randomBytes} = require("node:crypto");
const {readRoomSource} = require("../server/room-source.cjs");

const root = path.resolve(__dirname, "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function panelURL(child) {
  const lines = createInterface({input:child.stdout});
  try {
    for await (const line of lines) {
      if (/^http:\/\/127\.0\.0\.1:[0-9]+\/#host=[a-f0-9]{64}$/.test(line)) return new URL(line);
    }
    throw Error("El panel terminó antes de abrir su dirección administrativa.");
  } finally { lines.close(); }
}

test("local host panel serves every Studio script and honors separate mesh consent for an authored WAV room",
  {timeout:30000}, async t => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "mundo-audio-panel-"));
    t.after(() => fs.rm(state, {recursive:true,force:true}));
    const file = path.join(state, "Taller.mroomaudio"), env = {...process.env, XDG_STATE_HOME:state};
    delete env.NODE_TEST_CONTEXT; // Start a standalone fixture runner inside the parent test.
    // Reuse the fixture exported by Studio's actual model import and audio controls.
    await promisify(execFile)(process.execPath, ["--test", "--test-name-pattern=consentimiento independiente", "tests/studio-audio.cjs"],
      {cwd:root,env:{...env,MUNDO_STUDIO_AUDIO_FIXTURE:file},timeout:10000});
    const bytes = await fs.readFile(file), source = readRoomSource(path.basename(file),bytes);
    assert.equal(source.audioClips.size,1); assert.equal(source.models.size,1);
    const [[audioKey,clip]] = source.audioClips, [[meshKey,mesh]] = source.models;

    const child = spawn(process.execPath, ["server/host-panel.cjs"], {cwd:root,env,stdio:["ignore","pipe","pipe"]});
    const exited = once(child,"exit");
    t.after(async () => {
      child.kill("SIGTERM");
      const killer=setTimeout(()=>child.kill("SIGKILL"),3000);
      try { await exited; } finally { clearTimeout(killer); }
    });
    const address = await panelURL(child), admin = address.origin;
    const secret = address.hash.slice(6);
    const headers = {origin:admin,"x-mundo-host":secret};
    const api = async (route,version,extra={},body) => {
      const response = await fetch(admin+"/api/"+route, {method:"POST",body,
        headers:{...headers,"x-mundo-version":String(version),...extra}});
      const result = await response.json();
      assert.equal(response.status,200,result.error || route);
      return result;
    };

    const studio = await fetch(admin+"/studio/Mundos.html");
    assert.equal(studio.status,200);
    const html = await studio.text();
    const paths = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
      .map(match => new URL(match[1],studio.url));
    assert.ok(paths.some(url=>url.pathname==="/studio/audio-panel.js"));
    assert.ok(paths.some(url=>url.pathname==="/web/audio-output.js"));
    assert.ok(paths.some(url=>url.pathname==="/studio/editor.js"));
    for (const url of paths) {
      assert.equal(url.origin,admin);
      const response = await fetch(url);
      assert.equal(response.status,200,url.pathname);
      assert.match(response.headers.get("content-type"),/^text\/javascript/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),
        await fs.readFile(path.join(root,url.pathname.slice(1))),url.pathname);
    }
    let status = await api("state",0);
    assert.equal(status.room,null);
    for(const authorized of [false,true]) {
      status = await api("prepare",status.version,
        {"x-mundo-file":"Taller.mroomaudio","content-type":"application/octet-stream"},bytes);
      assert.equal(status.preview.audioClipCount,1); assert.equal(status.preview.modelCount,1);
      status = await api("start",status.version,{"x-mundo-address":"127.0.0.1",
        ...(authorized?{"x-mundo-creator-models":"mesh-1"}:{})});
      assert.equal(status.shareModels,authorized);
      const invite = new URL((await api("seat/1/invite",status.version)).link);
      assert.equal(invite.origin,status.endpoint);
      const playerHeaders = {origin:invite.origin,"x-invite":invite.hash.slice(6),
        "x-seat":randomBytes(24).toString("hex"),"x-mundo-room-version":"3","content-type":"application/json"};
      const post = (endpoint,body) => fetch(invite.origin+"/room/"+endpoint,
        {method:"POST",headers:playerHeaders,body:JSON.stringify(body)});
      const join = await post("join",{});
      assert.equal(join.status,200);
      assert.equal(join.headers.get("x-mundo-audio-clips"),"wav-1");
      assert.equal(join.headers.get("x-mundo-creator-models"),authorized?"mesh-1":null);
      const {lease,revision} = await join.json();
      const audio = await post("audio",{lease,revision,key:audioKey});
      assert.equal(audio.status,200); assert.equal(audio.headers.get("x-mundo-audio-digest"),clip.digest);
      const waveform=Buffer.from(await audio.arrayBuffer());
      assert.equal(hash(waveform),clip.digest);assert.deepEqual(waveform,Buffer.from(clip.bytes));
      const model = await post("model",{lease,revision,key:meshKey});
      assert.equal(model.status,authorized?200:404);
      if(authorized) {
        assert.equal(model.headers.get("x-mundo-model-digest"),mesh.digest);
        const body=Buffer.from(await model.arrayBuffer());
        assert.equal(hash(body),mesh.digest);assert.deepEqual(body,Buffer.from(mesh.bytes));
      } else await model.arrayBuffer();
      const guestStudio = await fetch(invite.origin+"/studio/Mundos.html");
      assert.equal(guestStudio.status,404);await guestStudio.arrayBuffer();
      assert.equal((await post("leave",{})).status,200);
      status=await api("close",status.version);
      assert.equal(status.room,null);
    }
    t.diagnostic(paths.length+" scripts de Studio servidos por el panel local y dos políticas de malla comprobadas");
  });
