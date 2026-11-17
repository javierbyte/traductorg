// traduct.org — live local OCR and translation overlay
// Copyright (C) 2026 Javier Bórquez
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License, version 3, as published
// by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the LICENSE file distributed with this source.

const OCR_POLICY_DEFAULTS = Object.freeze({
  initialPixels: 2_000_000,
  minPixels: 1_100_000,
  maxPixels: 3_000_000,
  targetMs: 900,
  lowerMs: 650,
  upperMs: 1200,
  adaptFactor: 0.15,
  samplesBeforeAdapt: 3,
  adaptIntervalMs: 10_000,
  emaAlpha: 0.25,
  minCooldownMs: 750,
  maxCooldownMs: 3000,
  cooldownMultiplier: 1.5,
});

export const MOTION_DEFAULTS = Object.freeze({
  diffThreshold: 4,
  activityThreshold: 1.25,
  maxShiftRows: 64,
  minDisplayDy: 0.3,
  minOverlap: 0.65,
  minTexture: 1.5,
  retainedColumns: 0.7,
  confidence: 0.18,
  uniqueness: 0.035,
  maxResidual: 0.9,
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function computeOcrDimensions(sourceWidth, sourceHeight, pixelBudget) {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    return { width: 1, height: 1, pixels: 1 };
  }

  const scale = Math.min(
    1,
    Math.sqrt(Math.max(1, pixelBudget) / (sourceWidth * sourceHeight)),
  );
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  return { width, height, pixels: width * height };
}

// How far a frame can be shrunk for text detection, given the font sizes (in
// frame pixels) read from it so far. The detector finds text comfortably down
// to about a dozen pixels, and each line is recognized from the full frame
// anyway, so a frame from a high-density display, where the smallest text is
// 26 pixels tall, is searched at under half its size. Returns 1 while there
// is too little text to judge by.
export function detectionScaleForText(fontSizes, targetFontPixels = 12, minimumLines = 3) {
  const sizes = (fontSizes || []).filter((size) => size > 0).sort((a, b) => a - b);
  if (sizes.length < minimumLines) return 1;
  const small = sizes[Math.floor(sizes.length * 0.1)];
  return clamp(targetFontPixels / small, 0.3, 1);
}

// The part of a frame that is searched for text: the frame without a margin
// on each side, given in pixels of the displayed video. The margins hold
// window edges, scrollbars and docked bars rather than reading text.
export function computeOcrCropRect(
  imageWidth,
  imageHeight,
  displayWidth,
  displayHeight,
  horizontalInsetCssPixels = 16,
  topInsetCssPixels = 64,
  bottomInsetCssPixels = topInsetCssPixels,
) {
  const width = Math.max(1, Math.round(imageWidth) || 1);
  const height = Math.max(1, Math.round(imageHeight) || 1);
  if (!(displayWidth > 0) || !(displayHeight > 0)) {
    return { x: 0, y: 0, width, height };
  }

  const inset = (cssPixels, displaySize, imageSize) =>
    cssPixels > 0 ? Math.round((Math.min(cssPixels, displaySize / 4) / displaySize) * imageSize) : 0;
  const x = inset(horizontalInsetCssPixels, displayWidth, width);
  const y = inset(topInsetCssPixels, displayHeight, height);
  const bottom = inset(bottomInsetCssPixels, displayHeight, height);
  return { x, y, width: width - x * 2, height: height - y - bottom };
}

export class AdaptiveOcrPolicy {
  constructor(options = {}) {
    this.options = { ...OCR_POLICY_DEFAULTS, ...options };
    this.pixelBudget = this.options.initialPixels;
    this.averageMs = this.options.targetMs;
    this.slowStreak = 0;
    this.fastStreak = 0;
    this.lastAdaptAt = -Infinity;
    this.samples = 0;
  }

  record(durationMs, now = performance.now()) {
    if (!(durationMs > 0)) return this.snapshot();

    const { emaAlpha, lowerMs, upperMs, samplesBeforeAdapt } = this.options;
    this.averageMs =
      this.samples === 0
        ? durationMs
        : this.averageMs * (1 - emaAlpha) + durationMs * emaAlpha;
    this.samples++;

    if (this.averageMs > upperMs) {
      this.slowStreak++;
      this.fastStreak = 0;
    } else if (this.averageMs < lowerMs) {
      this.fastStreak++;
      this.slowStreak = 0;
    } else {
      this.slowStreak = 0;
      this.fastStreak = 0;
    }

    const canAdapt = now - this.lastAdaptAt >= this.options.adaptIntervalMs;
    if (canAdapt && this.slowStreak >= samplesBeforeAdapt) {
      this.pixelBudget = Math.round(
        clamp(
          this.pixelBudget * (1 - this.options.adaptFactor),
          this.options.minPixels,
          this.options.maxPixels,
        ),
      );
      this.lastAdaptAt = now;
      this.slowStreak = 0;
    } else if (canAdapt && this.fastStreak >= samplesBeforeAdapt) {
      this.pixelBudget = Math.round(
        clamp(
          this.pixelBudget * (1 + this.options.adaptFactor),
          this.options.minPixels,
          this.options.maxPixels,
        ),
      );
      this.lastAdaptAt = now;
      this.fastStreak = 0;
    }

    return this.snapshot();
  }

  cooldownMs() {
    return Math.round(
      clamp(
        this.averageMs * this.options.cooldownMultiplier,
        this.options.minCooldownMs,
        this.options.maxCooldownMs,
      ),
    );
  }

  snapshot() {
    return {
      pixelBudget: this.pixelBudget,
      averageMs: Math.round(this.averageMs),
      cooldownMs: this.cooldownMs(),
    };
  }
}

export class LruCache {
  constructor(maxSize) {
    this.maxSize = Math.max(1, maxSize);
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      this.map.delete(this.map.keys().next().value);
    }
    return this;
  }

  clear() {
    this.map.clear();
  }
}

export class SupersedingQueue {
  constructor() {
    this.current = null;
  }

  replace(entries, metadata = {}) {
    this.current = {
      ...metadata,
      entries: [...entries],
      index: 0,
    };
    return this.current;
  }

  clear() {
    this.current = null;
  }

  next() {
    const job = this.current;
    if (!job) return null;
    if (job.index < job.entries.length) {
      return { job, entry: job.entries[job.index++] };
    }
    if (this.current === job) this.current = null;
    return null;
  }
}

export class OverlayReplacementPolicy {
  constructor(emptyConfirmations = 2) {
    this.emptyConfirmations = Math.max(1, emptyConfirmations);
    this.emptyStreak = 0;
    this.pending = null;
  }

  reset() {
    this.emptyStreak = 0;
    this.pending = null;
  }

  submit(batch) {
    this.pending = batch;
    if (batch.items.length) {
      this.emptyStreak = 0;
      return "hold";
    }
    this.emptyStreak++;
    this.pending = null;
    return this.emptyStreak >= this.emptyConfirmations ? "clear" : "hold";
  }

  isCurrent(batch) {
    return Boolean(
      batch &&
        this.pending === batch &&
        batch.generation === this.pending.generation &&
        batch.pair === this.pending.pair,
    );
  }

  markRenderable(batch, count) {
    if (!this.isCurrent(batch) || batch.promoted || count <= 0) return false;
    batch.promoted = true;
    return true;
  }

  finish(batch) {
    if (this.pending === batch) this.pending = null;
  }
}

export function normalizeText(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function quadHeight(box) {
  if (!box || box.length < 4) return 0;
  return Math.hypot(box[3][0] - box[0][0], box[3][1] - box[0][1]);
}

function quadArea(box) {
  if (!box || box.length < 4) return 0;
  let area = 0;
  for (let i = 0; i < box.length; i++) {
    const next = box[(i + 1) % box.length];
    area += box[i][0] * next[1] - next[0] * box[i][1];
  }
  return Math.abs(area) / 2;
}

export function selectReadableBoxes(
  boxes,
  imageHeight,
  displayHeight,
  minCssHeight = 6,
  maxRegions = 120,
) {
  const scale = displayHeight / Math.max(1, imageHeight);
  const readable = (boxes || [])
    .map((box, index) => ({ box, index, area: quadArea(box.box) }))
    .filter(({ box }) => quadHeight(box.box) * scale >= minCssHeight);

  if (readable.length <= maxRegions) return readable.map(({ box }) => box);
  return readable
    .sort((a, b) => b.area - a.area)
    .slice(0, maxRegions)
    .sort((a, b) => a.index - b.index)
    .map(({ box }) => box);
}

// A coarse brightness map of a line crop: the mean of every 4x4 block. Small
// enough to keep for hundreds of lines, and averaging absorbs the per-pixel
// noise that screen capture adds, so two crops of the same line compare equal
// while a single changed character does not.
export function lineSignature(imageData) {
  const { data, width, height } = imageData;
  const columns = width >> 2;
  const rows = height >> 2;
  const signature = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      let total = 0;
      for (let y = row * 4; y < row * 4 + 4; y++) {
        let i = (y * width + column * 4) * 4;
        for (let x = 0; x < 4; x++, i += 4) {
          total += data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29;
        }
      }
      signature[row * columns + column] = total >> 12;
    }
  }
  return signature;
}

function signaturesMatch(a, b, tolerance) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const difference = a[i] - b[i];
    if (difference > tolerance || difference < -tolerance) return false;
  }
  return true;
}

// Remembers what recognized lines said, so a line that is still on screen
// after a scroll is not recognized again. Lines are filed under a key (their
// size in pixels) and matched by signature within `tolerance` brightness
// levels per block. The least recently used entries are dropped first.
export class LineCache {
  constructor(maxEntries = 600, tolerance = 12) {
    this.maxEntries = Math.max(1, maxEntries);
    this.tolerance = tolerance;
    this.buckets = new Map();
    this.entries = new Set();
  }

  get size() {
    return this.entries.size;
  }

  get(key, signature) {
    for (const entry of this.buckets.get(key) || []) {
      if (!signaturesMatch(entry.signature, signature, this.tolerance)) continue;
      this.entries.delete(entry);
      this.entries.add(entry);
      return entry.value;
    }
    return undefined;
  }

  set(key, signature, value) {
    const entry = { key, signature, value };
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push(entry);
    else this.buckets.set(key, [entry]);
    this.entries.add(entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.values().next().value;
      this.entries.delete(oldest);
      const peers = this.buckets.get(oldest.key);
      peers.splice(peers.indexOf(oldest), 1);
      if (!peers.length) this.buckets.delete(oldest.key);
    }
  }

  clear() {
    this.buckets.clear();
    this.entries.clear();
  }
}

export function meanPixelDiff(previous, current) {
  if (!previous || !current || previous.length !== current.length) return Infinity;
  let difference = 0;
  let pixels = 0;
  for (let i = 0; i < current.length; i += 4) {
    difference += Math.abs(current[i] - previous[i]);
    difference += Math.abs(current[i + 1] - previous[i + 1]);
    difference += Math.abs(current[i + 2] - previous[i + 2]);
    pixels++;
  }
  return pixels ? difference / (pixels * 3) : 0;
}

export function isFrameActive(
  frameDelta,
  threshold = MOTION_DEFAULTS.activityThreshold,
) {
  return Number.isFinite(frameDelta) && frameDelta > threshold;
}

export function displayPixelsToSampleRows(
  displayPixels,
  sampleHeight,
  displayHeight,
) {
  if (!(displayPixels > 0) || !(sampleHeight > 1) || !(displayHeight > 0)) {
    return 0;
  }
  return clamp(
    Math.round((displayPixels / displayHeight) * sampleHeight),
    0,
    sampleHeight - 1,
  );
}

export function buildScrollFeatureMap(imageData, startRow = 0) {
  const { data, width, height: sourceHeight } = imageData;
  const height = Math.max(1, sourceHeight);
  const firstRow = clamp(Math.round(startRow), 0, Math.max(0, height - 1));
  const featureHeight = sourceHeight - firstRow;
  const luma = new Float32Array(width * sourceHeight);
  const features = new Float32Array(width * featureHeight);

  for (let y = 0; y < sourceHeight; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      luma[y * width + x] =
        data[index] * 0.299 +
        data[index + 1] * 0.587 +
        data[index + 2] * 0.114;
    }
  }

  for (let y = firstRow; y < sourceHeight; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const vertical = y ? Math.abs(luma[index] - luma[index - width]) : 0;
      const horizontal = x ? Math.abs(luma[index] - luma[index - 1]) : 0;
      features[(y - firstRow) * width + x] = vertical + horizontal * 0.35;
    }
  }

  return {
    data: features,
    width,
    height: featureHeight,
    sourceHeight,
  };
}

function featureResidual(previous, current, shift, config) {
  if (
    !previous ||
    !current ||
    previous.width !== current.width ||
    previous.height !== current.height
  ) {
    return Infinity;
  }

  const { width, height } = current;
  const start = Math.max(0, -shift);
  const end = Math.min(height, height - shift);
  if (end - start < height * config.minOverlap) return Infinity;

  const columns = [];
  for (let x = 0; x < width; x++) {
    let error = 0;
    let texture = 0;
    let count = 0;
    for (let y = start; y < end; y++) {
      const previousValue = previous.data[y * width + x];
      const currentValue = current.data[(y + shift) * width + x];
      error += Math.abs(previousValue - currentValue);
      texture += (previousValue + currentValue) * 0.5;
      count++;
    }
    const averageTexture = count ? texture / count : 0;
    if (averageTexture >= config.minTexture) {
      columns.push((error / count) / (averageTexture + 1));
    }
  }

  if (columns.length < Math.min(4, width)) return Infinity;
  columns.sort((a, b) => a - b);
  const retained = Math.max(
    Math.min(4, columns.length),
    Math.ceil(columns.length * config.retainedColumns),
  );
  let total = 0;
  for (let index = 0; index < retained; index++) total += columns[index];
  return total / retained;
}

export function estimateVerticalShift(
  previous,
  current,
  displayHeight,
  options = {},
) {
  const config = { ...MOTION_DEFAULTS, ...options };
  const noMovement = (confidence = 0, uniqueness = 0, residual = Infinity) => ({
    moved: false,
    dy: 0,
    confidence,
    uniqueness,
    residual,
  });
  if (!previous || !current) return noMovement();

  const maxShift = Math.min(
    config.maxShiftRows,
    Math.max(1, Math.floor(current.height * (1 - config.minOverlap))),
  );
  const scores = new Map();
  const residualAt = (shift) => {
    if (!scores.has(shift)) {
      scores.set(shift, featureResidual(previous, current, shift, config));
    }
    return scores.get(shift);
  };
  const zeroResidual = residualAt(0);
  let bestShift = 0;
  let bestResidual = Infinity;

  for (let shift = -maxShift; shift <= maxShift; shift++) {
    const residual = residualAt(shift);
    if (residual < bestResidual) {
      bestResidual = residual;
      bestShift = shift;
    }
  }

  const confidence =
    Number.isFinite(zeroResidual) && zeroResidual > 0
      ? (zeroResidual - bestResidual) / zeroResidual
      : 0;
  let runnerUp = Infinity;
  for (const [shift, residual] of scores) {
    if (Math.abs(shift - bestShift) <= 2) continue;
    runnerUp = Math.min(runnerUp, residual);
  }
  const uniqueness =
    Number.isFinite(runnerUp) && runnerUp > 0
      ? (runnerUp - bestResidual) / runnerUp
      : 0;
  if (
    bestShift === 0 ||
    !Number.isFinite(bestResidual) ||
    bestResidual > config.maxResidual ||
    confidence < config.confidence ||
    uniqueness < config.uniqueness
  ) {
    return noMovement(confidence, uniqueness, bestResidual);
  }

  let refinedShift = bestShift;
  if (bestShift > -maxShift && bestShift < maxShift) {
    const before = residualAt(bestShift - 1);
    const after = residualAt(bestShift + 1);
    const denominator = before - 2 * bestResidual + after;
    if (denominator > 0) {
      const delta = (0.5 * (before - after)) / denominator;
      if (delta > -1 && delta < 1) refinedShift += delta;
    }
  }

  // A negative shift means a feature that used to be lower is now higher,
  // which is a negative on-screen displacement for the content.
  const dy = refinedShift * (displayHeight / current.sourceHeight);
  if (Math.abs(dy) < config.minDisplayDy) {
    return noMovement(confidence, uniqueness, bestResidual);
  }
  return { moved: true, dy, confidence, uniqueness, residual: bestResidual };
}

export function quadToDisplayRect(box, imageWidth, imageHeight, displayWidth, displayHeight) {
  const points = box.map(([x, y]) => [
    (x / Math.max(1, imageWidth)) * displayWidth,
    (y / Math.max(1, imageHeight)) * displayHeight,
  ]);
  const [topLeft, topRight, bottomRight, bottomLeft] = points;
  const left = Math.min(topLeft[0], bottomLeft[0]);
  const top = Math.min(topLeft[1], topRight[1]);
  const right = Math.max(topRight[0], bottomRight[0]);
  const bottom = Math.max(bottomLeft[1], bottomRight[1]);
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
    // UI text is horizontal; detector skew must never rotate the overlay.
    angle: 0,
  };
}

// Translations are set a little smaller than the text they cover (given as
// its font size in display pixels): they are often longer than the original
// and have to fit the same box. Small text keeps a readable minimum.
export function computeOverlayFontSize(sourceFontSize) {
  return Math.max(9, (sourceFontSize || 0) * 0.92);
}

export function inferOverlayTextAlign(rect, lineCount, displayWidth) {
  const lines = Math.max(1, lineCount || 1);
  const centerTolerance = Math.max(24, displayWidth * 0.05);
  const boxCenter = rect.left + rect.width / 2;
  const obviouslyCentered =
    lines === 1 &&
    rect.width <= displayWidth * 0.8 &&
    Math.abs(boxCenter - displayWidth / 2) <= centerTolerance;
  return obviouslyCentered ? "center" : "left";
}

export function stableItemKey(item) {
  const coordinates = (item.box || [])
    .flat()
    .map((value) => Math.round(value / 4) * 4)
    .join(",");
  const value = `${normalizeText(item.text)}|${coordinates}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
