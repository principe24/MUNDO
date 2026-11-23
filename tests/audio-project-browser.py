"""Open a two-world audio project in real Chromium, restore its sounds, and host the guest projection."""
import argparse
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory

from playwright.sync_api import expect, sync_playwright


def run(page_path, project_path, destination, chromium):
    with sync_playwright() as driver:
        browser = driver.chromium.launch(executable_path=chromium, args=["--mute-audio", "--disable-webgl"])
        ctx = browser.new_context(accept_downloads=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(page_path.resolve().as_uri())
        page.locator("#projectFile").set_input_files(project_path.resolve())
        expect(page.locator("#projectName")).to_have_value("Patios del carillón")
        expect(page.locator("#projectWorlds option")).to_have_count(2)
        assert len(page.evaluate("MundoAudioLibrary.list()")) == 2
        with page.expect_download() as saved:
            page.locator("#projectSaveAudio").click()
        saved.value.save_as(destination / "export.mprojectaudio")
        assert (destination / "export.mprojectaudio").read_bytes() == project_path.read_bytes()
        page.locator("#projectPlay").click()
        expect(page.locator("#projectStatus")).to_contain_text("Autoriza")
        page.locator("#projectPlayAudio").check()
        with page.expect_download() as prepared:
            page.locator("#projectPlay").click()
        prepared.value.save_as(destination / "preparado.mprojectaudio")
        assert (destination / "preparado.mprojectaudio").read_bytes() == project_path.read_bytes()

        clean = browser.new_context()
        other = clean.new_page()
        other.goto(page_path.resolve().as_uri())
        damaged = bytearray(project_path.read_bytes())
        damaged[-1] ^= 1
        other.locator("#projectFile").set_input_files(
            {"name":"incompleto.mprojectaudio","mimeType":"application/octet-stream","buffer":bytes(damaged)})
        expect(other.locator("#projectStatus")).to_contain_text("huella")
        assert other.evaluate("MundoAudioLibrary.list()") == []
        expect(other.locator("#projectWorlds option")).to_have_count(0)
        assert not errors, errors
        browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("page", type=Path)
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parents[1] / "examples/audio/Patios_del_carillon.mprojectaudio")
    parser.add_argument("--chromium", default=shutil.which("chromium"))
    args = parser.parse_args()
    with TemporaryDirectory() as tmp:
        run(args.page, args.project, Path(tmp), args.chromium)
    print("Chromium e IndexedDB: importación atómica, dos mapas, privacidad y exportación idéntica.")
