// traduct.org — live local OCR and translation overlay
// Copyright (C) 2026 Javier Bórquez
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License, version 3, as published
// by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the LICENSE file distributed with this source.

// A small PP-OCR pipeline on top of ONNX Runtime: DB text detection and
// CTC text recognition with the preprocessing PaddleOCR trains with.
// Everything runs on typed arrays, and recognition runs in width-sorted
// batches instead of one line at a time.
//
// The text it reads is screen text: horizontal, sharp, on a flat background.
// So each detected box is snapped to the pixels of its text before it is cut
// out. The same line then yields the same crop wherever it sits on screen,
// whatever the detector's box looked like, which lets callers recognize a
// line once and reuse the result while the page scrolls.

const DETECTION_DEFAULTS = Object.freeze({
  thresh: 0.2,
  boxThresh: 0.4,
  unclipRatio: 1.4,
  minSize: 3,
  maxCandidates: 1000,
  // PaddleOCR normalizes the BGR image with the ImageNet mean and std.
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
});

const RECOGNITION_DEFAULTS = Object.freeze({
  height: 48,
  batchSize: 8,
  // Lines only share a batch while the padding they need stays small.
  batchWidthSpread: 1.25,
  maxWidth: 4096,
  // Margin kept around the snapped text, as a share of its height.
  padX: 0.1,
  padY: 0.2,
});

// A pixel is text when its color is this far from the background (summed
// over the three channels).
const INK_DISTANCE = 96;

const STRIDE = 32;

export function parseDictionary(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  // CTC index 0 is the blank token and the model's last class is a space.
  return ["", ...lines, " "];
}

export function roundUpToStride(value, stride = STRIDE) {
  return Math.max(stride, Math.ceil(value / stride) * stride);
}

// Fills a NCHW float tensor in BGR channel order from RGBA pixels.
export function normalizeImageData(image, mean, std, paddedWidth, paddedHeight) {
  const { data, width, height } = image;
  const plane = paddedWidth * paddedHeight;
  const out = new Float32Array(plane * 3);
  const scaleB = 1 / (255 * std[0]);
  const scaleG = 1 / (255 * std[1]);
  const scaleR = 1 / (255 * std[2]);
  const offsetB = mean[0] / std[0];
  const offsetG = mean[1] / std[1];
  const offsetR = mean[2] / std[2];
  for (let y = 0; y < height; y++) {
    let source = y * width * 4;
    let target = y * paddedWidth;
    for (let x = 0; x < width; x++, source += 4, target++) {
      out[target] = data[source + 2] * scaleB - offsetB;
      out[plane + target] = data[source + 1] * scaleG - offsetG;
      out[plane * 2 + target] = data[source] * scaleR - offsetR;
    }
  }
  return out;
}

// --- Geometry -------------------------------------------------------------

function convexHull(points) {
  if (points.length < 3) return points.slice();
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Minimum-area rectangle around a point set (rotating calipers on the hull).
export function minAreaRect(points) {
  const hull = convexHull(points);
  if (hull.length === 1) {
    return { cx: hull[0][0], cy: hull[0][1], width: 0, height: 0, angle: 0 };
  }
  if (hull.length === 2) {
    const [a, b] = hull;
    return {
      cx: (a[0] + b[0]) / 2,
      cy: (a[1] + b[1]) / 2,
      width: Math.hypot(b[0] - a[0], b[1] - a[1]),
      height: 0,
      angle: Math.atan2(b[1] - a[1], b[0] - a[0]),
    };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const q = hull[(i + 1) % hull.length];
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!length) continue;
    const ux = (q[0] - p[0]) / length;
    const uy = (q[1] - p[1]) / length;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const r of hull) {
      const u = r[0] * ux + r[1] * uy;
      const v = -r[0] * uy + r[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        area,
        cx: cu * ux - cv * uy,
        cy: cu * uy + cv * ux,
        width: maxU - minU,
        height: maxV - minV,
        angle: Math.atan2(uy, ux),
      };
    }
  }
  return best;
}

function rectCorners({ cx, cy, width, height, angle }) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hw = width / 2;
  const hh = height / 2;
  return [
    [cx - hw * cos + hh * sin, cy - hw * sin - hh * cos],
    [cx + hw * cos + hh * sin, cy + hw * sin - hh * cos],
    [cx + hw * cos - hh * sin, cy + hw * sin + hh * cos],
    [cx - hw * cos - hh * sin, cy - hw * sin + hh * cos],
  ];
}

// Orders a quad as top-left, top-right, bottom-right, bottom-left so the
// first edge follows the reading direction of horizontal text.
export function orderQuad(points) {
  const sorted = points.slice().sort((a, b) => a[0] - b[0]);
  let i1 = 0;
  let i4 = 1;
  if (sorted[1][1] <= sorted[0][1]) {
    i1 = 1;
    i4 = 0;
  }
  let i2 = 2;
  let i3 = 3;
  if (sorted[3][1] <= sorted[2][1]) {
    i2 = 3;
    i3 = 2;
  }
  return [sorted[i1], sorted[i2], sorted[i3], sorted[i4]];
}

// Mean probability inside a convex quad, scanning its bounding rows.
function quadScore(pred, stride, height, quad) {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const right = Math.min(stride - 1, Math.ceil(Math.max(...xs)));
  let total = 0;
  let count = 0;
  for (let y = top; y <= bottom; y++) {
    const cy = y + 0.5;
    let spanLeft = Infinity;
    let spanRight = -Infinity;
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = quad[i];
      const [x1, y1] = quad[(i + 1) % 4];
      if ((cy >= y0 && cy < y1) || (cy >= y1 && cy < y0)) {
        const x = x0 + ((cy - y0) * (x1 - x0)) / (y1 - y0);
        if (x < spanLeft) spanLeft = x;
        if (x > spanRight) spanRight = x;
      }
    }
    if (spanLeft === Infinity) continue;
    const start = Math.max(left, Math.round(spanLeft));
    const end = Math.min(right, Math.round(spanRight) - 1);
    for (let x = start; x <= end; x++) {
      total += pred[y * stride + x];
      count++;
    }
  }
  return count ? total / count : 0;
}

// Differentiable Binarization postprocessing: threshold the probability map,
// label connected text regions, fit and expand a rotated rectangle to each.
export function detectionBoxes(pred, stride, width, height, options = {}) {
  const config = { ...DETECTION_DEFAULTS, ...options };
  const size = stride * height;
  const mask = new Uint8Array(size);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      if (pred[row + x] > config.thresh) mask[row + x] = 1;
    }
  }

  const boxes = [];
  const stack = new Int32Array(size);
  const boundary = [];
  for (let start = 0; start < size && boxes.length < config.maxCandidates; start++) {
    if (mask[start] !== 1) continue;
    let top = 0;
    stack[top++] = start;
    mask[start] = 2;
    boundary.length = 0;
    while (top) {
      const index = stack[--top];
      const x = index % stride;
      const y = (index - x) / stride;
      const up = y > 0 ? mask[index - stride] : 0;
      const down = y < height - 1 ? mask[index + stride] : 0;
      const left = x > 0 ? mask[index - 1] : 0;
      const right = x < width - 1 ? mask[index + 1] : 0;
      if (!up || !down || !left || !right) boundary.push([x, y]);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * stride + nx;
          if (mask[next] === 1) {
            mask[next] = 2;
            stack[top++] = next;
          }
        }
      }
    }

    // Pixel centers span one more unit than their indices.
    const corners = [];
    for (const [x, y] of boundary) {
      corners.push([x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]);
    }
    const rect = minAreaRect(corners);
    if (!rect || Math.min(rect.width, rect.height) < config.minSize) continue;

    const tight = orderQuad(rectCorners(rect));
    const score = quadScore(pred, stride, height, tight);
    if (score < config.boxThresh) continue;

    const area = rect.width * rect.height;
    const perimeter = 2 * (rect.width + rect.height);
    const distance = (area * config.unclipRatio) / Math.max(1, perimeter);
    const expanded = {
      ...rect,
      width: rect.width + distance * 2,
      height: rect.height + distance * 2,
    };
    if (Math.min(expanded.width, expanded.height) < config.minSize + 2) continue;

    const quad = orderQuad(rectCorners(expanded)).map(([x, y]) => [
      Math.min(width, Math.max(0, Math.round(x))),
      Math.min(height, Math.max(0, Math.round(y))),
    ]);
    const quadWidth = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
    const quadHeight = Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]);
    if (quadWidth <= 3 || quadHeight <= 3) continue;
    boxes.push({ box: quad, score });
  }

  // Reading order: top to bottom, then left to right.
  boxes.sort((a, b) => a.box[0][1] - b.box[0][1] || a.box[0][0] - b.box[0][0]);
  return boxes;
}

// --- Crops ----------------------------------------------------------------

function quantize(r, g, b) {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

function unquantize(key) {
  return [((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4];
}

function colorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// Dominant background and text colors of a frame region, from a coarse
// histogram of about a thousand evenly spread pixels.
export function estimateRegionStyle(image, rect) {
  const { data, width } = image;
  const rectWidth = rect.x1 - rect.x0;
  const rectHeight = rect.y1 - rect.y0;
  const step = Math.max(1, Math.round(Math.sqrt((rectWidth * rectHeight) / 1200)));
  const histogram = new Map();
  for (let y = rect.y0 + (step >> 1); y < rect.y1; y += step) {
    let i = (y * width + rect.x0 + (step >> 1)) * 4;
    for (let x = rect.x0 + (step >> 1); x < rect.x1; x += step, i += step * 4) {
      const key = quantize(data[i], data[i + 1], data[i + 2]);
      histogram.set(key, (histogram.get(key) || 0) + 1);
    }
  }
  const ranked = [...histogram.entries()].sort((a, b) => b[1] - a[1]);
  const bg = ranked.length ? unquantize(ranked[0][0]) : [255, 255, 255];
  let text = null;
  for (const [key] of ranked.slice(1, 12)) {
    const color = unquantize(key);
    if (colorDistance(color, bg) > 96) {
      text = color;
      break;
    }
  }
  if (!text) text = bg.map((value) => 255 - value);
  return { bg, text };
}

export function quadBounds(quad, width, height) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of quad) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  x0 = Math.min(width - 1, Math.max(0, Math.floor(x0)));
  y0 = Math.min(height - 1, Math.max(0, Math.floor(y0)));
  x1 = Math.min(width, Math.max(x0 + 1, Math.ceil(x1)));
  y1 = Math.min(height, Math.max(y0 + 1, Math.ceil(y1)));
  return { x0, y0, x1, y1 };
}

// Moves each side of a region onto the outermost row or column of its text:
// inward over empty margin, outward (a little) where the detector cut into a
// glyph. Returns null when the region holds no text pixels at all.
export function snapRectToInk(image, rect, bg) {
  const { data, width, height } = image;
  const [bgR, bgG, bgB] = bg;
  const ink = (i) =>
    Math.abs(data[i] - bgR) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bgB) >
    INK_DISTANCE;
  const rowHasInk = (y, x0, x1) => {
    for (let i = (y * width + x0) * 4, end = (y * width + x1) * 4; i < end; i += 4) {
      if (ink(i)) return true;
    }
    return false;
  };
  const columnHasInk = (x, y0, y1) => {
    for (let i = (y0 * width + x) * 4, end = (y1 * width + x) * 4; i < end; i += width * 4) {
      if (ink(i)) return true;
    }
    return false;
  };

  let { x0, y0, x1, y1 } = rect;
  const size = y1 - y0;
  const growY = Math.max(2, Math.round(size * 0.35));
  const growX = Math.max(2, Math.round(size * 0.6));

  const snapRows = () => {
    if (rowHasInk(y0, x0, x1)) {
      for (let grown = 0; grown < growY && y0 > 0 && rowHasInk(y0 - 1, x0, x1); grown++) y0--;
    } else {
      while (y0 < y1 - 1 && !rowHasInk(y0, x0, x1)) y0++;
      if (y0 === y1 - 1 && !rowHasInk(y0, x0, x1)) return false;
    }
    if (rowHasInk(y1 - 1, x0, x1)) {
      for (let grown = 0; grown < growY && y1 < height && rowHasInk(y1, x0, x1); grown++) y1++;
    } else {
      while (y1 - 1 > y0 && !rowHasInk(y1 - 1, x0, x1)) y1--;
    }
    return true;
  };

  if (!snapRows()) return null;
  if (columnHasInk(x0, y0, y1)) {
    for (let grown = 0; grown < growX && x0 > 0 && columnHasInk(x0 - 1, y0, y1); grown++) x0--;
  } else {
    while (x0 < x1 - 1 && !columnHasInk(x0, y0, y1)) x0++;
  }
  if (columnHasInk(x1 - 1, y0, y1)) {
    for (let grown = 0; grown < growX && x1 < width && columnHasInk(x1, y0, y1); grown++) x1++;
  } else {
    while (x1 - 1 > x0 && !columnHasInk(x1 - 1, y0, y1)) x1--;
  }
  // The rows were measured over the detector's width; settle them on the
  // final one so the result does not depend on where the box started.
  snapRows();
  return { x0, y0, x1, y1 };
}

// --- Recognition decoding -------------------------------------------------

// Greedy CTC decoding of one line from the recognizer's per-step softmax.
export function decodeCtc(logits, offset, steps, classes, dictionary) {
  let text = "";
  let total = 0;
  let count = 0;
  let previous = 0;
  for (let t = 0; t < steps; t++) {
    const base = offset + t * classes;
    let best = 0;
    let bestValue = logits[base];
    // Each step is a probability distribution, so a class above one half has
    // already won. Most steps are a confident blank and end here.
    if (bestValue <= 0.5) {
      for (let c = 1; c < classes; c++) {
        const value = logits[base + c];
        if (value > bestValue) {
          bestValue = value;
          best = c;
          if (value > 0.5) break;
        }
      }
    }
    if (best !== 0 && best !== previous) {
      text += dictionary[best] ?? "";
      total += bestValue;
      count++;
    }
    previous = best;
  }
  return { text: text.trim(), mean: count ? total / count : 0 };
}

// --- Engine ---------------------------------------------------------------

export async function createOcrEngine({
  ort,
  detector,
  recognizer,
  dictionary,
  sessionOptions = {},
  detection = {},
  recognition = {},
}) {
  const detectionConfig = { ...DETECTION_DEFAULTS, ...detection };
  const recognitionConfig = { ...RECOGNITION_DEFAULTS, ...recognition };
  const characters = parseDictionary(dictionary);
  const [detSession, recSession] = await Promise.all([
    ort.InferenceSession.create(detector, sessionOptions),
    ort.InferenceSession.create(recognizer, sessionOptions),
  ]);

  let sourceCanvas = null;
  let cropCanvas = null;
  let cropContext = null;

  // Crops are scaled by the canvas; pixel data without one is uploaded once.
  function canvasFor(pixels) {
    if (!sourceCanvas || sourceCanvas.width !== pixels.width || sourceCanvas.height !== pixels.height) {
      sourceCanvas = new OffscreenCanvas(pixels.width, pixels.height);
    }
    sourceCanvas.getContext("2d").putImageData(pixels, 0, 0);
    return sourceCanvas;
  }

  function cropContextFor(width, height) {
    if (!cropCanvas) {
      cropCanvas = new OffscreenCanvas(width, height);
      cropContext = cropCanvas.getContext("2d", { willReadFrequently: true });
    } else if (cropCanvas.width !== width || cropCanvas.height !== height) {
      cropCanvas.width = width;
      cropCanvas.height = height;
    }
    cropContext.resetTransform();
    cropContext.imageSmoothingEnabled = true;
    cropContext.imageSmoothingQuality = "high";
    return cropContext;
  }

  // Cuts an upright region out of the frame at the recognizer's height.
  function cropRect(canvas, rect) {
    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;
    const targetHeight = recognitionConfig.height;
    const targetWidth = Math.max(
      8,
      Math.min(recognitionConfig.maxWidth, Math.round((width * targetHeight) / height)),
    );
    const context = cropContextFor(targetWidth, targetHeight);
    context.drawImage(canvas, rect.x0, rect.y0, width, height, 0, 0, targetWidth, targetHeight);
    return context.getImageData(0, 0, targetWidth, targetHeight);
  }

  // Cuts a rotated or vertical quad out of the frame at the recognizer's
  // height. Rare on screen; kept so such text is still read.
  function cropQuad(canvas, quad) {
    let [p0, p1, , p3] = quad;
    let width = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    let height = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    if (height > width * 1.5) {
      // Vertical lines are read rotated, like PaddleOCR does.
      [p0, p1, p3] = [p3, p0, quad[2]];
      [width, height] = [height, width];
    }
    const targetHeight = recognitionConfig.height;
    const targetWidth = Math.max(
      8,
      Math.min(recognitionConfig.maxWidth, Math.round((width * targetHeight) / Math.max(1, height))),
    );
    const context = cropContextFor(targetWidth, targetHeight);
    const ax = (p1[0] - p0[0]) / Math.max(1, width);
    const ay = (p1[1] - p0[1]) / Math.max(1, width);
    const bx = (p3[0] - p0[0]) / Math.max(1, height);
    const by = (p3[1] - p0[1]) / Math.max(1, height);
    // Source axes map to output axes: solve the inverse of [a b; p0].
    const det = ax * by - ay * bx || 1e-6;
    const ia = by / det;
    const ib = -ay / det;
    const ic = -bx / det;
    const id = ax / det;
    const sx = targetWidth / Math.max(1, width);
    const sy = targetHeight / Math.max(1, height);
    context.setTransform(
      ia * sx,
      ib * sy,
      ic * sx,
      id * sy,
      -(ia * p0[0] + ic * p0[1]) * sx,
      -(ib * p0[0] + id * p0[1]) * sy,
    );
    context.drawImage(canvas, 0, 0);
    context.resetTransform();
    return context.getImageData(0, 0, targetWidth, targetHeight);
  }

  // Screen text is upright: its quad is at most slightly skewed and wider
  // than tall (or about square, for a single character).
  function isUpright(quad) {
    const [p0, p1, , p3] = quad;
    const width = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const height = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    return height <= width * 1.5 && Math.abs(p1[1] - p0[1]) <= Math.max(2, height * 0.25);
  }

  // Finds text lines in an ImageData; boxes are quads in its pixel space.
  async function det(image) {
    const paddedWidth = roundUpToStride(image.width);
    const paddedHeight = roundUpToStride(image.height);
    const input = normalizeImageData(
      image,
      detectionConfig.mean,
      detectionConfig.std,
      paddedWidth,
      paddedHeight,
    );
    const tensor = new ort.Tensor("float32", input, [1, 3, paddedHeight, paddedWidth]);
    const output = await detSession.run({ [detSession.inputNames[0]]: tensor });
    const pred = output[detSession.outputNames[0]];
    const stride = pred.dims[3];
    const boxes = detectionBoxes(pred.data, stride, image.width, image.height, detectionConfig);
    pred.dispose?.();
    return boxes;
  }

  // Turns detected quads into lines ready for recognition. `pixels` is the
  // frame's ImageData and `canvas` (optional) a canvas holding the same
  // image, both in the pixel space of the quads. Each line carries its crop
  // at recognizer height, its dominant colors, the box of its text, and
  // `ink`, the pixel size of that text: equal crops of equal `ink` size are
  // the same line. `clipped` marks a line cut off by the frame's edge.
  function prepareLines(pixels, boxes, canvas = canvasFor(pixels)) {
    const lines = [];
    for (const { box, score } of boxes) {
      const bounds = quadBounds(box, pixels.width, pixels.height);
      if (!isUpright(box)) {
        lines.push({
          box,
          img: cropQuad(canvas, box),
          style: estimateRegionStyle(pixels, bounds),
          score,
          ink: null,
        });
        continue;
      }
      const background = estimateRegionStyle(pixels, bounds).bg;
      const text = snapRectToInk(pixels, bounds, background);
      if (!text) continue;
      const inkWidth = text.x1 - text.x0;
      const inkHeight = text.y1 - text.y0;
      const padX = Math.max(2, Math.round(inkHeight * recognitionConfig.padX));
      const padY = Math.max(1, Math.round(inkHeight * recognitionConfig.padY));
      const padded = {
        x0: Math.max(0, text.x0 - padX),
        y0: Math.max(0, text.y0 - padY),
        x1: Math.min(pixels.width, text.x1 + padX),
        y1: Math.min(pixels.height, text.y1 + padY),
      };
      lines.push({
        box: [
          [text.x0, text.y0],
          [text.x1, text.y0],
          [text.x1, text.y1],
          [text.x0, text.y1],
        ],
        img: cropRect(canvas, padded),
        style: estimateRegionStyle(pixels, text),
        score,
        ink: { width: inkWidth, height: inkHeight },
        // Text that runs into the top or bottom of the frame is cut off.
        clipped: text.y0 === 0 || text.y1 === pixels.height,
      });
    }
    return lines;
  }

  function* batches(lines) {
    const order = lines
      .map((line, index) => ({ index, width: line.img.width }))
      .sort((a, b) => a.width - b.width);
    let batch = [];
    for (const entry of order) {
      if (
        batch.length === recognitionConfig.batchSize ||
        (batch.length && entry.width > batch[0].width * recognitionConfig.batchWidthSpread)
      ) {
        yield batch;
        batch = [];
      }
      batch.push(entry);
    }
    if (batch.length) yield batch;
  }

  async function rec(lines) {
    const results = new Array(lines.length);
    const height = recognitionConfig.height;
    for (const batch of batches(lines)) {
      const maxWidth = batch[batch.length - 1].width;
      const plane = height * maxWidth;
      const input = new Float32Array(batch.length * 3 * plane);
      batch.forEach(({ index }, slot) => {
        const { data, width } = lines[index].img;
        const base = slot * 3 * plane;
        for (let y = 0; y < height; y++) {
          let source = y * width * 4;
          let target = base + y * maxWidth;
          for (let x = 0; x < width; x++, source += 4, target++) {
            input[target] = data[source + 2] / 127.5 - 1;
            input[plane + target] = data[source + 1] / 127.5 - 1;
            input[plane * 2 + target] = data[source] / 127.5 - 1;
          }
        }
      });
      const tensor = new ort.Tensor("float32", input, [batch.length, 3, height, maxWidth]);
      const output = await recSession.run({ [recSession.inputNames[0]]: tensor });
      const logits = output[recSession.outputNames[0]];
      const [, steps, classes] = logits.dims;
      batch.forEach(({ index }, slot) => {
        const decoded = decodeCtc(logits.data, slot * steps * classes, steps, classes, characters);
        const line = lines[index];
        results[index] = { ...decoded, box: line.box, style: line.style, score: line.score };
      });
      logits.dispose?.();
    }
    return results;
  }

  return {
    det,
    prepareLines,
    rec,
    async dispose() {
      await Promise.all([detSession.release?.(), recSession.release?.()]);
    },
  };
}
