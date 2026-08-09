import test from "node:test";
import assert from "node:assert/strict";

import {
  AdaptiveOcrPolicy,
  LruCache,
  SupersedingQueue,
  buildAdaptiveParagraphs,
  computeOverlayFontSize,
  computeOcrDimensions,
  displayPixelsToSampleRows,
  estimateVerticalShift,
  fingerprintImageData,
  isActiveGeneration,
  meanPixelDiff,
  quadToDisplayRect,
  inferOverlayTextAlign,
  rowLumaProfile,
  selectReadableBoxes,
} from "../performance-core.js";

test("OCR dimensions preserve aspect ratio and obey the pixel ceiling", () => {
  const size = computeOcrDimensions(3840, 2160, 1_500_000);
  assert.ok(size.pixels <= 1_505_000);
  assert.ok(Math.abs(size.width / size.height - 16 / 9) < 0.01);

  assert.deepEqual(computeOcrDimensions(640, 480, 1_500_000), {
    width: 640,
    height: 480,
    pixels: 307200,
  });
});

test("adaptive OCR policy changes only after a sustained signal", () => {
  const policy = new AdaptiveOcrPolicy({ adaptIntervalMs: 0, emaAlpha: 1 });
  policy.record(1400, 0);
  policy.record(1400, 1);
  assert.equal(policy.pixelBudget, 1_500_000);
  policy.record(1400, 2);
  assert.equal(policy.pixelBudget, 1_275_000);
  assert.equal(policy.cooldownMs(), 2100);

  policy.record(400, 3);
  policy.record(400, 4);
  policy.record(400, 5);
  assert.equal(policy.pixelBudget, 1_466_250);
  assert.equal(policy.cooldownMs(), 750);
});

test("adaptive OCR changes are rate-limited and cooldowns stay bounded", () => {
  const policy = new AdaptiveOcrPolicy({ emaAlpha: 1 });
  policy.record(2000, 0);
  policy.record(2000, 1);
  policy.record(2000, 2);
  assert.equal(policy.pixelBudget, 1_275_000);
  assert.equal(policy.cooldownMs(), 3000);

  policy.record(2000, 3000);
  policy.record(2000, 4000);
  policy.record(2000, 5000);
  assert.equal(policy.pixelBudget, 1_275_000);
  policy.record(2000, 10_002);
  assert.equal(policy.pixelBudget, 1_083_750);

  const fast = new AdaptiveOcrPolicy({ emaAlpha: 1 });
  fast.record(100, 0);
  fast.record(100, 1);
  fast.record(100, 2);
  assert.equal(fast.cooldownMs(), 750);
});

test("LRU promotes reads and evicts the least recently used entry", () => {
  const cache = new LruCache(2);
  cache.set("a", 1).set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("a replacement translation queue drops the older job's remainder", () => {
  const queue = new SupersedingQueue();
  const oldJob = queue.replace(["old-a", "old-b"], { pair: "de>en" });
  assert.equal(queue.next().entry, "old-a");
  const newJob = queue.replace(["new-a"], { pair: "fr>en" });
  const next = queue.next();
  assert.equal(next.entry, "new-a");
  assert.equal(next.job, newJob);
  assert.notEqual(next.job, oldJob);
  assert.equal(queue.next(), null);
});

test("session generations reject stale asynchronous responses", () => {
  assert.equal(isActiveGeneration(4, 4), true);
  assert.equal(isActiveGeneration(undefined, 4), false);
  assert.equal(isActiveGeneration(3, 4), false);
});

test("paragraph grouping falls back to lines when backgrounds disagree", () => {
  const first = {
    text: "Hello",
    box: [[0, 0], [40, 0], [40, 10], [0, 10]],
    style: { bg: [255, 255, 255] },
  };
  const second = {
    text: "world",
    box: [[0, 12], [40, 12], [40, 22], [0, 22]],
    style: { bg: [250, 250, 250] },
  };
  const parse = { ...first, text: "Hello world" };
  const layout = { columns: [{ parragraphs: [{ src: [first, second], parse }] }] };
  assert.deepEqual(buildAdaptiveParagraphs([first, second], layout), [
    { ...parse, lineCount: 2 },
  ]);

  second.style.bg = [0, 0, 0];
  assert.equal(buildAdaptiveParagraphs([first, second], layout).length, 2);
});

test("readable-region selection keeps source order after applying its cap", () => {
  const boxes = [4, 12, 8].map((height, index) => ({
    id: index,
    box: [[0, 0], [20, 0], [20, height], [0, height]],
  }));
  assert.deepEqual(
    selectReadableBoxes(boxes, 100, 100, 6, 1).map((box) => box.id),
    [1],
  );
});

test("image fingerprints are stable and frame diff detects changes", () => {
  const a = { data: new Uint8ClampedArray(4 * 4 * 4).fill(10), width: 4, height: 4 };
  const b = { data: new Uint8ClampedArray(a.data), width: 4, height: 4 };
  assert.equal(fingerprintImageData(a), fingerprintImageData(b));
  assert.equal(meanPixelDiff(a.data, b.data), 0);
  b.data[0] = 250;
  assert.ok(meanPixelDiff(a.data, b.data) > 0);
});

test("vertical shift reports content movement in display pixels", () => {
  const previous = Float32Array.from([0, 0, 10, 20, 10, 0, 0, 0]);
  const current = Float32Array.from([10, 20, 10, 0, 0, 0, 0, 0]);
  const result = estimateVerticalShift(previous, current, 80, {
    maxShiftRows: 3,
    confidence: 0.1,
  });
  assert.equal(result.moved, true);
  assert.ok(result.dy < -15 && result.dy > -25);
});

test("scroll profiles ignore a changing fixed-height navigation region", () => {
  const image = (rows) => {
    const data = new Uint8ClampedArray(rows.length * 4);
    rows.forEach((value, index) => {
      data.set([value, value, value, 255], index * 4);
    });
    return { data, width: 1, height: rows.length };
  };
  const previous = image([0, 90, 0, 20, 80, 180, 80, 20, 0, 0]);
  const current = image([0, 245, 20, 80, 180, 80, 20, 0, 0, 0]);
  const unfiltered = estimateVerticalShift(
    rowLumaProfile(previous, 1),
    rowLumaProfile(current, 1),
    400,
    { maxShiftRows: 3, confidence: 0.1 },
  );
  const excludedRows = displayPixelsToSampleRows(80, 10, 400);
  const previousProfile = rowLumaProfile(previous, 1, excludedRows);
  const currentProfile = rowLumaProfile(current, 1, excludedRows);
  const trackedHeight = 400 * (currentProfile.length / current.height);
  const result = estimateVerticalShift(
    previousProfile,
    currentProfile,
    trackedHeight,
    { maxShiftRows: 3, confidence: 0.1 },
  );

  assert.equal(unfiltered.moved, false);
  assert.equal(excludedRows, 2);
  assert.equal(result.moved, true);
  assert.ok(result.dy < -35 && result.dy > -45);
});

test("top exclusion leaves one sample row for very short displays", () => {
  assert.equal(displayPixelsToSampleRows(80, 200, 40), 199);
  const profile = rowLumaProfile(
    { data: new Uint8ClampedArray(200 * 4), width: 1, height: 200 },
    1,
    199,
  );
  assert.equal(profile.length, 1);
});

test("overlay typography matches source scale within safe bounds", () => {
  assert.equal(computeOverlayFontSize(20, 1), 18);
  assert.equal(computeOverlayFontSize(40, 2), 18);
  assert.equal(computeOverlayFontSize(4, 1), 9);
  assert.equal(computeOverlayFontSize(200, 1), 96);
});

test("overlay alignment centers only obvious single-line text", () => {
  assert.equal(
    inferOverlayTextAlign({ left: 350, width: 300 }, 1, 1000),
    "center",
  );
  assert.equal(
    inferOverlayTextAlign({ left: 60, width: 300 }, 1, 1000),
    "left",
  );
  assert.equal(
    inferOverlayTextAlign({ left: 350, width: 300 }, 2, 1000),
    "left",
  );
  assert.equal(
    inferOverlayTextAlign({ left: 50, width: 900 }, 1, 1000),
    "left",
  );
});

test("quad mapping preserves position, size, and rotation", () => {
  const rect = quadToDisplayRect(
    [[10, 10], [30, 10], [30, 20], [10, 20]],
    100,
    50,
    200,
    100,
  );
  assert.deepEqual(
    { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    { left: 20, top: 20, width: 40, height: 20 },
  );
  assert.equal(rect.angle, 0);
});
