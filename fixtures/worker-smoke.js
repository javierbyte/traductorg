const result = document.getElementById("result");
const worker = new Worker(new URL("../ocr-worker.js", import.meta.url), {
  type: "module",
});
const canvas = new OffscreenCanvas(1280, 720);
const context = canvas.getContext("2d");
context.fillStyle = "white";
context.fillRect(0, 0, canvas.width, canvas.height);
context.fillStyle = "black";
context.font = "52px sans-serif";
// One model reads both scripts, so the smoke test shows both at once.
context.fillText("Translation café performance test", 90, 180);
context.fillText("翻译性能测试", 90, 320);
let phase = "init";
const timeout = setTimeout(() => {
  result.textContent = `FAIL: worker ${phase} timed out`;
  document.documentElement.dataset.result = "fail";
  worker.terminate();
}, 60_000);

async function sendSample() {
  phase = "sample";
  const bitmap = await createImageBitmap(canvas, {
    resizeWidth: 64,
    resizeHeight: 200,
    resizeQuality: "pixelated",
  });
  worker.postMessage(
    {
      type: "sample",
      sessionId: 1,
      frameId: 1,
      displayHeight: 720,
      bitmap,
    },
    [bitmap],
  );
}

async function sendOcr() {
  phase = "ocr";
  result.textContent = "Running one full OCR pass…";
  const bitmap = await createImageBitmap(canvas);
  worker.postMessage(
    {
      type: "ocr",
      sessionId: 1,
      frameId: 2,
      displayWidth: 1280,
      displayHeight: 720,
      captureScrollBase: 0,
      bitmap,
    },
    [bitmap],
  );
}

worker.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "status") result.textContent = message.message;
  if (message.type === "ready") {
    result.textContent = `OCR ready with ${message.threads} thread(s)`;
    void sendSample();
  }
  if (message.type === "motion" && phase === "sample") void sendOcr();
  if (message.type === "ocr-result") {
    clearTimeout(timeout);
    const texts = message.items.map((item) => item.text);
    const passed =
      texts.some((text) => /performance test/i.test(text)) &&
      texts.some((text) => text.includes("性能测试"));
    result.textContent = `${passed ? "PASS" : "FAIL"}: full OCR path, ${message.counts.selected} readable region(s), ${Math.round(message.durationMs)} ms, read ${JSON.stringify(texts)}`;
    document.documentElement.dataset.result = passed ? "pass" : "fail";
    worker.terminate();
  }
  if (message.type === "error") {
    clearTimeout(timeout);
    result.textContent = `FAIL (${message.stage}): ${message.error.message}`;
    document.documentElement.dataset.result = "fail";
    worker.terminate();
  }
});
worker.addEventListener("error", (event) => {
  clearTimeout(timeout);
  result.textContent = `FAIL: ${event.message}`;
  document.documentElement.dataset.result = "fail";
});
worker.postMessage({ type: "init", sessionId: 1, frameId: 0 });
