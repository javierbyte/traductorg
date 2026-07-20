const videoEl = document.querySelector("video");
const canvasEl = document.querySelector("canvas.draw");
const translateOverlay = document.getElementById("translate-overlay");
const shareBtn = document.getElementById("share-btn");

let isPlaying = false;
let drawFrameHandle = 0;
let ocrRafId = 0;

// Position the canvas + overlay as a single letterboxed box centered in the
// window, preserving the feed's aspect ratio.
function layoutDisplay(srcW, srcH) {
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const scale = Math.min(winW / srcW, winH / srcH);
  const dispW = Math.round(srcW * scale);
  const dispH = Math.round(srcH * scale);
  const left = Math.round((winW - dispW) / 2);
  const top = Math.round((winH - dispH) / 2);

  for (const el of [canvasEl, translateOverlay]) {
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.style.width = dispW + "px";
    el.style.height = dispH + "px";
  }

  return { dispW, dispH };
}

function stopSession() {
  if (!isPlaying) return;
  isPlaying = false;

  if (drawFrameHandle && videoEl.cancelVideoFrameCallback) {
    videoEl.cancelVideoFrameCallback(drawFrameHandle);
  }
  cancelAnimationFrame(ocrRafId);
  drawFrameHandle = 0;
  ocrRafId = 0;

  if (videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach((t) => t.stop());
    videoEl.srcObject = null;
  }
  // Drop the stale frame so it doesn't flash on the next share.
  canvasEl.width = 0;
  canvasEl.height = 0;

  resetTranslateFilter();
  document.getElementById("intro").style.display = "";
}

function startSession(stream) {
  videoEl.srcObject = stream;
  videoEl.play();

  stream
    .getVideoTracks()[0]
    .addEventListener("ended", stopSession, { once: true });

  // Boot (or reuse) the OCR + translation engine.
  initTranslateFilter(translateOverlay);
  showTranslateFilter();

  const ctx = canvasEl.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  // Latest displayed-canvas size, written by the draw loop and read by the
  // OCR loop so the two run independently.
  let dispW = 0;
  let dispH = 0;

  // --- Draw loop: paint the feed as fast as it is delivered ---
  function drawFrame() {
    if (!isPlaying) return;
    if (videoEl.videoWidth === 0 || videoEl.readyState < 2) return;

    if (
      canvasEl.width !== videoEl.videoWidth ||
      canvasEl.height !== videoEl.videoHeight
    ) {
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
    }

    ctx.drawImage(videoEl, 0, 0);

    // Letterbox-fit the feed into the window and align the overlay.
    ({ dispW, dispH } = layoutDisplay(videoEl.videoWidth, videoEl.videoHeight));
  }

  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    function onVideoFrame() {
      drawFrame();
      if (isPlaying) drawFrameHandle = videoEl.requestVideoFrameCallback(onVideoFrame);
    }
    drawFrameHandle = videoEl.requestVideoFrameCallback(onVideoFrame);
  } else {
    function rafDraw() {
      drawFrame();
      if (isPlaying) drawFrameHandle = requestAnimationFrame(rafDraw);
    }
    drawFrameHandle = requestAnimationFrame(rafDraw);
  }

  // --- OCR loop: scan + overlay on its own cadence, off the draw path ---
  function ocrLoop() {
    if (!isPlaying) return;
    if (canvasEl.width > 0 && dispW > 0) {
      renderTranslateFrame(canvasEl, dispW, dispH);
    }
    ocrRafId = requestAnimationFrame(ocrLoop);
  }
  ocrRafId = requestAnimationFrame(ocrLoop);
}

shareBtn.addEventListener("click", function () {
  if (isPlaying) return;
  isPlaying = true;
  document.getElementById("intro").style.display = "none";

  navigator.mediaDevices
    .getDisplayMedia({
      video: {
        width: { ideal: screen.width * window.devicePixelRatio },
        height: { ideal: screen.height * window.devicePixelRatio },
        frameRate: { ideal: 60 },
      },
      audio: false,
    })
    .then(startSession)
    .catch((err) => {
      console.error("getDisplayMedia failed:", err);
      isPlaying = false;
      document.getElementById("intro").style.display = "";
    });
});
