import assert from "node:assert/strict";
import test from "node:test";

import {
  WindowChromeTracker,
  detectWindowChromeHeight,
  windowChromeSearchRows,
} from "../window-chrome.js";

const WIDTH = 512;

// The top of a window, painted as bands of [fromRow, toRow, gray, fromColumn?,
// toColumn?]; later bands paint over earlier ones.
function strip(height, bands) {
  const data = new Uint8ClampedArray(WIDTH * height * 4).fill(255);
  for (const [from, to, gray, left = 0, right = WIDTH] of bands) {
    for (let y = from; y < to; y++) {
      data.fill(gray, (y * WIDTH + left) * 4, (y * WIDTH + right) * 4);
    }
  }
  return { data, width: WIDTH, height };
}

test("Chrome: the page starts below the toolbar, not below the tab strip", () => {
  const dark = strip(300, [
    [0, 82, 31], // tab strip
    [16, 82, 60, 110, 240], // the selected tab joins the toolbar
    [82, 174, 60], // toolbar
    [174, 300, 33], // page
    [100, 150, 40, 120, 420], // address field
    [200, 280, 200, 150, 360], // page content
  ]);
  assert.equal(detectWindowChromeHeight(dark), 174);

  // Light theme, white page: only the separator line marks the edge. A
  // bookmarks bar is part of the same band.
  const light = strip(300, [
    [0, 82, 222],
    [16, 82, 255, 110, 240],
    [82, 238, 255],
    [238, 240, 224], // separator
    [240, 300, 255],
  ]);
  assert.equal(detectWindowChromeHeight(light), 240);
});

test("Safari: the page starts below the unified toolbar", () => {
  const safari = strip(300, [
    [0, 104, 44],
    [30, 80, 58, 200, 320], // address field
    [104, 300, 33],
  ]);
  assert.equal(detectWindowChromeHeight(safari), 104);
});

test("a window without a clear toolbar edge is left whole", () => {
  assert.equal(detectWindowChromeHeight(strip(300, [[0, 300, 33]])), 0);
  // An edge that stops short of the sides is page content.
  assert.equal(detectWindowChromeHeight(strip(300, [[0, 300, 33], [120, 300, 200, 40, 472]])), 0);
  // Nothing this close to the top is a toolbar.
  assert.equal(detectWindowChromeHeight(strip(300, [[0, 10, 60], [10, 300, 33]])), 0);
});

test("only the top of the frame is searched", () => {
  assert.equal(windowChromeSearchRows(600), 180);
  assert.equal(windowChromeSearchRows(2234), 300);
  assert.equal(windowChromeSearchRows(0), 0);
});

test("the cut follows the toolbar once a new height is confirmed", () => {
  const tracker = new WindowChromeTracker();
  assert.equal(tracker.update(174), true);
  assert.equal(tracker.height, 174);
  assert.equal(tracker.update(174), false);
  // One odd frame does not move it; the same reading twice does.
  assert.equal(tracker.update(0), false);
  assert.equal(tracker.update(174), false);
  assert.equal(tracker.update(240), false);
  assert.equal(tracker.update(240), true);
  assert.equal(tracker.height, 240);
  tracker.reset();
  assert.equal(tracker.update(0), false);
  assert.equal(tracker.height, 0);
});
