"""Exercise the Studio audio panel in desktop Chromium with a real local IndexedDB and Web Audio graph."""
import argparse
import io
import math
from pathlib import Path
import shutil
import struct
import tempfile
import wave

from playwright.sync_api import expect, sync_playwright


def tone(frequency):
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(24000)
        samples = [int(16384 * math.sin(i * 2 * math.pi * frequency / 24000)) for i in range(12000)]
        stream.writeframes(struct.pack("<" + "h" * len(samples), *samples))
    return output.getvalue()


def open_studio(context, url):
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda exception: errors.append(str(exception)))
    # Observe the actual PCM scheduled by the production Web Audio output.
    page.add_init_script("""(() => {
      const meter = globalThis.meter = {loud:0, closed:0};
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function(...args) {
        if (this.buffer?.getChannelData(0).some(x => Math.abs(x) > 1e-4)) ++meter.loud;
        return start.apply(this,args);
      };
      const close = AudioContext.prototype.close;
      AudioContext.prototype.close = function(...args) { ++meter.closed; return close.apply(this,args); };
    })()""")
    page.goto(url)
    page.locator("#new").click()
    page.locator("#audioPanel summary").click()
    return page, errors


def run(url, executable, temporary):
    with sync_playwright() as driver:
        browser = driver.chromium.launch(executable_path=executable, headless=True,
                                         args=["--mute-audio", "--disable-webgl"])
        context = browser.new_context(accept_downloads=True)
        page, errors = open_studio(context, url)
        page.locator("#audioWav").set_input_files(
            {"name":"privado-sin-usar.wav","mimeType":"audio/wav","buffer":tone(280)})
        expect(page.locator("#audioStatus")).to_contain_text("Sonido importado")
        unused = page.locator("#audioPreset").input_value()
        page.locator("#audioWav").set_input_files(
            {"name":"agua-exclusiva.wav","mimeType":"audio/wav","buffer":tone(441)})
        page.wait_for_function("last => /^s[0-9a-f]{16}$/.test(audioPreset.value) && audioPreset.value !== last", arg=unused)
        used = page.locator("#audioPreset").input_value()
        page.locator("#audioName").fill("Surtidor")
        page.locator("#audioSpatial").select_option("2d")
        page.locator("#audioCreate").click()
        expect(page.locator("#audioSource option:checked")).to_contain_text("Surtidor")
        page.locator("#audioSolo").click()
        page.wait_for_function("meter.loud > 0")
        page.locator("#audioStop").click()
        page.wait_for_function("meter.closed === 1")
        # Stop even when a user closes the panel during an asynchronous IndexedDB load.
        page.locator("#audioMix").click()
        page.locator("#audioPanel summary").click()
        page.wait_for_function("meter.closed === 2")
        page.locator("#audioPanel summary").click()
        page.locator("#audioMix").click()
        page.locator("#undo").click()
        page.wait_for_function("meter.closed === 3")
        expect(page.locator("#audioSource option")).to_have_count(1)
        page.locator("#redo").click()
        page.locator("#audioMix").click()
        page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        page.wait_for_function("meter.closed === 4")
        with page.expect_download() as info:
            page.locator("#audioExport").click()
        packed = temporary / info.value.suggested_filename
        info.value.save_as(packed)
        data = packed.read_bytes()
        assert data[:8] == b"MWAUDIO1"
        assert b"privado-sin-usar" not in data and b"agua-exclusiva" not in data
        page.locator("#publish").click()
        expect(page.locator("#releaseStatus")).to_contain_text("guardada")
        released = page.evaluate("""async () => {
          const release = (await MundoPublications.list())[0];
          const file = await MundoPublications.roomDownload(release);
          const raw = new Uint8Array(await file.blob.arrayBuffer());
          const info = await MundoRoomFile.verify(raw);
          const sources = MundoAudioScene.read(MundoWorld.decode(info.world));
          return {source:sources[0].preset,bytes:raw.length};
        }""")
        assert released["source"] == used and released["bytes"] < len(data)
        # A second, empty origin profile receives only the referenced sound.
        second = browser.new_context()
        reopened, other_errors = open_studio(second,url)
        reopened.locator("#inputFile").set_input_files(packed)
        expect(reopened.locator("#notice")).to_contain_text("abierta como borrador")
        reopened.locator("#audioSource").select_option(index=1)
        expect(reopened.locator("#audioPreset")).to_have_value(used)
        entries = reopened.evaluate("async () => (await MundoAudioLibrary.list()).map(x => x.key)")
        assert entries == [used] and unused not in entries
        reopened.locator("#audioMix").click()
        reopened.wait_for_function("meter.loud > 0")
        expect(reopened.locator("#audioStop")).to_be_enabled()
        assert not errors and not other_errors, (errors,other_errors)
        browser.close()


if __name__ == "__main__":
    arguments = argparse.ArgumentParser()
    arguments.add_argument("page", type=Path)
    arguments.add_argument("--chromium", default=shutil.which("chromium"))
    options = arguments.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        run(options.page.resolve().as_uri(), options.chromium, Path(tmp))
    print("Studio: catálogo, escucha Web Audio, cierre, deshacer, publicación y copia privada recuperada")
