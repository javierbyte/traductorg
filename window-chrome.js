// traduct.org — live local OCR and translation overlay
// Copyright (C) 2026 Javier Bórquez
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License, version 3, as published
// by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the LICENSE file distributed with this source.

// Finds where a shared browser window's own interface ends and the page
// begins, so the tab strip and toolbar can be cut off before anything looks
// at the frame.
//
// A browser draws its toolbar as a band across the whole window, and the
// page starts at the first straight line that runs from one side to the
// other. Lines higher up do not: the edge between the tab strip and the
// toolbar is interrupted by the selected tab, which joins the toolbar. This
// holds for Chrome (with or without the bookmarks bar) and for Safari's
// compact and separate tab layouts on macOS. When the toolbar has no sharp
// lower edge, nothing is found and the caller keeps its fixed margin.

export const WINDOW_CHROME_DEFAULTS = Object.freeze({
  // Columns the top of the frame is reduced to before it is examined.
  columns: 512,
  // The interface is searched for in this share of the frame's height…
  maxHeightRatio: 0.3,
  // …and at most this many frame pixels: Chrome with its bookmarks bar on a
  // 2x display is 240. Looking further down risks taking a line across the
  // page for the toolbar's edge.
  maxRows: 300,
  // Nothing above this row is a toolbar's lower edge.
  minRow: 24,
  // Summed RGB change between two rows that counts as an edge.
  edgeDistance: 9,
  // Share of the width an edge must span.
  coverage: 0.99,
  // A separator line has an edge on each side; both belong to the toolbar.
  separatorRows: 4,
});

// Rows of the frame to examine, for a frame of the given height.
export function windowChromeSearchRows(frameHeight, options = {}) {
  const config = { ...WINDOW_CHROME_DEFAULTS, ...options };
  return Math.max(0, Math.min(config.maxRows, Math.floor(frameHeight * config.maxHeightRatio)));
}

function isFullWidthEdge(data, width, row, config) {
  const above = (row - 1) * width * 4;
  const below = row * width * 4;
  const allowed = Math.floor(width * (1 - config.coverage));
  let unchanged = 0;
  for (let x = 0; x < width; x++) {
    const a = above + x * 4;
    const b = below + x * 4;
    const distance =
      Math.abs(data[a] - data[b]) +
      Math.abs(data[a + 1] - data[b + 1]) +
      Math.abs(data[a + 2] - data[b + 2]);
    if (distance < config.edgeDistance && ++unchanged > allowed) return false;
  }
  return true;
}

// `strip` is the top of the frame as ImageData: every row of it, at any
// width. Returns the first row of the page, or 0 when no toolbar is found.
export function detectWindowChromeHeight(strip, options = {}) {
  const config = { ...WINDOW_CHROME_DEFAULTS, ...options };
  const { data, width, height } = strip;
  for (let row = Math.max(1, config.minRow); row < height; row++) {
    if (!isFullWidthEdge(data, width, row, config)) continue;
    let pageStart = row;
    for (let next = row + 1; next < Math.min(height, pageStart + 1 + config.separatorRows); next++) {
      if (isFullWidthEdge(data, width, next, config)) pageStart = next;
    }
    return pageStart;
  }
  return 0;
}

// Follows the detected height over time. The first reading is used at once;
// after that a different reading must repeat before it replaces the current
// one, so a frame caught mid-change does not move the cut.
export class WindowChromeTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.height = 0;
    this.candidate = -1;
    this.readings = 0;
  }

  // Returns true when the height to use has changed.
  update(reading) {
    this.readings++;
    if (this.readings === 1 || reading === this.height) {
      const changed = reading !== this.height;
      this.height = reading;
      this.candidate = -1;
      return changed;
    }
    if (reading !== this.candidate) {
      this.candidate = reading;
      return false;
    }
    this.height = reading;
    this.candidate = -1;
    return true;
  }
}
