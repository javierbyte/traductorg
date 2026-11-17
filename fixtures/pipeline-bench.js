// Page-side harness that drives the app's real OCR worker, one frame at a
// time, for scripts/bench-pipeline.mjs. Development only.
const result = document.getElementById("result");
let worker = null;
let sessionId = 0;
let frameId = 0;
let waiting = null;

function start() {
  worker?.terminate();
  sessionId++;
  frameId = 0;
  worker = new Worker(new URL("../ocr-worker.js", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "ready") resolve(message);
      else if (message.type === "error") (waiting?.reject || reject)(new Error(message.error.message));
      else if (message.type === "ocr-result") waiting?.resolve(message);
    });
    worker.addEventListener("error", (event) => reject(new Error(event.message)));
    setTimeout(() => reject(new Error("The OCR worker did not start")), 60_000);
    worker.postMessage({ type: "init", sessionId, frameId: 0 });
  });
}

// Screen capture is not pixel-exact: frames pass through a video format on
// the way. `noise` adds that much random error to every channel.
async function decode(base64, noise) {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  if (!noise) return bitmap;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      data[i + channel] += Math.round((Math.random() * 2 - 1) * noise);
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.transferToImageBitmap();
}

async function run(base64, displayWidth, displayHeight, noise = 0) {
  const bitmap = await decode(base64, noise);
  const message = await new Promise((resolve, reject) => {
    waiting = { resolve, reject };
    worker.postMessage(
      {
        type: "ocr",
        sessionId,
        frameId: ++frameId,
        displayWidth,
        displayHeight,
        captureScrollBase: 0,
        bitmap,
      },
      [bitmap],
    );
  });
  waiting = null;
  result.textContent = `${message.items.length} items in ${Math.round(message.durationMs)} ms`;
  return message;
}

window.pipeline = { start, run };
