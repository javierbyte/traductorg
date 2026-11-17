// traduct.org — live local OCR and translation overlay
// Copyright (C) 2026 Javier Bórquez
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License, version 3, as published
// by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the LICENSE file distributed with this source.

import * as ort from "onnxruntime-web/wasm";

import { groupLines } from "./layout.js";
import { createOcrEngine } from "./ocr-engine.js";
import {
  AdaptiveOcrPolicy,
  LineCache,
  MOTION_DEFAULTS,
  buildScrollFeatureMap,
  computeOcrCropRect,
  computeOcrDimensions,
  detectionScaleForText,
  displayPixelsToSampleRows,
  estimateVerticalShift,
  isFrameActive,
  lineSignature,
  meanPixelDiff,
  selectReadableBoxes,
  stableItemKey,
} from "./performance-core.js";
import { fetchVerifiedAsset, resolveLocalAssetUrl } from "./local-assets.js";

// Worker protocol: init/reset/dispose carry sessionId + frameId 0; sample and
// ocr carry monotonically increasing frameId values and transferable bitmaps,
// with displayWidth/displayHeight giving the size the bitmap is shown at.
// Responses are status, ready, motion, ocr-result, ocr-busy, or structured
// error objects with the same session/frame identity as their request.

const SCROLL_TOP_EXCLUSION_PX = 80;
const OCR_SIDE_CROP_PX = 16;
const OCR_TOP_BOTTOM_CROP_PX = 64;
const MIN_LINE_CSS_HEIGHT = 6;
const MAX_LINES = 120;
// Lines the recognizer is unsure about are dropped before translation.
const TEXT_SCORE_MIN = 0.5;
// Detection is sized for the smallest text of the last few passes; every so
// often a pass runs at the full budget so smaller text that has since
// appeared is found.
const TEXT_SCALE_HISTORY = 3;
const FULL_DETECTION_EVERY = 8;

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
let textScales = [];
let passesSinceFullDetection = 0;

const policy = new AdaptiveOcrPolicy();
const recognitionCache = new LineCache(600);

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
function prepareOcrImages(bitmap, displayWidth, displayHeight, topInset) {
  const frameWidth = bitmap.width;
  const frameHeight = bitmap.height;
  const crop = computeOcrCropRect(
    frameWidth,
    frameHeight,
    displayWidth,
    displayHeight,
    OCR_SIDE_CROP_PX,
    topInset,
    OCR_TOP_BOTTOM_CROP_PX,
  );
  const textScale = textScales.length ? Math.max(...textScales) : 1;
  const fullDetection = textScale >= 1 || passesSinceFullDetection >= FULL_DETECTION_EVERY;
  passesSinceFullDetection = fullDetection ? 0 : passesSinceFullDetection + 1;
  const detection = computeOcrDimensions(
    crop.width,
    crop.height,
    fullDetection
      ? policy.pixelBudget
      : Math.min(policy.pixelBudget, crop.width * crop.height * textScale * textScale),
  );

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
    frameCanvas,
    detection: detectionContext.getImageData(0, 0, detection.width, detection.height),
  };
}

async function handleInit(message) {
  activeSessionId = message.sessionId;
  previousSample = null;
  previousFeatures = null;
  latestSample = null;
  lastOcrSample = null;
  textScales = [];
  passesSinceFullDetection = 0;

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
  textScales = [];
  passesSinceFullDetection = 0;
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

    const { crop, frameWidth, frameHeight, frame, frameCanvas, detection } = prepareOcrImages(
      message.bitmap,
      message.displayWidth,
      message.displayHeight,
      // A frame whose window toolbar was already cut off starts at the page.
      message.topInset ?? OCR_TOP_BOTTOM_CROP_PX,
    );
    const preparedAt = performance.now();
    const detected = await activeEngine.det(detection);
    const detectedAt = performance.now();
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
    // Half a line read as text is noise, so lines cut off by the frame's
    // edge wait until they scroll into view.
    const selected = activeEngine
      .prepareLines(frame, readable, frameCanvas)
      .filter((line) => !line.clipped);

    // A line that was read before, anywhere on screen, keeps its text.
    const lines = new Array(selected.length);
    const missing = [];
    const missingSlots = [];
    for (let index = 0; index < selected.length; index++) {
      const line = selected[index];
      const signature = line.ink ? lineSignature(line.img) : null;
      const key = line.ink ? `${line.ink.width}x${line.ink.height}` : "";
      const cached = signature && recognitionCache.get(key, signature);
      if (cached) {
        lines[index] = { ...cached, box: line.box, style: line.style, score: line.score };
      } else {
        missing.push(line);
        missingSlots.push({ index, key, signature });
      }
    }
    const croppedAt = performance.now();

    if (missing.length) {
      const recognized = await activeEngine.rec(missing);
      for (let i = 0; i < recognized.length; i++) {
        const { index, key, signature } = missingSlots[i];
        const { text, mean } = recognized[i];
        lines[index] = recognized[i];
        if (signature) recognitionCache.set(key, signature, { text, mean });
      }
    }
    const recognizedAt = performance.now();

    const confidentLines = lines.filter((line) => line && line.mean >= TEXT_SCORE_MIN);
    const items = groupLines(confidentLines).map((item) => {
      const box = item.box.map(([x, y]) => [x + crop.x, y + crop.y]);
      return { ...item, box, id: stableItemKey({ ...item, box }) };
    });
    textScales.push(detectionScaleForText(items.map((item) => item.fontSize)));
    if (textScales.length > TEXT_SCALE_HISTORY) textScales.shift();
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
        reused: selected.length - missing.length,
      },
      detectionPixels: detection.width * detection.height,
      timings: {
        prepare: Math.round(preparedAt - startedAt),
        detect: Math.round(detectedAt - preparedAt),
        crop: Math.round(croppedAt - detectedAt),
        recognize: Math.round(recognizedAt - croppedAt),
        group: Math.round(performance.now() - recognizedAt),
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
