import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("single-line translations grow without wrapping and retain their alignment", async ({ page }) => {
  // Exercise the session renderer with deterministic OCR results and real browser layout.
  for (const file of ["ocr.js", "performance-core.js"]) {
    const body = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    await page.route(`**/${file}`, (route) => route.fulfill({ contentType: "text/javascript", body }));
  }
  await page.goto("/");
  await page.evaluate(async () => {
    const { TranslationSession } = await import("/ocr.js");
    const overlay = document.getElementById("translate-overlay");
    overlay.style.width = "1000px";
    overlay.style.height = "600px";
    const session = new TranslationSession({ video: document.querySelector("video"), overlay });
    window.layoutSession = session;
    session.resultWidth = 1000;
    session.resultHeight = 600;
    session.results = [
      { id: "left", text: "Kurz", lineCount: 1, box: [[50, 50], [150, 50], [150, 80], [50, 80]] },
      { id: "center", text: "Titel", lineCount: 1, box: [[450, 150], [550, 150], [550, 180], [450, 180]] },
      { id: "paragraph", text: "Absatz", lineCount: 2, box: [[50, 250], [200, 250], [200, 310], [50, 310]] },
    ];
    for (const item of session.results) {
      session.translationCache.set(`de>en:${item.text}`, "This translation is much longer than its original source text");
    }
    session.setDisplaySize(1000, 600);
  });
  const boxes = page.locator(".translate-box");
  await expect(boxes).toHaveCount(3);
  const geometry = await boxes.evaluateAll((nodes) => nodes.map((node) => {
    const rect = node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    return { left: rect.left, width: rect.width, lines: range.getClientRects().length, whitespace: getComputedStyle(node).whiteSpace };
  }));
  expect(geometry[0].width).toBeGreaterThan(108);
  expect(geometry[0].left).toBeCloseTo(46, 0);
  expect(geometry[0].lines).toBe(1);
  expect(geometry[1].left + geometry[1].width / 2).toBeCloseTo(500, 0);
  expect(geometry[1].lines).toBe(1);
  expect(geometry[2].width).toBeCloseTo(158, 0);
  expect(geometry[2].lines).toBeGreaterThan(1);

  await page.evaluate(() => {
    window.originalOverlayNode = window.layoutSession.nodeMap.get("left:de>en");
    window.layoutSession.results[0].lineCount = 2;
    window.layoutSession.setDisplaySize(1000, 601);
  });
  await expect(boxes.first()).not.toHaveClass(/is-single-line/);
  expect(await boxes.first().evaluate((node) => ({
    reused: node === window.originalOverlayNode,
    width: node.getBoundingClientRect().width,
    minWidth: node.style.minWidth,
  }))).toEqual({ reused: true, width: 108, minWidth: "" });
});
