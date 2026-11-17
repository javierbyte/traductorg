// Benchmarks the app's real OCR worker on an article page in Chrome.
//
//   node scripts/bench-pipeline.mjs [--runs 3] [--out dir] [--only 1x|2x] [--noise 2] [--timings]
//
// It screenshots fixtures/article.html at several scroll positions and pixel
// densities, sends each frame through ocr-worker.js the way the app does, and
// compares the paragraphs that would be translated with the page's own text
// blocks. It reports, per density:
//   exact     blocks read as exactly one item with exactly the page's text
//   split     blocks that came back as several items
//   missed    blocks with no item
//   cer       character error rate over all blocks
//   cold      first pass on a fresh worker
//   repeat    the same frame again (nothing changed)
//   scroll    passes after scrolling by part of a screen
// --noise adds random error to every pixel, as real screen capture does, to
// check that lines are still recognized only once. --timings prints each
// pass's stages.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 5191;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const RUNS = Number(option("runs", 3));
const ONLY = option("only", "");
const OUT = option("out", join(tmpdir(), "traductorg-bench"));
const NOISE = Number(option("noise", 0));
const TIMINGS = args.includes("--timings");

const VIEWPORT = { width: 1440, height: 900 };
const DENSITIES = [
  { name: "1x", deviceScaleFactor: 1 },
  { name: "2x", deviceScaleFactor: 2 },
];
// Odd distances, like real scrolling: boxes land on new subpixel positions.
const SCROLL_POSITIONS = [0, 137, 411, 780, 1203, 1650];
// The worker ignores this much of each edge of the shared window.
const EDGE = { side: 16, vertical: 64 };

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

// List markers are drawn by the browser and are not part of the block's text.
function withoutMarker(text) {
  return text.replace(/^(?:\d+[.)]|[•·◦▪■*–-])\s*/u, "");
}

function levenshtein(a, b) {
  const cols = b.length + 1;
  let previous = new Uint32Array(cols);
  let current = new Uint32Array(cols);
  for (let j = 0; j < cols; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[cols - 1];
}

function itemRect(item, density) {
  const xs = item.box.map((point) => point[0] / density);
  const ys = item.box.map((point) => point[1] / density);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

function scoreFrame(blocks, items, density) {
  const owned = blocks.map(() => []);
  const strays = [];
  for (const item of items) {
    const rect = itemRect(item, density);
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const index = blocks.findIndex(
      (block) =>
        cx >= block.left - 4 && cx <= block.right + 4 && cy >= block.top - 4 && cy <= block.bottom + 4,
    );
    if (index === -1) strays.push(item.text);
    else owned[index].push({ ...item, rect });
  }

  const summary = { blocks: blocks.length, exact: 0, split: 0, missed: 0, characters: 0, errors: 0 };
  const failures = [];
  blocks.forEach((block, index) => {
    const expected = normalize(block.text);
    const parts = owned[index].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const got = normalize(parts.map((part) => part.text).join(" "));
    const distance = Math.min(levenshtein(expected, got), levenshtein(expected, withoutMarker(got)));
    summary.characters += expected.length;
    summary.errors += Math.min(distance, expected.length);
    if (!parts.length) summary.missed++;
    else if (parts.length > 1) summary.split++;
    if (parts.length === 1 && distance === 0) summary.exact++;
    else failures.push({ expected, got: parts.map((part) => part.text) });
  });
  return { summary, failures, strays };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

const server = spawn(
  process.execPath,
  [join(ROOT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], detached: true },
);
try {
  await waitForServer(`${ORIGIN}/fixtures/pipeline-bench.html`);
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );

  const report = [];
  for (const density of DENSITIES) {
    if (ONLY && ONLY !== density.name) continue;
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: density.deviceScaleFactor,
    });
    const fixture = await context.newPage();
    await fixture.goto(`${ORIGIN}/fixtures/article.html`);
    await fixture.evaluate(() => document.fonts.ready);
    const frames = [];
    for (const scrollY of SCROLL_POSITIONS) {
      await fixture.evaluate((y) => window.scrollTo(0, y), scrollY);
      await fixture.waitForTimeout(150);
      const png = await fixture.screenshot({ type: "png" });
      await writeFile(join(OUT, `article-${density.name}-${scrollY}.png`), png);
      const blocks = await fixture.evaluate((edge) => {
        const blocks = [];
        for (const element of document.querySelectorAll("[data-block]")) {
          const rect = element.getBoundingClientRect();
          if (
            rect.top < edge.vertical ||
            rect.bottom > window.innerHeight - edge.vertical ||
            rect.left < edge.side ||
            rect.right > window.innerWidth - edge.side
          ) {
            continue;
          }
          blocks.push({
            text: element.innerText,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          });
        }
        return blocks;
      }, EDGE);
      frames.push({ scrollY, base64: png.toString("base64"), blocks });
    }
    await fixture.close();

    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") console.error("[page]", message.text());
    });
    await page.goto(`${ORIGIN}/fixtures/pipeline-bench.html`);
    const send = (frame) =>
      page.evaluate(
        ({ base64, width, height, noise }) => window.pipeline.run(base64, width, height, noise),
        { base64: frame.base64, width: VIEWPORT.width, height: VIEWPORT.height, noise: NOISE },
      );

    const cold = [];
    const repeat = [];
    const scroll = [];
    const scrollRecognized = [];
    const scrollSelected = [];
    const total = { blocks: 0, exact: 0, split: 0, missed: 0, characters: 0, errors: 0 };
    const details = [];
    for (let run = 0; run < RUNS; run++) {
      await page.evaluate(() => window.pipeline.start());
      for (const [index, frame] of frames.entries()) {
        const result = await send(frame);
        if (run === 0 && TIMINGS) {
          console.log(frame.scrollY, JSON.stringify(result.timings), JSON.stringify(result.counts));
        }
        if (index === 0) {
          cold.push(result.durationMs);
          repeat.push((await send(frame)).durationMs);
        } else {
          scroll.push(result.durationMs);
          scrollRecognized.push(result.counts.recognized);
          scrollSelected.push(result.counts.selected);
        }
        if (run === 0) {
          const { summary, failures, strays } = scoreFrame(frame.blocks, result.items, density.deviceScaleFactor);
          for (const key of Object.keys(total)) total[key] += summary[key];
          details.push({ scrollY: frame.scrollY, summary, failures, strays, counts: result.counts });
        }
      }
    }
    await context.close();

    const sum = (values) => values.reduce((a, b) => a + b, 0);
    const row = {
      density: density.name,
      ...total,
      cer: total.characters ? total.errors / total.characters : 0,
      coldMs: Math.round(median(cold)),
      repeatMs: Math.round(median(repeat)),
      scrollMs: Math.round(median(scroll)),
      scrollRecognized: sum(scrollRecognized),
      scrollSelected: sum(scrollSelected),
    };
    report.push(row);
    await writeFile(join(OUT, `pipeline-${density.name}.json`), JSON.stringify(details, null, 2));
    console.log(
      `${row.density}  exact ${row.exact}/${row.blocks}  split ${row.split}  missed ${row.missed}  cer ${row.cer.toFixed(4)}  ` +
        `cold ${row.coldMs} ms  repeat ${row.repeatMs} ms  scroll ${row.scrollMs} ms  ` +
        `recognized after scroll ${row.scrollRecognized}/${row.scrollSelected} lines`,
    );
  }
  await writeFile(join(OUT, "pipeline-report.json"), JSON.stringify(report, null, 2));
  console.log(`Details: ${OUT}`);
  await browser.close();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
}
