import * as Paddle from "esearch-ocr";
import * as ort from "onnxruntime-web/wasm";

import {
  AdaptiveOcrPolicy,
  LruCache,
  MOTION_DEFAULTS,
  buildAdaptiveParagraphs,
  displayPixelsToSampleRows,
  estimateVerticalShift,
  fingerprintImageData,
  isActiveGeneration,
  meanPixelDiff,
  rowLumaProfile,
  selectReadableBoxes,
  stableItemKey,
} from "./performance-core.js";
import { fetchVerifiedAsset, resolveLocalAssetUrl } from "./local-assets.js";

// Worker protocol: init/reset/dispose carry sessionId + frameId 0; sample and
// ocr carry monotonically increasing frameId values and transferable bitmaps.
// Responses are status, ready, motion, ocr-result, ocr-busy, or structured
// error objects with the same session/frame identity as their request.

const SCROLL_TOP_EXCLUSION_PX = 80;

const MODEL_CONFIG = Object.freeze({
  latin: {
    recognition: "latinRecognition",
    dictionary: "latinDictionary",
    optimizeSpaces: false,
  },
  zh: {
    recognition: "chineseRecognition",
    dictionary: "chineseDictionary",
    optimizeSpaces: false,
  },
});

ort.env.wasm.wasmPaths = { wasm: resolveLocalAssetUrl("ortWasm").href };
ort.env.wasm.proxy = false;
ort.env.wasm.numThreads = Math.min(
  4,
  Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
);

let activeSessionId = 0;
let modelId = null;
let engine = null;
let enginePromise = null;
let ocrBusy = false;
let sampleCanvas = null;
let sampleContext = null;
let ocrCanvas = null;
let ocrContext = null;
let previousSample = null;
let previousProfile = null;
let latestSample = null;
let lastOcrSample = null;

const policy = new AdaptiveOcrPolicy();
const recognitionCache = new LruCache(500);

function send(type, payload = {}) {
  self.postMessage({ type, ...payload });
}

function describeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
  };
}

async function loadRecognitionAssets(selectedModel) {
  const config = MODEL_CONFIG[selectedModel];
  if (!config) throw new Error(`Unknown OCR model: ${selectedModel}`);

  const [input, dictionary] = await Promise.all([
    fetchVerifiedAsset(config.recognition),
    fetchVerifiedAsset(config.dictionary),
  ]);
  return {
    input,
    dictionary,
    optimizeSpaces: config.optimizeSpaces,
  };
}

async function initializeEngine(selectedModel) {
  const [detector, recognition] = await Promise.all([
    fetchVerifiedAsset("detector"),
    loadRecognitionAssets(selectedModel),
  ]);

  send("status", {
    sessionId: activeSessionId,
    frameId: 0,
    message: "Initializing OCR...",
  });
  const instance = await Paddle.init({
    det: { input: detector },
    rec: {
      input: recognition.input,
      decodeDic: recognition.dictionary,
      optimize: { space: recognition.optimizeSpaces },
    },
    ort,
    ortOption: {
      graphOptimizationLevel: "all",
      executionMode: "sequential",
    },
  });
  return instance;
}

function ensureCanvas(kind, width, height) {
  if (kind === "sample") {
    if (!sampleCanvas) {
      sampleCanvas = new OffscreenCanvas(width, height);
      sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (sampleCanvas.width !== width) sampleCanvas.width = width;
    if (sampleCanvas.height !== height) sampleCanvas.height = height;
    return [sampleCanvas, sampleContext];
  }

  if (!ocrCanvas) {
    ocrCanvas = new OffscreenCanvas(width, height);
    ocrContext = ocrCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (ocrCanvas.width !== width) ocrCanvas.width = width;
  if (ocrCanvas.height !== height) ocrCanvas.height = height;
  return [ocrCanvas, ocrContext];
}

function bitmapToImageData(bitmap, kind) {
  const [canvas, context] = ensureCanvas(kind, bitmap.width, bitmap.height);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function handleInit(message) {
  activeSessionId = message.sessionId;
  previousSample = null;
  previousProfile = null;
  latestSample = null;
  lastOcrSample = null;

  if (engine && modelId === message.modelId) {
    send("ready", {
      sessionId: activeSessionId,
      frameId: 0,
      modelId,
      threads: ort.env.wasm.numThreads,
      policy: policy.snapshot(),
    });
    return;
  }

  if (!enginePromise) {
    modelId = message.modelId;
    recognitionCache.clear();
    send("status", {
      sessionId: activeSessionId,
      frameId: 0,
      message: "Loading OCR models...",
    });
    enginePromise = initializeEngine(modelId);
  }

  const pendingEngine = enginePromise;
  try {
    const initializedEngine = await pendingEngine;
    if (pendingEngine === enginePromise) {
      engine = initializedEngine;
      enginePromise = null;
    }
    if (
      !engine ||
      message.modelId !== modelId ||
      message.sessionId !== activeSessionId
    ) {
      return;
    }
    send("ready", {
      sessionId: activeSessionId,
      frameId: 0,
      modelId,
      threads: ort.env.wasm.numThreads,
      policy: policy.snapshot(),
    });
  } catch (error) {
    if (pendingEngine === enginePromise) {
      engine = null;
      enginePromise = null;
    }
    if (message.sessionId !== activeSessionId) return;
    send("error", {
      sessionId: message.sessionId,
      frameId: 0,
      stage: "init",
      error: describeError(error),
    });
  }
}

function handleReset(message) {
  activeSessionId = message.sessionId;
  previousSample = null;
  previousProfile = null;
  latestSample = null;
  lastOcrSample = null;
}

function handleSample(message) {
  if (!isActiveGeneration(message.sessionId, activeSessionId)) {
    message.bitmap.close();
    return;
  }

  const image = bitmapToImageData(message.bitmap, "sample");
  const excludedRows = displayPixelsToSampleRows(
    SCROLL_TOP_EXCLUSION_PX,
    image.height,
    message.displayHeight,
  );
  const profile = rowLumaProfile(image, 0.7, excludedRows);
  const profileDisplayHeight =
    message.displayHeight * (profile.length / image.height);
  const frameDelta = meanPixelDiff(previousSample, image.data);
  const ocrDelta = meanPixelDiff(lastOcrSample, image.data);
  const shift = estimateVerticalShift(
    previousProfile,
    profile,
    profileDisplayHeight,
  );

  previousSample = new Uint8ClampedArray(image.data);
  previousProfile = profile;
  latestSample = {
    frameId: message.frameId,
    data: new Uint8ClampedArray(image.data),
  };

  const changed = !lastOcrSample || ocrDelta > MOTION_DEFAULTS.diffThreshold;
  send("motion", {
    sessionId: message.sessionId,
    frameId: message.frameId,
    changed,
    frameDelta: Number.isFinite(frameDelta) ? frameDelta : 0,
    ocrDelta: Number.isFinite(ocrDelta) ? ocrDelta : Infinity,
    sceneChange:
      Boolean(lastOcrSample) &&
      !shift.moved &&
      ocrDelta > MOTION_DEFAULTS.sceneThreshold,
    moved: shift.moved,
    dy: shift.dy,
    confidence: shift.confidence,
  });
}

async function handleOcr(message) {
  if (!isActiveGeneration(message.sessionId, activeSessionId)) {
    message.bitmap.close();
    return;
  }
  if (ocrBusy) {
    message.bitmap.close();
    send("ocr-busy", { sessionId: message.sessionId, frameId: message.frameId });
    return;
  }

  ocrBusy = true;
  const startedAt = performance.now();
  const sampleAtCapture = latestSample?.data
    ? new Uint8ClampedArray(latestSample.data)
    : null;

  try {
    const activeEngine = engine || (await enginePromise);
    if (!activeEngine) throw new Error("OCR engine is not initialized");
    if (message.sessionId !== activeSessionId) {
      message.bitmap.close();
      return;
    }

    const image = bitmapToImageData(message.bitmap, "ocr");
    const detected = await activeEngine.det(image);
    const selected = selectReadableBoxes(
      detected,
      image.height,
      message.displayHeight,
      6,
      120,
    );

    const lines = new Array(selected.length);
    const missing = [];
    const missingIndexes = [];
    let reused = 0;

    for (let index = 0; index < selected.length; index++) {
      const box = selected[index];
      const cacheKey = `${modelId}:${fingerprintImageData(box.img)}`;
      const cached = recognitionCache.get(cacheKey);
      if (cached) {
        lines[index] = {
          text: cached.text,
          mean: cached.mean,
          box: box.box,
          style: box.style,
        };
        reused++;
      } else {
        missing.push(box);
        missingIndexes.push({ index, cacheKey });
      }
    }

    if (missing.length) {
      const recognized = await activeEngine.rec(missing);
      for (let i = 0; i < recognized.length; i++) {
        const target = missingIndexes[i];
        const line = recognized[i];
        lines[target.index] = line;
        recognitionCache.set(target.cacheKey, {
          text: line.text,
          mean: line.mean,
        });
      }
    }

    const completeLines = lines.filter(Boolean);
    const layout = Paddle.analyzeLayout(completeLines);
    const items = buildAdaptiveParagraphs(completeLines, layout).map((item) => ({
      text: item.text,
      mean: item.mean,
      box: item.box,
      style: item.style,
      lineCount: item.lineCount,
      id: stableItemKey(item),
    }));
    const durationMs = performance.now() - startedAt;
    const nextPolicy = policy.record(durationMs);
    if (sampleAtCapture) lastOcrSample = sampleAtCapture;

    if (message.sessionId !== activeSessionId) return;
    send("ocr-result", {
      sessionId: message.sessionId,
      frameId: message.frameId,
      captureScrollBase: message.captureScrollBase,
      width: image.width,
      height: image.height,
      durationMs,
      policy: nextPolicy,
      items,
      counts: {
        detected: detected.length,
        selected: selected.length,
        recognized: missing.length,
        reused,
      },
    });
  } catch (error) {
    try {
      message.bitmap.close();
    } catch (_) {
      // It was already consumed.
    }
    send("error", {
      sessionId: message.sessionId,
      frameId: message.frameId,
      stage: "ocr",
      error: describeError(error),
    });
  } finally {
    ocrBusy = false;
  }
}

self.addEventListener("message", (event) => {
  const message = event.data;
  try {
    if (message.type === "init") void handleInit(message);
    else if (message.type === "reset") handleReset(message);
    else if (message.type === "sample") handleSample(message);
    else if (message.type === "ocr") void handleOcr(message);
    else if (message.type === "dispose") self.close();
  } catch (error) {
    try {
      message.bitmap?.close();
    } catch (_) {
      // The bitmap may already have been consumed.
    }
    send("error", {
      sessionId: message.sessionId,
      frameId: message.frameId ?? 0,
      stage: message.type || "message",
      error: describeError(error),
    });
  }
});
