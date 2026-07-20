// OCR + translation engine (PaddleOCR via esearch-ocr + Chrome Translator API).
// Runs over the whole displayed frame and overlays translated text boxes.

let _trOverlay = null;
let _trBoxContainer = null;
let _trOcrInstance = null;
let _trReady = false;
let _trBusy = false;
let _trResults = null;
let _trResultsDirty = false;
let _trLastOcrTime = 0;
let _trFeedCanvas = null;
let _trFeedCtx = null;
let _trTranslator = null;
let _trCache = new Map();
let _trCacheVersion = 0;
let _trRenderedCacheVersion = 0;
let _trOcrW = 0;
let _trOcrH = 0;
let _trLastDispW = 0;
let _trLastDispH = 0;
let _trSession = 0;
let _trMeasureCtx = null;
let _trDiffCanvas = null;
let _trDiffCtx = null;
let _trPrevDiffData = null;

const TR_OCR_SCALE = 0.5; // OCR at half the feed resolution (retina capture is 2×, so this is ~CSS size)
const TR_OCR_COOLDOWN = 1000; // ms between OCR passes (0 = run back-to-back)
const TR_CONFIDENCE_MIN = 0.4;
const TR_TEXT_RE = /\p{Letter}{2,}/u;
const TR_CACHE_MAX = 1000;
const TR_DIFF_W = 64;
const TR_DIFF_H = 36;
const TR_DIFF_THRESHOLD = 4; // mean per-channel abs diff (0-255) below which the frame counts as unchanged
const TR_FONT_FAMILY = "system-ui, -apple-system, sans-serif"; // must match .translate-box
const PADDLE_ASSETS = "https://cdn.jsdelivr.net/npm/paddleocr-browser/dist/";

function _trIsText(str) {
  if (!TR_TEXT_RE.test(str)) return false;
  const letters = str.replace(/[^\p{Letter}]/gu, "").length;
  return letters / str.length >= 0.5;
}

function _trAcceptItem(item) {
  if (item.mean < TR_CONFIDENCE_MIN) return false;
  const text = item.text.trim();
  return !!text && _trIsText(text);
}

function _trFilterItems(result) {
  return result && result.src ? result.src.filter(_trAcceptItem) : [];
}

// Compute axis-aligned rect + rotation from a quadrilateral box [[x,y], ...],
// scaled from OCR pixel space into displayed-canvas space (dispW × dispH).
function _trQuadToRect(box, ocrW, ocrH, dispW, dispH) {
  const [tl, tr, br, bl] = box.map((p) => [
    (p[0] / ocrW) * dispW,
    (p[1] / ocrH) * dispH,
  ]);
  const left = Math.min(tl[0], bl[0]);
  const top = Math.min(tl[1], tr[1]);
  const right = Math.max(tr[0], br[0]);
  const bottom = Math.max(bl[1], br[1]);
  const width = right - left;
  const height = bottom - top;
  const angle = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]);
  // Box height from left edge (for font sizing)
  const boxH = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  return { left, top, width, height, angle, boxH };
}

async function _trInitPaddle(statusEl) {
  // Wait for Paddle module to be available
  if (!window.Paddle) {
    await new Promise((resolve) => {
      window.addEventListener("paddle-ready", resolve, { once: true });
    });
  }

  if (statusEl) statusEl.textContent = "Loading OCR models...";

  // Fetch dictionary text (esearch-ocr expects content via `decodeDic`, not a path)
  const dicText = await fetch(PADDLE_ASSETS + "ppocr_keys_v1.txt").then((r) =>
    r.text(),
  );

  if (statusEl) statusEl.textContent = "Initializing OCR...";

  // esearch-ocr v8: nested det/rec config, no OpenCV needed.
  _trOcrInstance = await window.Paddle.init({
    det: { input: PADDLE_ASSETS + "ppocr_det.onnx" },
    rec: {
      input: PADDLE_ASSETS + "ppocr_rec.onnx",
      decodeDic: dicText,
      optimize: { space: false }, // v5 models ship via paddleocr-browser
    },
    ort: window.ort,
  });

  _trReady = true;
}

function initTranslateFilter(overlayEl) {
  // Idempotent: on re-share, reuse the existing container, models, and
  // translator instead of re-initializing everything.
  if (_trOverlay) {
    showTranslateFilter();
    return true;
  }

  _trOverlay = overlayEl;
  _trFeedCanvas = document.createElement("canvas");
  _trFeedCtx = _trFeedCanvas.getContext("2d");

  _trBoxContainer = document.createElement("div");
  _trBoxContainer.style.cssText =
    "position:absolute;top:0;left:0;width:100%;height:100%";
  _trOverlay.appendChild(_trBoxContainer);

  _trOverlay.insertAdjacentHTML(
    "beforeend",
    '<div class="translate-status">Loading OCR engine...</div>',
  );

  const statusEl = _trOverlay.querySelector(".translate-status");

  _trInitPaddle(statusEl)
    .then(() => {
      if (statusEl) statusEl.textContent = "OCR ready — scanning...";
      setTimeout(() => {
        if (statusEl.textContent === "OCR ready — scanning...")
          statusEl.textContent = "";
      }, 2000);
    })
    .catch((e) => {
      console.error("PaddleOCR init failed:", e);
      if (statusEl) statusEl.textContent = "OCR failed to load";
    });

  _trInitTranslator(statusEl);

  return true;
}

async function _trInitTranslator(statusEl) {
  if (!("Translator" in self)) {
    console.warn(
      "Chrome Translator API not available — text will stay in German. " +
        "Use Chrome 138+ (chrome://flags → Translation API).",
    );
    if (statusEl) statusEl.textContent = "Translator unavailable — Chrome only";
    return;
  }

  try {
    const opts = { sourceLanguage: "de", targetLanguage: "en" };
    const availability = await Translator.availability(opts);
    console.log("Translator de→en availability:", availability);

    if (availability === "unavailable") {
      if (statusEl) statusEl.textContent = "de→en translation unavailable";
      return;
    }

    if (statusEl && availability !== "available") {
      statusEl.textContent = "Downloading translation model...";
    }

    _trTranslator = await Translator.create({
      ...opts,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          const pct = Math.round((e.loaded || 0) * 100);
          console.log("Translation model download:", pct + "%");
          if (statusEl) statusEl.textContent = `Downloading model ${pct}%`;
        });
      },
    });

    console.log("Translator ready (de→en)");
    if (statusEl && _trReady) statusEl.textContent = "";
    // Re-translate anything already detected before the translator was ready.
    if (_trResults) _trTranslateResults(_trResults);
  } catch (e) {
    console.error("Translator setup failed:", e);
    if (statusEl) statusEl.textContent = "Translation failed to load";
  }
}

function showTranslateFilter() {
  _trResults = null;
  _trResultsDirty = false;
  _trLastOcrTime = 0;
  _trRenderedCacheVersion = _trCacheVersion;
  if (_trBoxContainer) _trBoxContainer.innerHTML = "";
}

// Tear down session state when sharing stops. Bumps the session counter so
// in-flight ocr()/translate() promises from the old session are discarded.
// The translation cache survives — its keys are pure text, still valid.
function resetTranslateFilter() {
  _trSession++;
  _trBusy = false;
  _trResults = null;
  _trResultsDirty = false;
  _trLastOcrTime = 0;
  _trPrevDiffData = null;
  if (_trBoxContainer) _trBoxContainer.innerHTML = "";
}

// Returns true when the frame differs enough from the last checked frame to
// be worth a new OCR pass. Compares tiny downscaled snapshots so it's ~free.
function _trFrameChanged(sourceCanvas) {
  if (!_trDiffCtx) {
    _trDiffCanvas = document.createElement("canvas");
    _trDiffCanvas.width = TR_DIFF_W;
    _trDiffCanvas.height = TR_DIFF_H;
    _trDiffCtx = _trDiffCanvas.getContext("2d", { willReadFrequently: true });
  }

  _trDiffCtx.drawImage(sourceCanvas, 0, 0, TR_DIFF_W, TR_DIFF_H);
  const cur = _trDiffCtx.getImageData(0, 0, TR_DIFF_W, TR_DIFF_H).data;

  const prev = _trPrevDiffData;
  _trPrevDiffData = cur;
  if (!prev) return true;

  let diff = 0;
  for (let i = 0; i < cur.length; i += 4) {
    diff += Math.abs(cur[i] - prev[i]);
    diff += Math.abs(cur[i + 1] - prev[i + 1]);
    diff += Math.abs(cur[i + 2] - prev[i + 2]);
  }
  return diff / (TR_DIFF_W * TR_DIFF_H * 3) > TR_DIFF_THRESHOLD;
}

function _trTriggerOcr(sourceCanvas) {
  if (!_trReady || _trBusy) return;

  const now = performance.now();
  const shouldRun =
    _trLastOcrTime === 0 || now - _trLastOcrTime > TR_OCR_COOLDOWN;
  if (!shouldRun) return;

  if (!_trFrameChanged(sourceCanvas)) {
    // Re-arm the cooldown so the diff itself runs at most once per interval.
    _trLastOcrTime = now;
    return;
  }

  _trBusy = true;
  const session = _trSession;

  // OCR at half the source-frame resolution to keep inference fast.
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  const ocrW = Math.max(1, Math.round(sw * TR_OCR_SCALE));
  const ocrH = Math.max(1, Math.round(sh * TR_OCR_SCALE));

  _trFeedCanvas.width = ocrW;
  _trFeedCanvas.height = ocrH;
  _trFeedCtx.drawImage(sourceCanvas, 0, 0, sw, sh, 0, 0, ocrW, ocrH);

  _trOcrW = ocrW;
  _trOcrH = ocrH;

  _trOcrInstance
    .ocr(_trFeedCanvas)
    .then((result) => {
      if (session !== _trSession) return;
      _trResults = result;
      _trResultsDirty = true;
      _trLastOcrTime = performance.now();
      _trBusy = false;

      _trTranslateResults(result);
    })
    .catch((e) => {
      console.error("OCR failed:", e);
      if (session !== _trSession) return;
      _trBusy = false;
    });
}

async function _trTranslateResults(result) {
  if (!_trTranslator) return;
  const session = _trSession;

  const pending = [
    ...new Set(_trFilterItems(result).map((it) => it.text.trim())),
  ].filter((t) => !_trCache.has(t));
  if (!pending.length) return;

  await Promise.allSettled(
    pending.map((t) =>
      _trTranslator
        .translate(t)
        .then((translated) => {
          if (session !== _trSession) return;
          _trCache.set(t, translated);
          if (_trCache.size > TR_CACHE_MAX)
            _trCache.delete(_trCache.keys().next().value);
        })
        .catch((e) => {
          console.warn("translate failed for", JSON.stringify(t), e);
        }),
    ),
  );

  // One version bump per OCR pass: all new boxes flip to English together
  // instead of one at a time.
  if (session === _trSession) _trCacheVersion++;
}

function _trRebuildBoxes(dispW, dispH) {
  if (!_trBoxContainer || !_trResults) return;

  const ocrW = _trOcrW || 1;
  const ocrH = _trOcrH || 1;

  if (!_trMeasureCtx) {
    _trMeasureCtx = document.createElement("canvas").getContext("2d");
  }

  let html = "";

  for (const item of _trFilterItems(_trResults)) {
    const text = item.text.trim();
    const r = _trQuadToRect(item.box, ocrW, ocrH, dispW, dispH);
    const ocrSize = Math.max(8, Math.min(r.boxH * 0.75, 32));
    let fontSize = 20 * (1 / 3) + ocrSize * (2 / 3);

    const extraTranslateBoxPadding = 6;

    const displayText = _trCache.get(text) || text;

    // Shrink-to-fit: measure off-DOM and scale the font down so longer
    // translations stay on one line inside the source quad.
    _trMeasureCtx.font = fontSize + "px " + TR_FONT_FAMILY;
    const innerWidth = r.width + extraTranslateBoxPadding * 2 - 6;
    const measured = _trMeasureCtx.measureText(displayText).width;
    if (measured > innerWidth && measured > 0) {
      fontSize = Math.max(9, (fontSize * innerWidth) / measured);
    }

    const escaped = displayText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    html += `<div class="translate-box" style="left:${r.left - extraTranslateBoxPadding}px;top:${r.top - extraTranslateBoxPadding}px;width:${r.width + extraTranslateBoxPadding * 2}px;height:${r.height + extraTranslateBoxPadding * 2}px;font-size:${fontSize}px;">${escaped}</div>`;
  }

  _trBoxContainer.innerHTML = html;
  _trResultsDirty = false;
  _trRenderedCacheVersion = _trCacheVersion;
  _trLastDispW = dispW;
  _trLastDispH = dispH;
}

function renderTranslateFrame(sourceCanvas, dispW, dispH) {
  _trTriggerOcr(sourceCanvas);

  if (
    _trResultsDirty ||
    _trCacheVersion !== _trRenderedCacheVersion ||
    dispW !== _trLastDispW ||
    dispH !== _trLastDispH
  ) {
    _trRebuildBoxes(dispW, dispH);
  }
}
