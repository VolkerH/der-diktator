# /// script
# requires-python = ">=3.12"
# dependencies = ["playwright>=1.58,<2"]
# ///
"""Accelerated synthetic full-duration capture through the actual Chromium AudioWorklet.

Requires Playwright and a Chromium executable. No microphone or speech model is used.
The benchmark accelerates only the source clock; worklet PCM conversion, message
acknowledgements, recorder retention and WAV creation use production implementations.
"""

# ruff: noqa: E501

import argparse
import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import override

STATIC = Path(__file__).resolve().parents[1] / "src/diktator/static"
BENCHMARK = """
import { RecorderProcessor } from "/assets/recorder-worklet.js";
class AcceleratedCapture extends RecorderProcessor {
  constructor(options) {
    super(options);
    this.input = new Float32Array(128);
    for (let i = 0; i < 128; i++) this.input[i] = Math.sin(i / 8) * .3;
  }
  process() {
    // Yield between bounded bursts so the real message port delivers acknowledgements.
    if (!this.active) return false;
    if (this.pending >= 8) return true;
    while (this.active && this.pending < 8) super.process([[this.input]]);
    return this.active;
  }
}
registerProcessor("accelerated-capture", AcceleratedCapture);
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/":
            content = b"<!doctype html><title>Synthetic capture resource measurement</title>"
        elif self.path == "/benchmark-worklet.js":
            content = BENCHMARK.encode()
        elif self.path.startswith("/assets/") and "/" not in self.path[8:]:
            content = (STATIC / self.path[8:]).read_bytes()
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header(
            "Content-Type", "text/javascript" if self.path.endswith(".js") else "text/html"
        )
        self.end_headers()
        self.wfile.write(content)

    @override
    def log_message(self, format: str, *args: object) -> None:
        pass


async def renderer_rss(browser_session) -> int:
    processes = await browser_session.send("SystemInfo.getProcessInfo")
    total = 0
    for process in processes["processInfo"]:
        if process["type"] != "renderer":
            continue
        try:
            status = (Path("/proc") / str(process["id"]) / "status").read_text()
        except FileNotFoundError:
            continue
        for line in status.splitlines():
            if line.startswith("VmRSS:"):
                total += int(line.split()[1]) * 1024
    return total


async def measure(chromium):
    from playwright.async_api import async_playwright  # ty: ignore[unresolved-import]

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(
                executable_path=chromium,
                args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
            )
            browser_session = await browser.new_browser_cdp_session()
            for rate in (16000, 48000):
                for duration in (1800, 3600):
                    page = await browser.new_page()
                    page.on("console", lambda message: print(message.text, flush=True))
                    page.on("pageerror", lambda error: print(f"Browser error: {error}", flush=True))
                    await page.goto(f"http://127.0.0.1:{server.server_port}/")
                    session = await page.context.new_cdp_session(page)
                    await session.send("HeapProfiler.collectGarbage")
                    baseline = await session.send("Runtime.getHeapUsage")
                    baseline_rss = await renderer_rss(browser_session)
                    peak_rss = baseline_rss
                    print(f"Starting {rate} Hz / {duration} s", flush=True)
                    await page.evaluate(
                        """async ({rate, duration}) => {
                      const { MicrophoneRecorder } = await import("/assets/recorder.js");
                      const RealContext = window.AudioContext;
                      const RealNode = window.AudioWorkletNode;
                      window.AudioContext = class extends RealContext {
                        constructor() { super({sampleRate: rate}); }
                      };
                      const sourceContext = new RealContext({sampleRate: rate});
                      const destination = sourceContext.createMediaStreamDestination();
                      const oscillator = sourceContext.createOscillator();
                      oscillator.connect(destination); oscillator.start();
                      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {value: async () => destination.stream});
                      window.AudioWorkletNode = class extends RealNode {
                        constructor(context, _name, options) { super(context, "accelerated-capture", options); }
                      };
                      const recorder = new MicrophoneRecorder();
                      const started = performance.now();
                      recorder.onAutomaticStop = async (reason) => {
                        const retainedBytes = recorder.chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
                        const blob = await recorder.stop();
                        const header = new DataView(await blob.slice(0, 44).arrayBuffer());
                        window.result = {rate, duration, reason, samples: recorder.sampleCount, retainedBytes, wavBytes: blob.size,
                          wavDataBytes: header.getUint32(40, true), seconds: (performance.now() - started) / 1000, releasedChunks: recorder.chunks.length};
                        window.retainedResult = blob;
                        await sourceContext.close();
                      };
                      const originalAddModule = AudioWorklet.prototype.addModule;
                      AudioWorklet.prototype.addModule = async function(url) {
                        await originalAddModule.call(this, url);
                        await originalAddModule.call(this, "/benchmark-worklet.js");
                      };
                      console.log("before start");
                      await recorder.start(null, {intervalSeconds: duration, hardLimitSeconds: 3600});
                      console.log("started", recorder.context.state);
                      window.debugRecorder = recorder;
                    }""",
                        {"rate": rate, "duration": duration},
                    )
                    peak = dict(baseline)
                    deadline = time.monotonic() + 240
                    while not await page.evaluate("Boolean(window.result)"):
                        if time.monotonic() > deadline:
                            raise TimeoutError("Synthetic capture did not complete")
                        peak_rss = max(peak_rss, await renderer_rss(browser_session))
                        usage = await session.send("Runtime.getHeapUsage")
                        for key, value in usage.items():
                            peak[key] = max(peak.get(key, 0), value)
                        await asyncio.sleep(0.1)
                    result = await page.evaluate("window.result")
                    for key, value in (await session.send("Runtime.getHeapUsage")).items():
                        peak[key] = max(peak.get(key, 0), value)
                    assert result["reason"] == "deadline", result
                    assert result["samples"] == duration * 16000, result
                    assert result["wavBytes"] == duration * 32000 + 44, result
                    assert result["releasedChunks"] == 0, result
                    peak_rss = max(peak_rss, await renderer_rss(browser_session))
                    result.update(
                        baseline=baseline,
                        peak=peak,
                        baseline_renderer_rss_bytes=baseline_rss,
                        peak_renderer_rss_bytes=peak_rss,
                    )
                    results.append(result)
                    print(json.dumps(result), flush=True)
                    await page.close()
            browser_version = browser.version
            await browser.close()
    finally:
        server.shutdown()
    return {
        "method": "Accelerated synthetic source in real AudioWorklet; no real microphone/model/mobile acceptance",
        "browser": browser_version,
        "measurement": "CDP JS heap/backing storage and sampled renderer VmRSS; native Blob allocations included in RSS, no exact total-process peak claim",
        "results": results,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chromium", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(asyncio.run(measure(args.chromium)), indent=2) + "\n")
