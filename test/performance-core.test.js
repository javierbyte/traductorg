import test from "node:test";
import assert from "node:assert/strict";

import {
  AdaptiveOcrPolicy,
  LruCache,
  OverlayReplacementPolicy,
  SupersedingQueue,
  buildAdaptiveParagraphs,
  buildScrollFeatureMap,
  computeOverlayFontSize,
  computeOcrDimensions,
  displayPixelsToSampleRows,
  estimateVerticalShift,
  fingerprintImageData,
  isActiveGeneration,
  isFrameActive,
  meanPixelDiff,
  quadToDisplayRect,
  inferOverlayTextAlign,
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
  assert.equal(isFrameActive(Infinity), false);
  assert.equal(isFrameActive(1), false);
  assert.equal(isFrameActive(2), true);
});

function syntheticPage({ width = 32, height = 80, offset = 0, frame = 0, seed = 1 }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const documentY = y + offset;
      const textStroke =
        documentY % 9 < 2 && x > 5 && x < width - 2
          ? ((x * 17 + documentY * 13 + seed * 19) % 5 < 3 ? 35 : 225)
          : 238 - ((documentY * 7 + x * 3 + seed * 11) % 18);
      let value = textStroke;
      if (y < 7) value = (x * 23 + frame * 71) % 256;
      if (x < 5) value = (y * 29 + frame * 47) % 256;
      const index = (y * width + x) * 4;
      data.set([value, value, value, 255], index);
    }
  }
  return { data, width, height };
}

function scrollEstimate(previous, current, displayHeight = 800, options = {}) {
  const excludedRows = displayPixelsToSampleRows(
    80,
    current.height,
    displayHeight,
  );
  return estimateVerticalShift(
    buildScrollFeatureMap(previous, excludedRows),
    buildScrollFeatureMap(current, excludedRows),
    displayHeight,
    options,
  );
}

test("2D scroll matching tracks both directions despite fixed animated regions", () => {
  const first = syntheticPage({ offset: 10, frame: 0 });
  const second = syntheticPage({ offset: 14, frame: 1 });
  const third = syntheticPage({ offset: 11, frame: 2 });
  const downPage = scrollEstimate(first, second);
  const upPage = scrollEstimate(second, third);

  assert.equal(downPage.moved, true);
  assert.ok(downPage.dy < -35 && downPage.dy > -45);
  assert.equal(upPage.moved, true);
  assert.ok(upPage.dy > 25 && upPage.dy < 35);
});

test("2D scroll matching accumulates continuous movement and stops cleanly", () => {
  const frames = [0, 3, 7].map((offset, frame) =>
    syntheticPage({ offset, frame }),
  );
  const movement = [
    scrollEstimate(frames[0], frames[1]).dy,
    scrollEstimate(frames[1], frames[2]).dy,
  ];
  const stopped = scrollEstimate(
    frames[2],
    syntheticPage({ offset: 7, frame: 3 }),
  );

  assert.ok(Math.abs(movement[0] + movement[1] + 70) < 4);
  assert.equal(stopped.moved, false);
});

test("2D scroll matching rejects unrelated scenes and ambiguous repetition", () => {
  const noisePage = (seed) => {
    const width = 32;
    const height = 80;
    const data = new Uint8ClampedArray(width * height * 4);
    let state = seed;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const value = state >>> 24;
        data.set([value, value, value, 255], (y * width + x) * 4);
      }
    }
    return { data, width, height };
  };
  const sceneChange = scrollEstimate(
    noisePage(1),
    noisePage(99),
  );
  const repeated = (offset) => {
    const width = 24;
    const height = 80;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = (y + offset) % 4 < 2 ? 30 : 230;
        data.set([value, value, value, 255], (y * width + x) * 4);
      }
    }
    return { data, width, height };
  };
  const ambiguous = scrollEstimate(repeated(0), repeated(2));

  assert.equal(sceneChange.moved, false);
  assert.equal(ambiguous.moved, false);
});

test("top exclusion leaves one sample row for very short displays", () => {
  assert.equal(displayPixelsToSampleRows(80, 200, 40), 199);
  const features = buildScrollFeatureMap(
    { data: new Uint8ClampedArray(200 * 4), width: 1, height: 200 },
    199,
  );
  assert.equal(features.height, 1);
});

test("overlay replacement waits for renderable content and confirms empty views", () => {
  const policy = new OverlayReplacementPolicy(2);
  const active = { generation: 1, pair: "de>en", items: [{ text: "old" }] };
  const first = { generation: 1, pair: "de>en", items: [{ text: "new" }] };
  const second = { generation: 1, pair: "de>en", items: [{ text: "newer" }] };

  assert.equal(policy.submit(first), "hold");
  assert.equal(policy.markRenderable(first, 0), false);
  assert.equal(policy.submit(second), "hold");
  assert.equal(policy.markRenderable(first, 1), false);
  assert.equal(policy.markRenderable(second, 1), true);
  assert.deepEqual(active.items.map((item) => item.text), ["old"]);

  const third = { generation: 1, pair: "de>en", items: [{ text: "latest" }] };
  assert.equal(policy.submit(third), "hold");
  policy.finish(second);
  assert.equal(policy.isCurrent(third), true);

  assert.equal(
    policy.submit({ generation: 1, pair: "de>en", items: [] }),
    "hold",
  );
  assert.equal(
    policy.submit({ generation: 1, pair: "de>en", items: [] }),
    "clear",
  );
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
