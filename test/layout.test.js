import assert from "node:assert/strict";
import test from "node:test";

import { cleanRecognizedText, groupLines, measureLine } from "../layout.js";

const WHITE = { bg: [255, 255, 255], text: [0, 0, 0] };

// A line of 16px text whose box sits tight on its glyphs, like the engine's.
// `baseline` is where the letters stand; `size` scales the font.
function line(text, left, baseline, { width, size = 16, style = WHITE } = {}) {
  const chinese = /\p{Script=Han}/u.test(text);
  const ascends = /[A-ZÄÖÜ0-9bdfhklt„“]/.test(text);
  const descends = /[gjpqy,;]/.test(text);
  const top = baseline - size * (chinese ? 0.86 : 0.52 + (ascends ? 0.21 : 0));
  const bottom = baseline + size * (chinese ? 0.06 : descends ? 0.22 : 0);
  const right = left + (width ?? text.length * size * 0.5);
  return { text, mean: 0.95, style, box: [[left, top], [right, top], [right, bottom], [left, bottom]] };
}

const texts = (lines) => groupLines(lines).map((item) => item.text);

test("font size is estimated the same with or without tall letters", () => {
  const tall = measureLine(line("Tag für Tag", 0, 100));
  const flat = measureLine(line("nun aus", 0, 100));
  assert.ok(Math.abs(tall.em - 16) < 0.5);
  assert.ok(Math.abs(flat.em - 16) < 0.5);
  assert.ok(Math.abs(tall.baseline - flat.baseline) < 0.5);
});

test("wrapped lines form one paragraph and a paragraph gap separates two", () => {
  const items = groupLines([
    line("Als die Linie im Herbst eingestellt wurde, galt sie als", 40, 100, { width: 600 }),
    line("Relikt einer vergangenen Zeit. Die Gleise verschwanden", 40, 126, { width: 590 }),
    line("unter Asphalt.", 40, 152, { width: 150 }),
    line("Heute sieht die Stadtverwaltung das anders: Die Bahn", 40, 196, { width: 596 }),
    line("fährt wieder.", 40, 222, { width: 130 }),
  ]);
  assert.deepEqual(items.map((item) => [item.text, item.lineCount]), [
    [
      "Als die Linie im Herbst eingestellt wurde, galt sie als Relikt einer vergangenen Zeit. Die Gleise verschwanden unter Asphalt.",
      3,
    ],
    ["Heute sieht die Stadtverwaltung das anders: Die Bahn fährt wieder.", 2],
  ]);
  const top = 100 - 16 * 0.73;
  const bottom = 152 + 16 * 0.22;
  assert.deepEqual(items[0].box, [[40, top], [640, top], [640, bottom], [40, bottom]]);
  assert.ok(Math.abs(items[0].fontSize - 16) < 0.5);
});

test("a line that left room for the next word ended its paragraph", () => {
  // No extra gap between the paragraphs: only the short line tells.
  assert.deepEqual(
    texts([
      line("Die Bauarbeiten dauerten drei Jahre und kosteten viel", 40, 100, { width: 600 }),
      line("Geld. Das Land zahlte.", 40, 126, { width: 220 }),
      line("Kritiker bemängeln die hohen Kosten des Projekts sehr", 40, 152, { width: 598 }),
    ]),
    [
      "Die Bauarbeiten dauerten drei Jahre und kosteten viel Geld. Das Land zahlte.",
      "Kritiker bemängeln die hohen Kosten des Projekts sehr",
    ],
  );
  // A ragged line in the middle of a sentence stays with its paragraph.
  assert.equal(
    texts([
      line("Anwohner freuen sich über kürzere Wege, doch einige", 40, 100, { width: 520 }),
      line("fürchten steigende Mieten in der ganzen Nachbarschaft.", 40, 126, { width: 600 }),
    ]).length,
    1,
  );
});

test("headings, list items and table cells stay separate", () => {
  assert.deepEqual(
    texts([
      line("Was sich ändert", 40, 100, { size: 24 }),
      line("Für die Menschen im Viertel ist die Fahrzeit wichtig.", 40, 136, { width: 500 }),
    ]),
    ["Was sich ändert", "Für die Menschen im Viertel ist die Fahrzeit wichtig."],
  );
  assert.deepEqual(
    texts([
      line("• Die Bahnen fahren alle sechs Minuten.", 40, 100),
      line("• Nachts verkehrt die Linie seltener.", 40, 128),
      line("1. Neue Radwege: Wo die Stadt als", 500, 100, { width: 250 }),
      line("Nächstes baut", 522, 124),
      line("2. Wochenmarkt zieht um", 500, 152),
    ]),
    [
      "• Die Bahnen fahren alle sechs Minuten.",
      "1. Neue Radwege: Wo die Stadt als Nächstes baut",
      "• Nachts verkehrt die Linie seltener.",
      "2. Wochenmarkt zieht um",
    ],
  );
  // Cells on one row are far apart; rows of a table are spaced like blocks.
  assert.deepEqual(
    texts([
      line("Kennzahl", 40, 100),
      line("Vorher", 300, 100),
      line("Fahrzeit", 40, 142),
      line("24 Minuten", 300, 142),
    ]),
    ["Kennzahl", "Vorher", "Fahrzeit", "24 Minuten"],
  );
});

test("a paragraph does not continue onto another background", () => {
  const dark = { bg: [20, 30, 50], text: [255, 255, 255] };
  assert.equal(
    texts([
      line("Die wichtigsten Nachrichten aus der", 40, 100, { width: 300 }),
      line("Region jeden Morgen", 40, 126, { style: dark }),
    ]).length,
    2,
  );
});

test("centered lines group by their middle", () => {
  assert.deepEqual(
    texts([
      line("This domain is for use in documentation", 100, 100, { width: 400 }),
      line("examples without needing permission.", 120, 126, { width: 360 }),
    ]),
    ["This domain is for use in documentation examples without needing permission."],
  );
});

test("fragments of one row are one line when they sit close together", () => {
  assert.deepEqual(
    texts([line("Fahrgäste", 40, 100, { width: 80 }), line("pro Tag", 128, 100, { width: 60 })]),
    ["Fahrgäste pro Tag"],
  );
});

test("lines join without a space in Chinese and across a hyphen", () => {
  assert.deepEqual(
    texts([
      line("四十多年后，有轨电车再次驶过港口街。居民对更短的", 40, 100, { width: 400 }),
      line("通勤时间感到高兴。", 40, 128, { width: 150 }),
    ]),
    ["四十多年后，有轨电车再次驶过港口街。居民对更短的通勤时间感到高兴。"],
  );
  assert.deepEqual(
    texts([
      line("Wer pendelte, nutzt die neuen Park-and-ride-", 40, 100, { width: 400 }),
      line("Plätze am Stadtrand.", 40, 126),
    ]),
    ["Wer pendelte, nutzt die neuen Park-and-ride-Plätze am Stadtrand."],
  );
  assert.deepEqual(
    texts([
      line("Die Strecke verbindet künftig Nord-", 40, 100, { width: 400 }),
      line("und Südstadt miteinander.", 40, 126),
    ]),
    ["Die Strecke verbindet künftig Nord- und Südstadt miteinander."],
  );
});

test("consistent misreadings are repaired before translation", () => {
  assert.equal(cleanRecognizedText(",, Wir haben lange gewartet“"), "„Wir haben lange gewartet“");
  assert.equal(cleanRecognizedText("verloren. ,Ob die kommt“, sagt er."), "verloren. „Ob die kommt“, sagt er.");
  assert.equal(cleanRecognizedText("rund 18.00o Fahrgäste für 2,9o €"), "rund 18.000 Fahrgäste für 2,90 €");
  assert.equal(cleanRecognizedText("bei 17℃"), "bei 17°C");
  assert.equal(cleanRecognizedText("l’'État"), "l’État");
  // Real text that only resembles those mistakes is left alone.
  assert.equal(cleanRecognizedText("GPT-4o, na ja... und so"), "GPT-4o, na ja... und so");
});
