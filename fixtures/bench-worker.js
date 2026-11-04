// Benchmark worker: runs one OCR engine configuration on posted bitmaps and
// reports per-stage timings alongside the recognized lines. Development only.
import * as Paddle from "esearch-ocr";
import * as ort from "onnxruntime-web/wasm";

import { createOcrEngine } from "../ocr-engine.js";
import { resolveLocalAssetUrl } from "../local-assets.js";

ort.env.wasm.wasmPaths = { wasm: resolveLocalAssetUrl("ortWasm").href };
ort.env.wasm.proxy = false;

let engine = null;
let config = null;

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url} (${response.status})`);
  return response.text();
}

async function init(message) {
  config = message;
  ort.env.wasm.numThreads = message.threads || 4;
  const [detector, recognizer, dictionary] = await Promise.all([
    fetchBytes(message.det),
    fetchBytes(message.rec),
    fetchText(message.dict),
  ]);
  const sessionOptions = { graphOptimizationLevel: "all", executionMode: "sequential" };
  if (message.engine === "esearch") {
    engine = await Paddle.init({
      det: { input: detector },
      rec: { input: recognizer, decodeDic: dictionary, optimize: { space: false } },
      ort,
      ortOption: sessionOptions,
    });
  } else {
    engine = await createOcrEngine({
      ort,
      detector,
      recognizer,
      dictionary,
      sessionOptions,
      detection: message.detection || {},
      recognition: message.recognition || {},
    });
  }
}

async function run(message) {
  message.engine = config.engine;
  const bitmap = message.bitmap;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);

  const t0 = performance.now();
  let detected = await engine.det(image);
  if (message.engine !== "esearch" && engine.prepareLines) {
    detected = engine.prepareLines(canvas, detected);
  }
  const t1 = performance.now();
  const recognized = await engine.rec(detected);
  const t2 = performance.now();
  const layout = Paddle.analyzeLayout(recognized.filter((line) => line.mean >= 0.5));
  const t3 = performance.now();

  return {
    width: image.width,
    height: image.height,
    timings: { det: t1 - t0, rec: t2 - t1, layout: t3 - t2, total: t3 - t0 },
    detected: detected.length,
    lines: recognized.map((line) => ({
      text: line.text,
      mean: line.mean,
      box: line.box,
    })),
    paragraphs: (layout.columns || []).flatMap((column) =>
      (column.parragraphs || []).map((paragraph) => paragraph.parse?.text || ""),
    ),
  };
}

self.addEventListener("message", async (event) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      await init(message);
      self.postMessage({ type: "ready", id: message.id });
    } else if (message.type === "run") {
      const result = await run(message);
      self.postMessage({ type: "result", id: message.id, result });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      id: message.id,
      error: { message: error?.message || String(error), stack: error?.stack || "" },
    });
  }
});
