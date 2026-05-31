const videoEl = document.querySelector("video");
const canvasEl = document.querySelector("canvas.draw");
const translateOverlay = document.getElementById("translate-overlay");
const shareBtn = document.getElementById("share-btn");

let isPlaying = false;

// Position the canvas + overlay as a single letterboxed box centered in the
// window, preserving the feed's aspect ratio.
function layoutDisplay(cssW, cssH) {
  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const scale = Math.min(winW / cssW, winH / cssH);
  const dispW = Math.round(cssW * scale);
  const dispH = Math.round(cssH * scale);
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

shareBtn.addEventListener(
  "click",
  function () {
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
      .then((stream) => {
        videoEl.srcObject = stream;
        videoEl.play();

        // Boot the OCR + translation engine.
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
          if (videoEl.videoWidth === 0 || videoEl.readyState < 2) return;

          // Chrome captures at native resolution (dpr×), Safari at 1×.
          const dpr =
            videoEl.videoWidth / screen.width || window.devicePixelRatio;

          if (
            canvasEl.width !== videoEl.videoWidth ||
            canvasEl.height !== videoEl.videoHeight
          ) {
            canvasEl.width = videoEl.videoWidth;
            canvasEl.height = videoEl.videoHeight;
          }

          ctx.drawImage(videoEl, 0, 0);

          // Letterbox-fit the feed into the window and align the overlay.
          ({ dispW, dispH } = layoutDisplay(
            videoEl.videoWidth / dpr,
            videoEl.videoHeight / dpr,
          ));
        }

        if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
          function onVideoFrame() {
            drawFrame();
            videoEl.requestVideoFrameCallback(onVideoFrame);
          }
          videoEl.requestVideoFrameCallback(onVideoFrame);
        } else {
          function rafDraw() {
            drawFrame();
            requestAnimationFrame(rafDraw);
          }
          requestAnimationFrame(rafDraw);
        }

        // --- OCR loop: scan + overlay on its own cadence, off the draw path ---
        function ocrLoop() {
          if (canvasEl.width > 0 && dispW > 0) {
            renderTranslateFrame(canvasEl, dispW, dispH);
          }
          requestAnimationFrame(ocrLoop);
        }
        requestAnimationFrame(ocrLoop);
      })
      .catch((err) => {
        console.error("getDisplayMedia failed:", err);
        isPlaying = false;
      });
  },
  false,
);
