// Benchmarks OCR engine and model combinations in headless Chromium.
//
//   node scripts/bench-ocr.mjs [--runs 3] [--threads 4] [--only name,name]
//
// It starts the Vite dev server, screenshots the performance fixture pages,
// runs each configuration from CONFIGS on them, and prints timings next to
// line recall and character error rate against the fixture's visible text.
// Candidate models that are not part of the app live in fixtures/bench-models/.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 5190;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const RUNS = Number(option("runs", 3));
const THREADS = Number(option("threads", 4));
const ONLY = option("only", "").split(",").filter(Boolean);
const REC_BATCH = Number(option("rec-batch", 0));
const REC_MAX_WIDTH = Number(option("rec-max-width", 0));
const OUT = option("out", "/tmp/claude-0/-home-user-traductorg/dd22e419-3aa1-5b2f-ba11-676deccccae8/scratchpad/bench");

// The app's own models come from public/ocr-assets. Alternatives are read
// from fixtures/bench-models (ignored by git); download them from the RapidOCR
// release on modelscope, for example
//   https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx
const APP = {
  det: "/ocr-assets/ppocrv6-det-tiny.onnx",
  rec: "/ocr-assets/ppocrv6-rec-tiny.onnx",
  dict: "/ocr-assets/ppocrv6-tiny-dict.txt",
};
const CANDIDATE = {
  v6DetSmall: "/fixtures/bench-models/v6_det_small.onnx",
  v6RecSmall: "/fixtures/bench-models/v6_rec_small.onnx",
  v6Dict: "/fixtures/bench-models/v6_dict.txt",
};
const V6_DETECTION = { thresh: 0.2, boxThresh: 0.4, unclipRatio: 1.4 };

const CONFIGS = [
  { name: "app-native", engine: "native", det: APP.det, rec: APP.rec, dict: APP.dict, detection: V6_DETECTION },
  { name: "app-esearch", engine: "esearch", det: APP.det, rec: APP.rec, dict: APP.dict },
  { name: "v6small-det-tiny-rec", engine: "native", det: CANDIDATE.v6DetSmall, rec: APP.rec, dict: APP.dict, detection: V6_DETECTION },
  { name: "v6small-native", engine: "native", det: CANDIDATE.v6DetSmall, rec: CANDIDATE.v6RecSmall, dict: CANDIDATE.v6Dict, detection: V6_DETECTION },
];

const SCENES = [
  { name: "static", mode: "static", scrollY: 0 },
  { name: "dense", mode: "dense", scrollY: 120 },
  { name: "scroll", mode: "scroll", scrollY: 300 },
];

// The app feeds the detector about 1.65 megapixels of a 16:9 capture.
const OCR_WIDTH = 1712;
const OCR_HEIGHT = 963;

function waitForServer(url, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolve();
      } catch {}
      if (Date.now() - started > timeoutMs) return reject(new Error("Dev server did not start"));
      setTimeout(probe, 250);
    };
    probe();
  });
}

function normalize(text) {
  return String(text).normalize("NFC").replace(/\s+/g, " ").trim();
}

function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = new Uint32Array(cols);
  let current = new Uint32Array(cols);
  for (let j = 0; j < cols; j++) previous[j] = j;
  for (let i = 1; i < rows; i++) {
    current[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[cols - 1];
}

// Each expected line is matched to the recognized text that explains it best:
// a single line, or a concatenation of consecutive recognized lines.
function score(expectedLines, recognizedTexts) {
  const candidates = new Set(recognizedTexts.map(normalize).filter(Boolean));
  const joined = normalize(recognizedTexts.join(" "));
  let characters = 0;
  let errors = 0;
  let found = 0;
  for (const raw of expectedLines) {
    const expected = normalize(raw);
    if (!expected) continue;
    let best = expected.length;
    for (const candidate of candidates) {
      best = Math.min(best, levenshtein(expected, candidate));
      if (!best) break;
    }
    if (best && joined.includes(expected)) best = 0;
    characters += expected.length;
    errors += best;
    if (best / expected.length <= 0.15) found++;
  }
  return {
    lines: expectedLines.length,
    found,
    cer: characters ? errors / characters : 0,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const server = spawn(
  process.execPath,
  [join(ROOT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], detached: true },
);
try {
  await waitForServer(`${ORIGIN}/fixtures/bench.html`);
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });

  const scenes = [];
  const fixture = await context.newPage();
  await fixture.goto(`${ORIGIN}/fixtures/performance.html`);
  for (const scene of SCENES) {
    await fixture.click(`button[data-mode="${scene.mode}"]`);
    await fixture.evaluate((y) => window.scrollTo(0, y), scene.scrollY);
    await fixture.waitForTimeout(400);
    const png = await fixture.screenshot({ type: "png" });
    await writeFile(`${OUT}/${scene.name}.png`, png);
    const expected = await fixture.evaluate(() => {
      const lines = [];
      for (const element of document.querySelectorAll("section.active h1, section.active h2, section.active p, section.active .card")) {
        if (element.children.length && element.tagName === "DIV") continue;
        const rect = element.getBoundingClientRect();
        if (rect.bottom < 60 || rect.top > window.innerHeight) continue;
        lines.push(element.innerText);
      }
      return lines;
    });
    scenes.push({ ...scene, base64: png.toString("base64"), expected });
  }
  await fixture.close();

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") console.error("[page]", message.text());
  });
  await page.goto(`${ORIGIN}/fixtures/bench.html`);
  const report = [];
  for (const config of CONFIGS) {
    if (ONLY.length && !ONLY.includes(config.name)) continue;
    const loadStart = Date.now();
    const recognition = { ...(config.recognition || {}) };
    if (REC_BATCH) recognition.batchSize = REC_BATCH;
    if (REC_MAX_WIDTH) recognition.maxWidth = REC_MAX_WIDTH;
    try {
      await page.evaluate((options) => window.bench.init(options), { ...config, recognition, threads: THREADS });
    } catch (error) {
      console.error(`${config.name}: init failed: ${error.message}`);
      continue;
    }
    const loadMs = Date.now() - loadStart;
    for (const scene of scenes) {
      const timings = [];
      let last = null;
      for (let run = 0; run < RUNS + 1; run++) {
        last = await page.evaluate(
          async ({ base64, width, height }) => {
            const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            const blob = new Blob([bytes], { type: "image/png" });
            const bitmap = await createImageBitmap(blob, {
              resizeWidth: width,
              resizeHeight: height,
              resizeQuality: "high",
            });
            const canvas = new OffscreenCanvas(width, height);
            canvas.getContext("2d").drawImage(bitmap, 0, 0);
            bitmap.close();
            return window.bench.run(canvas.transferToImageBitmap());
          },
          { base64: scene.base64, width: OCR_WIDTH, height: OCR_HEIGHT },
        );
        if (run > 0) timings.push(last.timings);
      }
      const quality = score(scene.expected, [...last.lines.map((line) => line.text), ...last.paragraphs]);
      const row = {
        config: config.name,
        scene: scene.name,
        loadMs,
        det: Math.round(median(timings.map((t) => t.det))),
        rec: Math.round(median(timings.map((t) => t.rec))),
        total: Math.round(median(timings.map((t) => t.total))),
        boxes: last.detected,
        ...quality,
      };
      report.push(row);
      console.log(
        `${row.config.padEnd(24)} ${row.scene.padEnd(7)} load ${String(row.loadMs).padStart(5)}  det ${String(row.det).padStart(5)}  rec ${String(row.rec).padStart(5)}  total ${String(row.total).padStart(5)}  boxes ${String(row.boxes).padStart(3)}  lines ${row.found}/${row.lines}  cer ${row.cer.toFixed(3)}`,
      );
      await writeFile(
        `${OUT}/${config.name}-${scene.name}.json`,
        JSON.stringify({ expected: scene.expected, ...last }, null, 2),
      );
    }
  }
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
}
