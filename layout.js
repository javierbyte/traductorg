// traduct.org — live local OCR and translation overlay
// Copyright (C) 2026 Javier Bórquez
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License, version 3, as published
// by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the LICENSE file distributed with this source.

// Groups recognized lines into the paragraphs that get translated.
//
// A translator needs whole sentences, so a paragraph must not be cut where
// its lines merely wrap; and the overlay needs one box per block of text, so
// neighbors (list items, table cells, a heading and its body) must stay
// apart. This is written for web pages: upright text, in columns, with line
// boxes that sit tight on the glyphs (see ocr-engine.js).
//
// Lengths are compared in ems. A line's font size is estimated from the
// height of its box and from which of its characters rise above the x-height
// or hang below the baseline, so "nun aus." and "Tag für Tag" in the same
// font measure the same.

const X_HEIGHT = 0.52;
const ASCENT = 0.21;
const ACCENTED_ASCENT = 0.33;
const DESCENT = 0.22;
const CJK_HEIGHT = 0.92;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_PUNCTUATION = /[。，！？；：“”‘’《》、【】（）…—]/;
const ASCENDER = /[\p{Lu}\p{Nd}bdfhklßt()[\]{}/|!?%&$€£#@"'„“”«»]/u;
const ACCENTED_CAPITAL = /[ÀÁÂÃÄÅÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝ]/;
const DESCENDER = /[gjpqyQçş,;()[\]{}/|„]/;

const BULLET = /^[•◦▪■●○‣·]\s?/u;
const ORDINAL = /^(?:\d{1,2}|\p{L})[.)]\s/u;
const DASH = /^[–—-]\s/;
const SENTENCE_END = /[.!?:;…»“”"’)\]]$/;
const LOWERCASE_START = /^\p{Ll}/u;
// After a hyphen at the end of a line, these continue a suspended compound
// ("Nord- und Südamerika") rather than the hyphenated word.
const SUSPENDED_HYPHEN = /^(?:und|oder|bzw|sowie|bis|en|of|and|or|et|ou|y|o|e)\b/i;

const LIMITS = Object.freeze({
  // Fragments on one row closer than this are one line.
  rowGap: 1,
  // Lines of one paragraph have about the same font size…
  sizeRatio: 0.78,
  // …sit at most this far apart before their line spacing is known…
  firstPitch: 2,
  // …and then keep that spacing.
  pitchDrift: 0.3,
  // Their starts (or centers) line up.
  alignment: 0.6,
  // A list item's later lines start to the right of its marker.
  markerIndent: 4,
  // Room left at the end of a line beyond the next word that marks a break.
  breakSlack: 0.75,
  // Lines of one paragraph share a background.
  backgroundDistance: 48,
});

// Fixes misreadings that the recognizer makes consistently and that derail
// translation: characters missing from its dictionary, and digits set in
// old-style numerals.
export function cleanRecognizedText(text) {
  return (
    String(text || "")
      // „ is not in the dictionary and comes back as commas and periods.
      .replace(/(?<![\p{L}\d])(?=[.,]*,)[.,]{2,3}\s?(?=\p{L})/gu, "„")
      .replace(/(?<=^|\s),(?=\p{L}[^„]*[“”])/gu, "„")
      .replace(/['’]{2,}/g, "’")
      .replace(/℃/g, "°C")
      // Old-style zeros look like the letter o.
      .replace(/(?<![\p{L}\d])(\d+[.,]\d*|\d{2,})[oO]+(?![\p{L}\d])/gu, (match) =>
        match.replace(/[oO]/g, "0"),
      )
      .replace(/(?<=\d)[oO](?=\d)/g, "0")
  );
}

function bounds(box) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const [x, y] of box) {
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return { left, top, right, bottom };
}

function colorDistance(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// Position and font metrics of one recognized line.
export function measureLine(line) {
  const text = cleanRecognizedText(line.text).trim();
  const { left, top, right, bottom } = bounds(line.box);
  const height = Math.max(1, bottom - top);
  const cjk = CJK.test(text);
  const hanging = DESCENDER.test(text);
  const share = cjk
    ? CJK_HEIGHT
    : X_HEIGHT +
      (ACCENTED_CAPITAL.test(text) ? ACCENTED_ASCENT : ASCENDER.test(text) ? ASCENT : 0) +
      (hanging ? DESCENT : 0);
  const em = height / share;
  return {
    text,
    left,
    top,
    right,
    bottom,
    em,
    baseline: bottom - (cjk ? 0.06 * em : hanging ? DESCENT * em : 0),
    mean: line.mean,
    style: line.style,
    weight: Math.max(1, text.length),
  };
}

function joinsWithoutSpace(before, after) {
  const last = before.at(-1) || "";
  const first = after.at(0) || "";
  return (CJK.test(last) || CJK_PUNCTUATION.test(last)) && (CJK.test(first) || CJK_PUNCTUATION.test(first));
}

function joinText(before, after, wrapped) {
  if (!before) return after;
  if (!after) return before;
  if (joinsWithoutSpace(before, after)) return before + after;
  // A word broken at a hyphen is one word again.
  if (wrapped && /\p{L}-$/u.test(before) && !SUSPENDED_HYPHEN.test(after)) return before + after;
  return `${before} ${after}`;
}

// The detector sometimes splits one line at a wide gap. Fragments that share
// a row, a background and a font size, and sit close together, are one line.
function mergeRows(lines) {
  const sorted = [...lines].sort((a, b) => a.top - b.top || a.left - b.left);
  const rows = [];
  for (const line of sorted) {
    const row = rows.findLast((candidate) => {
      const overlap = Math.min(candidate.bottom, line.bottom) - Math.max(candidate.top, line.top);
      return overlap >= 0.5 * Math.min(candidate.bottom - candidate.top, line.bottom - line.top);
    });
    if (row) {
      row.lines.push(line);
      row.top = Math.min(row.top, line.top);
      row.bottom = Math.max(row.bottom, line.bottom);
    } else {
      rows.push({ top: line.top, bottom: line.bottom, lines: [line] });
    }
  }

  const merged = [];
  for (const row of rows) {
    row.lines.sort((a, b) => a.left - b.left);
    let current = row.lines[0];
    for (const next of row.lines.slice(1)) {
      const em = Math.max(current.em, next.em);
      const gap = next.left - current.right;
      if (
        gap < LIMITS.rowGap * em &&
        Math.min(current.em, next.em) / em >= LIMITS.sizeRatio &&
        colorDistance(current.style?.bg, next.style?.bg) <= LIMITS.backgroundDistance
      ) {
        const weight = current.weight + next.weight;
        current = {
          ...current,
          text: joinText(current.text, next.text, false),
          right: Math.max(current.right, next.right),
          top: Math.min(current.top, next.top),
          bottom: Math.max(current.bottom, next.bottom),
          baseline: Math.max(current.baseline, next.baseline),
          em,
          mean: (current.mean * current.weight + next.mean * next.weight) / weight,
          weight,
        };
      } else {
        merged.push(current);
        current = next;
      }
    }
    merged.push(current);
  }
  return merged.sort((a, b) => a.top - b.top || a.left - b.left);
}

function markerKind(text) {
  if (BULLET.test(text)) return "bullet";
  if (ORDINAL.test(text)) return "ordinal";
  if (DASH.test(text)) return "dash";
  return "";
}

// Whether `line` is the next line of `paragraph`, as opposed to the start of
// another block below it.
function continues(paragraph, line) {
  const previous = paragraph.lines.at(-1);
  const first = paragraph.lines[0];
  const em = (paragraph.em + line.em) / 2;

  if (Math.min(paragraph.em, line.em) / Math.max(paragraph.em, line.em) < LIMITS.sizeRatio) {
    return false;
  }
  if (Math.min(previous.right, line.right) <= Math.max(previous.left, line.left)) return false;
  if (colorDistance(first.style?.bg, line.style?.bg) > LIMITS.backgroundDistance) return false;

  const pitch = line.baseline - previous.baseline;
  if (pitch < 0.6 * em) return false;
  if (paragraph.pitch) {
    if (Math.abs(pitch - paragraph.pitch) > LIMITS.pitchDrift * em) return false;
  } else if (pitch > LIMITS.firstPitch * em) {
    return false;
  }

  // A new list item starts its own paragraph.
  const marker = markerKind(line.text);
  if (marker === "bullet") return false;
  if (
    marker &&
    marker === paragraph.marker &&
    Math.abs(line.left - first.left) <= LIMITS.alignment * em
  ) {
    return false;
  }

  const leftOffset = line.left - paragraph.left;
  const startsAligned = Math.abs(leftOffset) <= LIMITS.alignment * em;
  const hangsUnderMarker =
    paragraph.lines.length === 1 &&
    paragraph.marker &&
    leftOffset > 0 &&
    leftOffset <= LIMITS.markerIndent * em;
  const centered =
    paragraph.align !== "start" &&
    Math.abs((line.left + line.right) / 2 - (previous.left + previous.right) / 2) <=
      LIMITS.alignment * em;
  if (!startsAligned && !hangsUnderMarker && !centered) return false;
  if (!startsAligned && !hangsUnderMarker) return true;

  // Text wraps only when the next word does not fit. If the previous line
  // left room for this line's first word, it ended on purpose.
  const columnRight =
    paragraph.lines.length > 1 ? paragraph.right : Math.max(previous.right, line.right);
  const room = columnRight - previous.right;
  const firstWord = CJK.test(line.text.at(0) || "") ? 1 : line.text.split(" ")[0].length + 1;
  const needed = (firstWord / Math.max(1, line.text.length)) * (line.right - line.left);
  if (room > needed + LIMITS.breakSlack * em) {
    // Unless the sentence visibly runs on; the estimate is not exact.
    return !SENTENCE_END.test(previous.text) && LOWERCASE_START.test(line.text);
  }
  return true;
}

function addLine(paragraph, line) {
  const previous = paragraph.lines.at(-1);
  const pitch = line.baseline - previous.baseline;
  const startsAligned = Math.abs(line.left - paragraph.left) <= LIMITS.alignment * paragraph.em;
  if (paragraph.lines.length === 1) {
    paragraph.align = startsAligned ? "start" : paragraph.marker ? "start" : "center";
    // Later lines of a list item line up with each other, not its marker.
    if (paragraph.marker && !startsAligned) paragraph.left = line.left;
  }
  paragraph.pitch = paragraph.pitch
    ? (paragraph.pitch * (paragraph.lines.length - 1) + pitch) / paragraph.lines.length
    : pitch;
  paragraph.em = (paragraph.em * paragraph.lines.length + line.em) / (paragraph.lines.length + 1);
  paragraph.right = Math.max(paragraph.right, line.right);
  paragraph.lines.push(line);
}

function toItem(paragraph) {
  const { lines } = paragraph;
  let text = "";
  let weight = 0;
  let mean = 0;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const line of lines) {
    text = joinText(text, line.text, true);
    weight += line.weight;
    mean += line.mean * line.weight;
    left = Math.min(left, line.left);
    top = Math.min(top, line.top);
    right = Math.max(right, line.right);
    bottom = Math.max(bottom, line.bottom);
  }
  return {
    text,
    mean: mean / weight,
    box: [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ],
    style: lines[0].style,
    lineCount: lines.length,
    fontSize: paragraph.em,
  };
}

// Recognized lines ({ text, mean, box, style }) in, paragraphs out: each with
// its joined text, bounding box, line count and estimated font size, in
// reading order.
export function groupLines(lines) {
  const measured = (lines || []).map(measureLine).filter((line) => line.text);
  const paragraphs = [];
  for (const line of mergeRows(measured)) {
    const paragraph = paragraphs.findLast((candidate) => continues(candidate, line));
    if (paragraph) {
      addLine(paragraph, line);
    } else {
      paragraphs.push({
        lines: [line],
        em: line.em,
        pitch: 0,
        left: line.left,
        right: line.right,
        align: "",
        marker: markerKind(line.text),
      });
    }
  }
  return paragraphs.map(toItem);
}
