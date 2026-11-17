import { expect, test } from "@playwright/test";

test("a shared browser window is read below its toolbar", async ({ page }) => {
  await page.addInitScript(() => {
    window.Translator = {
      availability: async () => "available",
      create: async () => ({ translate: async (text) => `EN ${text}`, destroy() {} }),
    };
    navigator.mediaDevices.getDisplayMedia = async () => {
      // A dark Chrome window: tab strip, toolbar with an address, then a page.
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 1000;
      const context = canvas.getContext("2d");
      const draw = () => {
        context.fillStyle = "#1f1f1f";
        context.fillRect(0, 0, 1600, 82);
        context.fillStyle = "#3c3c3c";
        context.fillRect(120, 16, 260, 66);
        context.fillRect(0, 82, 1600, 92);
        context.fillStyle = "#e8e8e8";
        context.font = "40px sans-serif";
        context.fillText("beispiel.de/nachrichten", 220, 142);
        context.fillStyle = "#ffffff";
        context.fillRect(0, 174, 1600, 826);
        context.fillStyle = "#111111";
        context.fillText("Guten Morgen, wie geht es dir heute?", 200, 420);
      };
      draw();
      setInterval(draw, 100);
      const stream = canvas.captureStream(30);
      const [track] = stream.getVideoTracks();
      const getSettings = track.getSettings.bind(track);
      track.getSettings = () => ({ ...getSettings(), displaySurface: "window" });
      return stream;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Share a window to translate" }).click();

  const boxes = page.locator(".translate-box");
  await expect(boxes.first()).toBeVisible({ timeout: 60_000 });
  await expect(boxes).toHaveCount(1);
  await expect(boxes).toContainText("EN Guten Morgen, wie geht es dir heute?");

  // The toolbar is not shown: the overlay, which frames the visible video,
  // starts 174 frame rows down, and the video is clipped above it.
  const layout = await page.evaluate(() => {
    const video = document.querySelector("video");
    const frame = video.getBoundingClientRect();
    const overlay = document.getElementById("translate-overlay").getBoundingClientRect();
    return {
      cut: ((overlay.top - frame.top) / frame.height) * 1000,
      clip: getComputedStyle(video).clipPath,
      bottom: overlay.bottom - frame.bottom,
      fits: overlay.top >= 0 && overlay.bottom <= window.innerHeight,
    };
  });
  expect(layout.cut).toBeGreaterThan(172);
  expect(layout.cut).toBeLessThan(176);
  expect(layout.clip).toMatch(/^inset\(/);
  expect(Math.abs(layout.bottom)).toBeLessThan(1);
  expect(layout.fits).toBe(true);

  // The translation sits on the sentence it covers.
  const position = await page.evaluate(() => {
    const video = document.querySelector("video").getBoundingClientRect();
    const box = document.querySelector(".translate-box").getBoundingClientRect();
    return {
      top: ((box.top - video.top) / video.height) * 1000,
      bottom: ((box.bottom - video.top) / video.height) * 1000,
      left: ((box.left - video.left) / video.width) * 1600,
    };
  });
  expect(position.top).toBeGreaterThan(360);
  expect(position.top).toBeLessThan(400);
  expect(position.bottom).toBeGreaterThan(420);
  expect(position.bottom).toBeLessThan(450);
  expect(position.left).toBeGreaterThan(180);
  expect(position.left).toBeLessThan(205);
});
