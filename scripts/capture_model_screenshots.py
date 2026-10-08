# /// script
# requires-python = ">=3.12"
# dependencies = ["playwright>=1.58,<2", "pydantic>=2.13.4,<2.14"]
# ///
"""Capture the real model UI with demo API responses and embed it in the README.

Run `uv run scripts/capture_model_screenshots.py --install-browser` once, then
`uv run scripts/capture_model_screenshots.py`. No running server, model weights,
microphone permission, or personal chats are used.
"""

import argparse
import asyncio
import mimetypes
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "src" / "diktator" / "static"
sys.path.insert(0, str(ROOT / "src"))

from diktator.models import CATALOG, ModelsStatus, ModelStatus  # noqa: E402


def embed_screenshots() -> None:
    """Only insert links after all screenshots were captured successfully."""
    readme = ROOT / "README.md"
    text = readme.read_text()
    captions = {
        "model-picker": "Choose a model by its language, recording mode, and download-size pills.",
        "model-download": "The download status reports the current model file.",
        "model-delete": "Confirm model deletion while keeping chats and recordings.",
        "model-ready": "The sidebar shows Whisper ready, with its languages and recording mode.",
    }
    for name, caption in captions.items():
        start = f"<!-- screenshot:{name}:start -->"
        end = f"<!-- screenshot:{name}:end -->"
        width = 300 if name == "model-ready" else 520
        block = (
            f'{start}\n\n<img src="docs/screenshot-{name}.png" '
            f'alt="{caption}" width="{width}" />\n\n'
            f"_{caption} Screenshot of the app with demonstration state._\n\n{end}"
        )
        text, count = re.subn(re.escape(start) + r".*?" + re.escape(end), block, text, flags=re.S)
        if count != 1:
            raise ValueError(f"Expected one screenshot marker for {name} in README.md")
    readme.write_text(text)


async def capture() -> None:
    # Optional documentation dependency, supplied by this script's uv metadata.
    from playwright.async_api import async_playwright, expect  # ty: ignore[unresolved-import]

    models = [
        ModelStatus(
            **info.model_dump(),
            installed=info.id == "phonon-2",
            state="ready" if info.id == "phonon-2" else "missing",
        )
        for info in CATALOG
    ]
    status = ModelsStatus(active="phonon-2", busy=False, models=models)
    whisper = next(model for model in models if model.id == "whisper-large-v3-turbo")
    errors: list[str] = []
    deletions: list[str] = []

    async def serve(route) -> None:
        path = route.request.url.removeprefix("http://diktator.test").split("?")[0]
        if path == "/":
            await route.fulfill(path=STATIC / "index.html", content_type="text/html")
        elif path.startswith("/assets/"):
            file = STATIC / Path(path).name
            media = mimetypes.guess_type(file)[0] or "application/octet-stream"
            await route.fulfill(path=file, content_type=media)
        elif path == "/api/models":
            await route.fulfill(json=status.model_dump())
        elif path == "/api/chats":
            await route.fulfill(json=[])
        elif path == "/api/models/whisper-large-v3-turbo/download":
            whisper.state = "downloading"
            whisper.message = "Downloading Whisper large-v3-turbo (file 1 of 5)…"
            await route.fulfill(status=202, json=status.model_dump())
        elif path == "/api/models/whisper-large-v3-turbo/activate":
            models[0].state = "installed"
            whisper.state = "ready"
            status.active = whisper.id
            await route.fulfill(status=202, json=status.model_dump())
        elif path == "/api/models/whisper-large-v3-turbo/delete":
            deletions.append(whisper.id)
            whisper.installed = False
            whisper.state = "missing"
            status.active = None
            await route.fulfill(status=202, json=status.model_dump())
        else:
            errors.append(f"Unexpected request: {path}")
            await route.fulfill(status=404, json={"detail": "Not found"})

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        try:
            page = await browser.new_page(
                viewport={"width": 1280, "height": 900}, device_scale_factor=2
            )
            page.on("pageerror", lambda error: errors.append(str(error)))
            await page.route("**/*", serve)
            await page.goto("http://diktator.test/")
            await page.locator("#splash").wait_for(state="hidden")
            await page.locator("#model-settings-open").click()
            await page.locator('input[value="whisper-large-v3-turbo"]').check()
            dialog = page.locator("#model-settings")
            await expect(page.locator(".model-option")).to_have_count(3)
            download = page.locator('.model-download[data-model="whisper-large-v3-turbo"]')
            await expect(download).to_have_text("Download")
            await dialog.screenshot(path=ROOT / "docs" / "screenshot-model-picker.png")

            await download.click()
            await expect(page.locator("#model-help")).to_contain_text("file 1 of 5")
            await expect(download).to_be_disabled()
            await dialog.screenshot(path=ROOT / "docs" / "screenshot-model-download.png")

            whisper.installed = True
            whisper.state = "installed"
            whisper.message = ""
            await expect(page.locator("#model-action")).to_have_text("Use model")
            await page.locator("#model-action").click()
            await expect(page.locator("#engine-status")).to_have_text("Ready")
            await page.locator("#model-settings-close").click()
            await page.locator("#model-settings-open").screenshot(
                path=ROOT / "docs" / "screenshot-model-ready.png"
            )
            await page.locator("#model-settings-open").click()
            await expect(download).to_have_text("Delete download")
            await download.click()
            confirmation = page.locator("#model-delete-dialog")
            await expect(confirmation).to_be_visible()
            await expect(page.locator("#model-delete-cancel")).to_be_focused()
            await confirmation.screenshot(path=ROOT / "docs" / "screenshot-model-delete.png")
            await page.locator("#model-delete-cancel").click()
            await expect(confirmation).not_to_be_visible()
            await expect(download).to_be_focused()
            assert deletions == []
            await download.click()
            await page.keyboard.press("Escape")
            await expect(confirmation).not_to_be_visible()
            assert deletions == []
            await download.click()
            await page.locator("#model-delete-confirm").click()
            await expect(download).to_have_text("Download")
            assert deletions == [whisper.id]
            await expect(page.locator("#record")).to_be_disabled()

            # Check modal scrolling and confirmation on a narrow phone viewport.
            await page.set_viewport_size({"width": 390, "height": 844})
            await page.locator('.model-download[data-model="phonon-2"]').click()
            await expect(confirmation).to_be_visible()
            assert await confirmation.evaluate("e => e.scrollWidth <= e.clientWidth")
            await page.locator("#model-delete-cancel").click()
            assert await dialog.evaluate("e => e.scrollWidth <= e.clientWidth")
            await expect(download).to_be_visible()
            if errors:
                raise RuntimeError("; ".join(errors))
        finally:
            await browser.close()
    embed_screenshots()
    print("Saved four screenshots in docs/ and embedded them in README.md.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-browser", action="store_true")
    args = parser.parse_args()
    if args.install_browser:
        subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=True)
    else:
        asyncio.run(capture())


if __name__ == "__main__":
    main()
