import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCtc,
  detectionBoxes,
  estimateRegionStyle,
  minAreaRect,
  normalizeImageData,
  orderQuad,
  parseDictionary,
  quadBounds,
  roundUpToStride,
  snapRectToInk,
} from "../ocr-engine.js";

test("dictionaries gain the CTC blank and the trailing space class", () => {
  assert.deepEqual(parseDictionary("a\nb\nc\n"), ["", "a", "b", "c", " "]);
  assert.deepEqual(parseDictionary("a\r\nb"), ["", "a", "b", " "]);
});

test("detector inputs are padded up to the network stride", () => {
  assert.equal(roundUpToStride(1), 32);
  assert.equal(roundUpToStride(32), 32);
  assert.equal(roundUpToStride(33), 64);
  assert.equal(roundUpToStride(1712), 1728);
});

test("normalization writes BGR planes with ImageNet statistics into the padded tensor", () => {
  const image = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) };
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const tensor = normalizeImageData(image, mean, std, 32, 32);
  assert.equal(tensor.length, 3 * 32 * 32);
  // Pixel 0 is pure red: its blue plane value is the normalized zero.
  assert.ok(Math.abs(tensor[0] - (0 - mean[0]) / std[0]) < 1e-5);
  assert.ok(Math.abs(tensor[2 * 32 * 32] - (1 - mean[2]) / std[2]) < 1e-5);
  // Pixel 1 is pure blue.
  assert.ok(Math.abs(tensor[1] - (1 - mean[0]) / std[0]) < 1e-5);
  // Padding stays at zero.
  assert.equal(tensor[2], 0);
  assert.equal(tensor[32], 0);
});

test("CTC decoding drops blanks, merges repeats and averages confidence", () => {
  const dictionary = ["", "h", "i", " "];
  const classes = dictionary.length;
  const steps = [
    [0.1, 0.8, 0.05, 0.05], // h
    [0.1, 0.7, 0.1, 0.1], // h (repeat)
    [0.9, 0.05, 0.03, 0.02], // blank
    [0.1, 0.1, 0.6, 0.2], // i
    [0.1, 0.1, 0.1, 0.7], // space
    [0.1, 0.1, 0.1, 0.7], // space (repeat)
  ];
  const logits = Float32Array.from(steps.flat());
  const decoded = decodeCtc(logits, 0, steps.length, classes, dictionary);
  assert.equal(decoded.text, "hi");
  assert.ok(Math.abs(decoded.mean - (0.8 + 0.6 + 0.7) / 3) < 1e-6);

  const batched = new Float32Array(2 * logits.length);
  batched.set(logits, logits.length);
  assert.equal(decodeCtc(batched, logits.length, steps.length, classes, dictionary).text, "hi");
  assert.equal(decodeCtc(batched, 0, steps.length, classes, dictionary).text, "");
});

test("minimum-area rectangles recover axis-aligned and rotated extents", () => {
  const square = minAreaRect([[0, 0], [10, 0], [10, 4], [0, 4]]);
  assert.ok(Math.abs(square.width * square.height - 40) < 1e-6);
  assert.ok(Math.abs(Math.max(square.width, square.height) - 10) < 1e-6);

  const angle = Math.PI / 6;
  const rotated = [[0, 0], [20, 0], [20, 5], [0, 5]].map(([x, y]) => [
    x * Math.cos(angle) - y * Math.sin(angle),
    x * Math.sin(angle) + y * Math.cos(angle),
  ]);
  const rect = minAreaRect(rotated);
  assert.ok(Math.abs(rect.width * rect.height - 100) < 1e-6);
  assert.ok(Math.abs(Math.max(rect.width, rect.height) - 20) < 1e-6);
});

test("quads are ordered clockwise from the top-left corner", () => {
  assert.deepEqual(orderQuad([[10, 4], [0, 4], [10, 0], [0, 0]]), [
    [0, 0],
    [10, 0],
    [10, 4],
    [0, 4],
  ]);
});

test("DB postprocessing turns a probability blob into one expanded, scored box", () => {
  const width = 96;
  const height = 64;
  const stride = 96;
  const pred = new Float32Array(stride * height);
  for (let y = 20; y < 28; y++) {
    for (let x = 10; x < 70; x++) pred[y * stride + x] = 0.9;
  }
  // A faint speck below the threshold must not produce a box.
  pred[50 * stride + 50] = 0.15;

  const boxes = detectionBoxes(pred, stride, width, height, {
    thresh: 0.2,
    boxThresh: 0.4,
    unclipRatio: 1.4,
  });
  assert.equal(boxes.length, 1);
  const [{ box, score }] = boxes;
  assert.ok(score > 0.85);
  const [topLeft, topRight, bottomRight, bottomLeft] = box;
  assert.ok(topLeft[0] < 10 && topLeft[1] < 20);
  assert.ok(topRight[0] > 70 && topRight[1] < 20);
  assert.ok(bottomRight[0] > 70 && bottomRight[1] > 28);
  assert.ok(bottomLeft[0] < 10 && bottomLeft[1] > 28);
  // The expansion stays proportional to the blob: roughly 4 px on each side.
  assert.ok(topLeft[0] >= 4 && bottomRight[1] <= 36);
});

test("low-confidence blobs are rejected by the box threshold", () => {
  const stride = 64;
  const pred = new Float32Array(stride * 32);
  for (let y = 10; y < 16; y++) {
    for (let x = 10; x < 40; x++) pred[y * stride + x] = 0.3;
  }
  assert.equal(detectionBoxes(pred, stride, 64, 32, { thresh: 0.2, boxThresh: 0.4 }).length, 0);
  assert.equal(detectionBoxes(pred, stride, 64, 32, { thresh: 0.2, boxThresh: 0.25 }).length, 1);
});

// A white frame with dark "text" in the given rectangles.
function frameWith(width, height, marks) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x0, y0, x1, y1] of marks) {
    for (let y = y0; y < y1; y++) data.fill(30, (y * width + x0) * 4, (y * width + x1) * 4);
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height };
}

test("a region's style is its background and the color that stands out from it", () => {
  const frame = frameWith(200, 60, [[20, 20, 60, 40], [80, 20, 130, 40]]);
  const style = estimateRegionStyle(frame, { x0: 10, y0: 10, x1: 190, y1: 50 });
  assert.ok(style.bg.every((value) => value > 240));
  assert.ok(style.text.every((value) => value < 48));
});

test("boxes snap to their text from any starting box", () => {
  // Two words on one line, and the top of another line just below.
  const frame = frameWith(300, 100, [[40, 30, 120, 50], [130, 30, 220, 50], [40, 62, 220, 80]]);
  const text = { x0: 40, y0: 30, x1: 220, y1: 50 };
  const white = [255, 255, 255];
  // Too loose, too tight, and shifted: all settle on the same rectangle.
  for (const start of [
    { x0: 30, y0: 22, x1: 232, y1: 58 },
    { x0: 46, y0: 34, x1: 214, y1: 47 },
    { x0: 36, y0: 27, x1: 215, y1: 55 },
  ]) {
    assert.deepEqual(snapRectToInk(frame, start, white), text);
  }
  // It grows back over a glyph the detector cut into, but not across a gap.
  assert.deepEqual(snapRectToInk(frame, { x0: 134, y0: 34, x1: 216, y1: 47 }, white), {
    x0: 130,
    y0: 30,
    x1: 220,
    y1: 50,
  });
  assert.equal(snapRectToInk(frame, { x0: 230, y0: 5, x1: 290, y1: 25 }, white), null);
});

test("quad bounds are whole pixels inside the frame", () => {
  assert.deepEqual(quadBounds([[-3.2, 4.6], [50.4, 5.1], [50.2, 20.7], [-3, 20.2]], 40, 30), {
    x0: 0,
    y0: 4,
    x1: 40,
    y1: 21,
  });
});
