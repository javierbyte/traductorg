// traduct.org — live local OCR and translation overlay
// Copyright (C) 2026 Javier Bórquez
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License, version 3, as published
// by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the LICENSE file distributed with this source.

import { analyzeLayout } from "esearch-ocr";
import * as ort from "onnxruntime-web/wasm";

import { createOcrEngine } from "./ocr-engine.js";
import {
  AdaptiveOcrPolicy,
  LruCache,
  MOTION_DEFAULTS,
  buildAdaptiveParagraphs,
  buildScrollFeatureMap,
  computeOcrCropRect,
  computeOcrDimensions,
  displayPixelsToSampleRows,
  estimateVerticalShift,
  fingerprintImageData,
  isFrameActive,
  meanPixelDiff,
  selectReadableBoxes,
  stableItemKey,
} from "./performance-core.js";
import { fetchVerifiedAsset, resolveLocalAssetUrl } from "./local-assets.js";

// Worker protocol: init/reset/dispose carry sessionId + frameId 0; sample and
// ocr carry monotonically increasing frameId values and transferable bitmaps.
// Responses are status, ready, motion, ocr-result, ocr-busy, or structured
// error objects with the same session/frame identity as their request.

const SCROLL_TOP_EXCLUSION_PX = 80;
const OCR_SIDE_CROP_PX = 16;
const OCR_TOP_BOTTOM_CROP_PX = 64;
const MIN_LINE_CSS_HEIGHT = 6;
const MAX_LINES = 120;
// Lines the recognizer is unsure about are dropped before translation.
const TEXT_SCORE_MIN = 0.5;

ort.env.wasm.wasmPaths = { wasm: resolveLocalAssetUrl("ortWasm").href };
ort.env.wasm.proxy = false;
ort.env.wasm.numThreads = Math.min(
  4,
  Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
);

let activeSessionId = 0;
let engine = null;
let enginePromise = null;
let ocrBusy = false;
let sampleCanvas = null;
let sampleContext = null;
let frameCanvas = null;
let frameContext = null;
let detectionCanvas = null;
let detectionContext = null;
let previousSample = null;
let previousFeatures = null;
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

async function initializeEngine() {
  const [detector, recognizer, dictionary] = await Promise.all([
    fetchVerifiedAsset("detector"),
    fetchVerifiedAsset("recognizer"),
    fetchVerifiedAsset("dictionary"),
  ]);
  send("status", {
    sessionId: activeSessionId,
    frameId: 0,
    message: "Initializing OCR...",
  });
  return createOcrEngine({
    ort,
    detector,
    recognizer,
    dictionary,
    sessionOptions: {
      graphOptimizationLevel: "all",
      executionMode: "sequential",
    },
  });
}

function ensureCanvas(canvas, context, width, height) {
  if (!canvas) {
    canvas = new OffscreenCanvas(width, height);
    context = canvas.getContext("2d", { willReadFrequently: true });
  } else if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return [canvas, context];
}

function bitmapToSampleImageData(bitmap) {
  const { width, height } = bitmap;
  [sampleCanvas, sampleContext] = ensureCanvas(sampleCanvas, sampleContext, width, height);
  sampleContext.drawImage(bitmap, 0, 0);
  bitmap.close();
  return sampleContext.getImageData(0, 0, width, height);
}

// Text is detected on a size-limited copy of the frame, but each line is cut
// for recognition from the full-resolution capture, so small text on dense
// displays stays legible to the recognizer.
function prepareOcrImages(bitmap, displayWidth, displayHeight) {
  const frameWidth = bitmap.width;
  const frameHeight = bitmap.height;
  const crop = computeOcrCropRect(
    frameWidth,
    frameHeight,
    displayWidth,
    displayHeight,
    OCR_SIDE_CROP_PX,
    OCR_TOP_BOTTOM_CROP_PX,
  );
  const detection = computeOcrDimensions(crop.width, crop.height, policy.pixelBudget);

  [frameCanvas, frameContext] = ensureCanvas(frameCanvas, frameContext, crop.width, crop.height);
  frameContext.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);

  [detectionCanvas, detectionContext] = ensureCanvas(
    detectionCanvas,
    detectionContext,
    detection.width,
    detection.height,
  );
  detectionContext.imageSmoothingEnabled = true;
  detectionContext.imageSmoothingQuality = "high";
  detectionContext.drawImage(frameCanvas, 0, 0, detection.width, detection.height);
  bitmap.close();

  return {
    crop,
    frameWidth,
    frameHeight,
    frame: frameContext.getImageData(0, 0, crop.width, crop.height),
    detection: detectionContext.getImageData(0, 0, detection.width, detection.height),
  };
}

async function handleInit(message) {
  activeSessionId = message.sessionId;
  previousSample = null;
  previousFeatures = null;
  latestSample = null;
  lastOcrSample = null;

  if (engine) {
    send("ready", {
      sessionId: activeSessionId,
      frameId: 0,
      threads: ort.env.wasm.numThreads,
      policy: policy.snapshot(),
    });
    return;
  }

  if (!enginePromise) {
    recognitionCache.clear();
    send("status", {
      sessionId: activeSessionId,
      frameId: 0,
      message: "Loading OCR models...",
    });
    enginePromise = initializeEngine();
  }

  const pendingEngine = enginePromise;
  try {
    const initializedEngine = await pendingEngine;
    if (pendingEngine === enginePromise) {
      engine = initializedEngine;
      enginePromise = null;
    }
    if (!engine || message.sessionId !== activeSessionId) return;
    send("ready", {
      sessionId: activeSessionId,
      frameId: 0,
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
  previousFeatures = null;
  latestSample = null;
  lastOcrSample = null;
}

function handleSample(message) {
  if (message.sessionId !== activeSessionId) {
    message.bitmap.close();
    return;
  }

  const image = bitmapToSampleImageData(message.bitmap);
  const excludedRows = displayPixelsToSampleRows(
    SCROLL_TOP_EXCLUSION_PX,
    image.height,
    message.displayHeight,
  );
  const features = buildScrollFeatureMap(image, excludedRows);
  const frameDelta = meanPixelDiff(previousSample, image.data);
  const ocrDelta = meanPixelDiff(lastOcrSample, image.data);
  const shift = estimateVerticalShift(
    previousFeatures,
    features,
    message.displayHeight,
  );

  previousSample = new Uint8ClampedArray(image.data);
  previousFeatures = features;
  latestSample = {
    frameId: message.frameId,
    data: new Uint8ClampedArray(image.data),
  };

  send("motion", {
    sessionId: message.sessionId,
    frameId: message.frameId,
    changed: !lastOcrSample || ocrDelta > MOTION_DEFAULTS.diffThreshold,
    active: isFrameActive(frameDelta),
    moved: shift.moved,
    dy: shift.dy,
  });
}

async function handleOcr(message) {
  if (message.sessionId !== activeSessionId) {
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

    const { crop, frameWidth, frameHeight, frame, detection } = prepareOcrImages(
      message.bitmap,
      message.displayWidth,
      message.displayHeight,
    );
    const detected = await activeEngine.det(detection);
    const scaleX = frame.width / detection.width;
    const scaleY = frame.height / detection.height;
    const readable = selectReadableBoxes(
      detected.map((entry) => ({
        ...entry,
        box: entry.box.map(([x, y]) => [x * scaleX, y * scaleY]),
      })),
      frame.height,
      message.displayHeight,
      MIN_LINE_CSS_HEIGHT,
      MAX_LINES,
    );
    const selected = activeEngine.prepareLines(frame, readable);

    const lines = new Array(selected.length);
    const missing = [];
    const missingIndexes = [];
    let reused = 0;

    for (let index = 0; index < selected.length; index++) {
      const line = selected[index];
      const cacheKey = fingerprintImageData(line.img);
      const cached = recognitionCache.get(cacheKey);
      if (cached) {
        lines[index] = { ...cached, box: line.box, style: line.style };
        reused++;
      } else {
        missing.push(line);
        missingIndexes.push({ index, cacheKey });
      }
    }

    if (missing.length) {
      const recognized = await activeEngine.rec(missing);
      for (let i = 0; i < recognized.length; i++) {
        const target = missingIndexes[i];
        const { text, mean } = recognized[i];
        lines[target.index] = recognized[i];
        recognitionCache.set(target.cacheKey, { text, mean });
      }
    }

    const confidentLines = lines.filter((line) => line && line.mean >= TEXT_SCORE_MIN);
    const layout = analyzeLayout(confidentLines);
    const items = buildAdaptiveParagraphs(confidentLines, layout).map((item) => {
      const box = item.box.map(([x, y]) => [x + crop.x, y + crop.y]);
      return {
        text: item.text,
        mean: item.mean,
        box,
        style: item.style,
        lineCount: item.lineCount,
        id: stableItemKey({ ...item, box }),
      };
    });
    const durationMs = performance.now() - startedAt;
    const nextPolicy = policy.record(durationMs);
    if (sampleAtCapture) lastOcrSample = sampleAtCapture;

    if (message.sessionId !== activeSessionId) return;
    send("ocr-result", {
      sessionId: message.sessionId,
      frameId: message.frameId,
      captureScrollBase: message.captureScrollBase,
      width: frameWidth,
      height: frameHeight,
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
