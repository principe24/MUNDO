"""Integration test with the production HTTP server, Chromium and Web Audio's analyser.

Run from the repository with Python Playwright, Chromium and Node installed:
    python tests/player-audio-browser.py
The endpoint is loopback only. Signal readings are digital, before physical speakers.
"""
from contextlib import contextmanager
from pathlib import Path
import shutil
import subprocess

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = """
const fs = require("node:fs");
const {roomFromSource, createHost, playerInvitation} = require("./server/room.cjs");
const {MundoWorld} = require("./server/room-runtime.cjs");
const {readRoomSource}=require("./server/room-source.cjs");
const RoomFile=require("./web/room-file.js");
const Scene = require("./web/audio-scene.js");
const Clips = require("./web/audio-clips.js");
(async () => {
  const world = MundoWorld.decode(fs.readFileSync("examples/Plaza_Brisa.mworld"));
  const clip = await Clips.prepare(Clips.encodeMono(Float32Array.from({length:24000}, (_,i) =>
    .35 * Math.sin(i * Math.PI * 2 * 260 / 24000))));
  Scene.add(world, {label:"Emisora de prueba", preset:clip.key, position:[0,0,0],
    spatial:"2d", radius:10, volume:1, group:"musica"});
  const worldBytes = MundoWorld.encode(world);
  const published = RoomFile.pack({title:"Emisora privada", revision:1, hash:await RoomFile.digest(worldBytes)},worldBytes);
  const sealed = await Clips.pack(published,[clip]);
  const room = await roomFromSource(readRoomSource("Emisora.mroomaudio",Buffer.from(sealed)));
  const host = createHost(room, {port:0});
  const origin = await host.start();
  console.log(playerInvitation(origin,room.seats[0].invite));
  process.on("SIGTERM", async () => {await host.close();process.exit(0);});
})().catch(error => {console.error(error);process.exit(1);});
"""
# Keep the original graph. A parallel analysis node observes the signal leaving its master gain.
PROBE = """
const BaseContext = window.AudioContext;
window.AudioContext = class extends BaseContext {
  createGain() {
    const gain = super.createGain();
    const analyser = this.createAnalyser();
    analyser.fftSize = 512;
    gain.connect(analyser);
    const values = new Float32Array(analyser.fftSize);
    window.mundoAudioProbe = {
      context: this,
      peak() { analyser.getFloatTimeDomainData(values); return Math.max(...values.map(Math.abs)); }
    };
    return gain;
  }
};
"""


@contextmanager
def hosted_room():
    with subprocess.Popen(["node", "-e", HOST], cwd=ROOT, stdout=subprocess.PIPE, text=True) as process:
        try:
            invitation = process.stdout.readline().strip()
            assert invitation.startswith("http://127.0.0.1:"), "El anfitrión local no inició la sala."
            yield invitation
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


def run(page, context, invitation):
    recorded, errors = [], []
    page.on("pageerror", lambda err: errors.append(str(err)))
    page.on("response", lambda res: recorded.append(res.status) if res.url.endswith("/room/audio") else None)
    page.add_init_script(PROBE)
    page.goto(invitation)
    expect(page.locator("#world")).to_have_text("Emisora privada · v1", timeout=15000)
    page.locator("#settings").click()
    page.locator("#audioEnable").click()
    expect(page.locator("#audioStatus")).to_have_text("Salida de audio activa.")
    page.wait_for_function("window.mundoAudioProbe?.peak() > 0.04")
    assert 200 in recorded, recorded
    page.locator("#audioMute").check()
    page.locator('#video [type=submit]').click()
    page.wait_for_function("window.mundoAudioProbe.peak() < 0.00001")
    page.locator("#settings").click()
    expect(page.locator("#audioMute")).to_be_checked()
    page.locator("#audioMute").uncheck()
    page.locator("#audioVolume").fill("45")
    page.locator('#video [type=submit]').click()
    page.wait_for_function("window.mundoAudioProbe.peak() > 0.04")
    context.set_offline(True)
    try:
        page.wait_for_function("window.mundoAudioProbe.peak() < 0.00001")
    finally:
        context.set_offline(False)
    page.wait_for_function("window.mundoAudioProbe.peak() > 0.04", timeout=20000)
    page.locator("#roomAction").click()
    expect(page.locator("#roomAction")).to_have_text("Volver a entrar")
    page.wait_for_function("window.mundoAudioProbe.context.state === 'closed'")
    assert not errors, errors


if __name__ == "__main__":
    with hosted_room() as invitation, sync_playwright() as tools:
        browser = tools.chromium.launch(executable_path=shutil.which("chromium"), headless=True,
                                      args=["--autoplay-policy=user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader"])
        try:
            context = browser.new_context()
            run(context.new_page(), context, invitation)
        finally:
            browser.close()
    print("Chromium: clip verificado, señal PCM, volumen, silencio, reconexión y salida de sala.")
