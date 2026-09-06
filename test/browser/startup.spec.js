import { expect, test } from "@playwright/test";

for (const failure of [false, true]) {
  test(`startup ${failure ? "recovers from OCR failure" : "waits for OCR before showing video"}`, async ({ page }) => {
    await page.addInitScript(() => {
      window.Translator = {
        availability: async () => "available",
        create: async () => ({ translate: async (text) => text, destroy() {} }),
      };
      window.Worker = class extends EventTarget {
        constructor() { super(); window.ocrWorker = this; }
        postMessage(message) {
          if (message.type === "init") this.sessionId = message.sessionId;
        }
        terminate() {}
      };
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 100;
        const stream = canvas.captureStream(30);
        window.sharedStream = stream;
        window.drawTimer = setInterval(() => {
          canvas.getContext("2d").fillRect(0, 0, 100, 100);
        }, 30);
        return stream;
      };
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Share a window to translate" }).click();
    await expect(page.locator("#startup-status")).toBeVisible();
    await expect(page.locator("video")).toBeHidden();
    await expect(page.locator("#share-btn")).toBeDisabled();
    await page.evaluate((failure) => {
      window.ocrWorker.dispatchEvent(new MessageEvent("message", { data: {
        sessionId: window.ocrWorker.sessionId,
        type: failure ? "error" : "ready",
        stage: "init",
        error: "Download failed",
        policy: { pixelBudget: 1000000, averageMs: 100, cooldownMs: 100 },
      } }));
    }, failure);
    if (failure) {
      await expect(page.locator("video")).toBeHidden();
      await expect(page.locator("#startup-status")).toContainText("OCR could not load");
      await expect(page.locator("#share-btn")).toBeEnabled();
      expect(await page.evaluate(() => window.sharedStream.getTracks()[0].readyState)).toBe("ended");
    } else {
      await expect(page.locator("video")).toBeVisible();
      await expect(page.locator("#intro")).toBeHidden();
    }
  });
}
