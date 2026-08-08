import {
  LruCache,
  SupersedingQueue,
  clamp,
  computeOcrDimensions,
  isActiveGeneration,
  normalizeText,
  quadToDisplayRect,
} from "./performance-core.js";

const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 200;
const SAMPLE_INTERVAL_MS = 1000 / 15;
const SCROLL_SETTLE_MS = 180;
const MAX_SCROLL_DEFERRAL_MS = 2500;
const RESOURCE_GRACE_MS = 60_000;
const CONFIDENCE_MIN = 0.4;
const CACHE_MAX = 1000;
const TEXT_RE = /\p{Letter}{2,}/u;
const FONT_FAMILY = "system-ui, -apple-system, sans-serif";

function modelForLanguage(language) {
  return language === "zh" ? "zh" : "latin";
}

function isReadableText(value) {
  const text = normalizeText(value);
  if (!TEXT_RE.test(text)) return false;
  const letters = text.replace(/[^\p{Letter}]/gu, "").length;
  return letters / Math.max(1, text.length) >= 0.5;
}

function rgb(style, key, fallback) {
  const value = style?.[key];
  if (!Array.isArray(value) || value.length < 3) return fallback;
  return value.slice(0, 3).map((channel) => clamp(Math.round(channel), 0, 255));
}

function relativeLuminance([red, green, blue]) {
  const values = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}

function contrastRatio(first, second) {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function contrastText(background, preferred) {
  if (contrastRatio(background, preferred) >= 4.5) return preferred;
  const black = [0, 0, 0];
  const white = [255, 255, 255];
  return contrastRatio(background, black) >= contrastRatio(background, white)
    ? black
    : white;
}

function percentile(values, amount) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * amount))];
}

// The app's single runtime contract: prepare(options), start(stream),
// setLanguages(source, target), stop(), and dispose().
export class TranslationSession {
  constructor({ video, overlay }) {
    this.video = video;
    this.overlay = overlay;

    this.boxContainer = document.createElement("div");
    this.boxContainer.className = "translate-boxes";
    this.statusElement = document.createElement("div");
    this.statusElement.className = "translate-status";
    this.overlay.replaceChildren(this.boxContainer, this.statusElement);

    this.sourceLanguage = "de";
    this.targetLanguage = "en";
    this.pairKey = "de>en";
    this.sameLanguage = false;
    this.modelId = "latin";
    this.generation = 1;
    this.active = false;
    this.prepared = false;
    this.documentVisible = !document.hidden;

    this.worker = null;
    this.workerReady = false;
    this.workerModel = null;
    this.workerInitGeneration = 0;
    this.pixelBudget = 1_500_000;
    this.ocrAverageMs = 900;
    this.ocrCooldownMs = 1350;

    this.translator = null;
    this.translatorPair = null;
    this.translatorPromise = null;
    this.translatorState = "idle";
    this.translationCache = new LruCache(CACHE_MAX);
    this.translationInFlight = new Map();
    this.translationQueue = new SupersedingQueue();
    this.translationPumpRunning = false;

    this.displayWidth = 0;
    this.displayHeight = 0;
    this.frameHandle = 0;
    this.frameHandleKind = "";
    this.frameId = 0;
    this.latestMotionFrameId = 0;
    this.ocrFrameId = 0;
    this.minimumOcrFrameId = 0;
    this.lastSampleAt = 0;
    this.samplePending = false;
    this.ocrInFlight = false;
    this.initialOcrSent = false;
    this.hasOcrResult = false;
    this.nextOcrAt = 0;
    this.changedSince = 0;
    this.lastScrollAt = 0;
    this.sceneCleared = false;

    this.scrollAccum = 0;
    this.resultScrollBase = 0;
    this.lastAppliedScroll = NaN;
    this.results = [];
    this.resultWidth = 1;
    this.resultHeight = 1;
    this.nodeMap = new Map();
    this.renderHandle = 0;
    this.releaseTimer = 0;

    this.status = new Map();
    this.perfEnabled = new URLSearchParams(location.search).has("perf");
    this.perf = {
      videoFrames: 0,
      sampleFrames: 0,
      lastRateAt: performance.now(),
      videoFps: 0,
      sampleFps: 0,
      handlerTimes: [],
      longTasks: 0,
      maxLongTask: 0,
      counts: null,
    };
    this.hud = null;
    this.longTaskObserver = null;
    if (this.perfEnabled) this.#installDiagnostics();

    this.visibilityHandler = () => this.#handleVisibility();
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  prepare({ sourceLanguage, targetLanguage }) {
    this.prepared = true;
    this.setLanguages(sourceLanguage, targetLanguage);
    if (this.sameLanguage || this.translatorState === "unavailable") {
      return Promise.resolve();
    }
    this.#ensureWorker();
    return this.translatorPromise || Promise.resolve();
  }

  setLanguages(sourceLanguage, targetLanguage) {
    const nextPair = `${sourceLanguage}>${targetLanguage}`;
    const nextModel = modelForLanguage(sourceLanguage);
    const changed = nextPair !== this.pairKey;

    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
    this.pairKey = nextPair;
    this.sameLanguage = sourceLanguage === targetLanguage;
    this.modelId = nextModel;

    if (changed) {
      this.generation++;
      this.samplePending = false;
      this.ocrInFlight = false;
      this.latestMotionFrameId = 0;
      this.ocrFrameId = 0;
      this.minimumOcrFrameId = 0;
      this.initialOcrSent = false;
      this.nextOcrAt = 0;
      this.translationQueue.clear();
      this.#destroyTranslator();
      this.#clearResults(true);
    }

    if (this.sameLanguage) {
      this.#stopFrameLoop();
      this.#terminateWorker();
      this.translatorState = "idle";
      this.#setStatus("translator", "");
      this.#setStatus("ocr", "");
      return;
    }

    if (!this.prepared && !this.active) return;

    this.#ensureWorker();
    this.#ensureTranslator(nextPair, sourceLanguage, targetLanguage);
    if (this.active) this.#startFrameLoop();
  }

  start(stream) {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = 0;
    this.stream = stream;
    this.active = true;
    this.frameId = 0;
    this.latestMotionFrameId = 0;
    this.ocrFrameId = 0;
    this.minimumOcrFrameId = 0;
    this.lastSampleAt = 0;
    this.samplePending = false;
    this.ocrInFlight = false;
    this.initialOcrSent = false;
    this.hasOcrResult = false;
    this.nextOcrAt = 0;
    this.changedSince = 0;
    this.lastScrollAt = 0;
    this.sceneCleared = false;
    this.#resetScroll();

    if (!this.sameLanguage && this.translatorState !== "unavailable") {
      this.#ensureWorker();
      this.#startFrameLoop();
    }
  }

  stop() {
    if (!this.active && this.releaseTimer) return;
    this.active = false;
    this.generation++;
    this.#stopFrameLoop();
    this.samplePending = false;
    this.ocrInFlight = false;
    this.ocrFrameId = 0;
    this.minimumOcrFrameId = 0;
    this.translationQueue.clear();
    this.#clearResults(true);
    if (this.worker) {
      this.worker.postMessage({
        type: "reset",
        sessionId: this.generation,
        frameId: 0,
      });
    }
    this.#setStatus("ocr", "");
    this.#setStatus("error", "");
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.#releaseResources(), RESOURCE_GRACE_MS);
  }

  dispose() {
    this.stop();
    clearTimeout(this.releaseTimer);
    this.releaseTimer = 0;
    this.#releaseResources();
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.longTaskObserver?.disconnect();
    if (this.renderHandle) cancelAnimationFrame(this.renderHandle);
    this.hud?.remove();
  }

  setDisplaySize(width, height) {
    const roundedWidth = Math.max(0, Math.round(width));
    const roundedHeight = Math.max(0, Math.round(height));
    if (
      roundedWidth === this.displayWidth &&
      roundedHeight === this.displayHeight
    ) {
      return;
    }
    this.displayWidth = roundedWidth;
    this.displayHeight = roundedHeight;
    this.#resetScroll();
    this.#scheduleRender();
    if (this.workerReady) {
      this.generation++;
      this.samplePending = false;
      this.ocrInFlight = false;
      this.latestMotionFrameId = 0;
      this.ocrFrameId = 0;
      this.minimumOcrFrameId = 0;
      this.worker.postMessage({
        type: "reset",
        sessionId: this.generation,
        frameId: 0,
      });
      this.initialOcrSent = false;
      this.hasOcrResult = false;
      this.nextOcrAt = 0;
    }
  }

  #ensureWorker() {
    if (this.sameLanguage) return;
    if (this.worker && this.workerModel !== this.modelId) this.#terminateWorker();

    if (!this.worker) {
      this.worker = new Worker(new URL("./ocr-worker.js", import.meta.url), {
        type: "module",
      });
      this.workerModel = this.modelId;
      this.workerReady = false;
      this.workerInitGeneration = 0;
      this.worker.addEventListener("message", (event) => this.#handleWorkerMessage(event));
      this.worker.addEventListener("error", (event) => {
        console.error("OCR worker failed:", event.message);
        this.workerReady = false;
        this.#setStatus("error", "OCR worker failed to load");
      });
    }

    if (!this.workerReady && this.workerInitGeneration !== this.generation) {
      this.workerInitGeneration = this.generation;
      this.worker.postMessage({
        type: "init",
        sessionId: this.generation,
        frameId: 0,
        modelId: this.modelId,
      });
    } else if (this.workerReady) {
      this.worker.postMessage({
        type: "reset",
        sessionId: this.generation,
        frameId: 0,
      });
    }
  }

  #terminateWorker() {
    if (!this.worker) return;
    this.worker.postMessage({
      type: "dispose",
      sessionId: this.generation,
      frameId: 0,
    });
    this.worker.terminate();
    this.worker = null;
    this.workerReady = false;
    this.workerModel = null;
    this.workerInitGeneration = 0;
  }

  #ensureTranslator(pair, sourceLanguage, targetLanguage) {
    if (
      (this.translator && this.translatorPair === pair) ||
      (this.translatorPromise && this.translatorPair === pair)
    ) {
      return;
    }

    if (!("Translator" in self)) {
      this.translatorState = "unavailable";
      this.#setStatus("translator", "Translator unavailable — Chrome desktop only");
      this.#stopFrameLoop();
      this.#terminateWorker();
      return;
    }

    const options = { sourceLanguage, targetLanguage };
    this.translatorPair = pair;
    this.translatorState = "loading";
    this.#setStatus("translator", "Preparing translation model...");

    // Start create() immediately in the user-activation task. Availability is
    // informative only and must not delay creation until activation expires.
    const availabilityPromise = Translator.availability(options).catch(() => null);
    let creation;
    try {
      creation = Translator.create({
        ...options,
        monitor: (monitor) => {
          monitor.addEventListener("downloadprogress", (event) => {
            if (pair !== this.pairKey) return;
            const percentage = Math.round((event.loaded || 0) * 100);
            this.#setStatus(
              "translator",
              `Downloading translation model ${percentage}%`,
            );
          });
        },
      });
    } catch (error) {
      this.#translatorFailed(error, pair);
      return;
    }

    this.translatorPromise = Promise.all([availabilityPromise, creation])
      .then(([availability, translator]) => {
        if (pair !== this.pairKey) {
          translator.destroy?.();
          return;
        }
        if (availability === "unavailable") {
          translator.destroy?.();
          this.translatorState = "unavailable";
          this.#setStatus("translator", `${pair} translation is unavailable`);
          this.#stopFrameLoop();
          this.#terminateWorker();
          return;
        }
        this.translator = translator;
        this.translatorPair = pair;
        this.translatorState = "ready";
        this.#setStatus("translator", "");
        this.#queueTranslations();
        this.nextOcrAt = 0;
      })
      .catch((error) => this.#translatorFailed(error, pair))
      .finally(() => {
        if (pair === this.pairKey && this.translatorPair === pair) {
          this.translatorPromise = null;
        }
      });
  }

  #translatorFailed(error, pair) {
    console.error("Translator setup failed:", error);
    if (pair !== this.pairKey) return;
    this.translator = null;
    this.translatorPromise = null;
    this.translatorState = "unavailable";
    this.#setStatus("translator", "Translation model failed to load");
    this.#stopFrameLoop();
    this.#terminateWorker();
  }

  #destroyTranslator() {
    try {
      this.translator?.destroy?.();
    } catch (_) {
      // A browser may already have destroyed a failed session.
    }
    this.translator = null;
    this.translatorPromise = null;
    this.translatorPair = null;
    this.translatorState = "idle";
    this.translationInFlight.clear();
  }

  #startFrameLoop() {
    if (
      !this.active ||
      !this.documentVisible ||
      this.frameHandle ||
      this.sameLanguage ||
      this.translatorState === "unavailable"
    ) {
      return;
    }
    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      this.frameHandleKind = "video";
      this.frameHandle = this.video.requestVideoFrameCallback((now) => {
        this.frameHandle = 0;
        this.#onVideoFrame(now);
        this.#startFrameLoop();
      });
    } else {
      this.frameHandleKind = "animation";
      this.frameHandle = requestAnimationFrame((now) => {
        this.frameHandle = 0;
        this.#onVideoFrame(now);
        this.#startFrameLoop();
      });
    }
  }

  #stopFrameLoop() {
    if (!this.frameHandle) return;
    if (this.frameHandleKind === "video" && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.frameHandle);
    } else {
      cancelAnimationFrame(this.frameHandle);
    }
    this.frameHandle = 0;
    this.frameHandleKind = "";
  }

  #onVideoFrame(now) {
    const startedAt = performance.now();
    this.perf.videoFrames++;
    if (
      this.active &&
      this.documentVisible &&
      this.workerReady &&
      !this.sameLanguage &&
      this.translatorState !== "unavailable" &&
      this.video.readyState >= 2 &&
      this.displayHeight > 0 &&
      !this.samplePending &&
      now - this.lastSampleAt >= SAMPLE_INTERVAL_MS
    ) {
      this.lastSampleAt = now;
      this.#captureSample();
    }
    this.#recordHandler(performance.now() - startedAt);
    this.#updateRates(now);
  }

  async #captureBitmap(width, height, resizeQuality) {
    try {
      return await createImageBitmap(this.video, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality,
      });
    } catch (_) {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = resizeQuality === "pixelated" ? "low" : "high";
      context.drawImage(this.video, 0, 0, width, height);
      return canvas.transferToImageBitmap();
    }
  }

  async #captureSample() {
    const generation = this.generation;
    const frameId = ++this.frameId;
    this.samplePending = true;
    try {
      const bitmap = await this.#captureBitmap(
        SAMPLE_WIDTH,
        SAMPLE_HEIGHT,
        "pixelated",
      );
      if (!this.active || generation !== this.generation || !this.worker) {
        bitmap.close();
        this.samplePending = false;
        return;
      }
      this.worker.postMessage(
        {
          type: "sample",
          sessionId: generation,
          frameId,
          displayHeight: this.displayHeight,
          bitmap,
        },
        [bitmap],
      );
    } catch (error) {
      this.samplePending = false;
      console.warn("Frame sampling failed:", error);
    }
  }

  #handleWorkerMessage(event) {
    const startedAt = performance.now();
    const message = event.data;
    if (!isActiveGeneration(message.sessionId, this.generation)) {
      return;
    }

    if (message.type === "status") {
      this.#setStatus("ocr", message.message);
    } else if (message.type === "ready") {
      this.workerReady = true;
      this.pixelBudget = message.policy.pixelBudget;
      this.ocrAverageMs = message.policy.averageMs;
      this.ocrCooldownMs = message.policy.cooldownMs;
      this.#setStatus("ocr", "");
      if (this.active) this.#startFrameLoop();
    } else if (message.type === "motion") {
      this.samplePending = false;
      if (message.frameId <= this.latestMotionFrameId) return;
      this.latestMotionFrameId = message.frameId;
      this.perf.sampleFrames++;
      this.#handleMotion(message);
    } else if (message.type === "ocr-result") {
      if (message.frameId !== this.ocrFrameId) return;
      this.ocrFrameId = 0;
      if (message.frameId < this.minimumOcrFrameId) {
        this.ocrInFlight = false;
        this.nextOcrAt = 0;
        return;
      }
      this.#acceptOcrResult(message);
    } else if (message.type === "ocr-busy") {
      if (message.frameId !== this.ocrFrameId) return;
      this.ocrInFlight = false;
      this.ocrFrameId = 0;
      this.nextOcrAt = performance.now() + 250;
    } else if (message.type === "error") {
      console.error(`OCR ${message.stage} failed:`, message.error);
      if (message.stage === "init") this.workerReady = false;
      if (message.stage === "sample") this.samplePending = false;
      if (message.stage === "ocr") {
        this.ocrInFlight = false;
        this.ocrFrameId = 0;
      }
      this.nextOcrAt = performance.now() + 2000;
      this.#setStatus("error", `OCR ${message.stage} failed`);
    }

    this.#recordHandler(performance.now() - startedAt);
  }

  #handleMotion(message) {
    const now = performance.now();
    if (message.moved) {
      this.scrollAccum += message.dy;
      this.lastScrollAt = now;
      if (this.results.length) this.#applyScrollTransform();
    }

    if (message.changed) {
      if (!this.changedSince) this.changedSince = now;
      if (message.sceneChange && !message.moved && !this.sceneCleared) {
        this.sceneCleared = true;
        this.minimumOcrFrameId = Math.max(
          this.minimumOcrFrameId,
          message.frameId,
        );
        this.#clearResults(true);
      }
    } else {
      this.changedSince = 0;
      this.sceneCleared = false;
    }

    this.#tryOcr(now, message.changed);
  }

  #tryOcr(now, changed) {
    if (
      !this.active ||
      !this.workerReady ||
      this.sameLanguage ||
      this.ocrInFlight ||
      this.displayHeight <= 0 ||
      (!changed && this.hasOcrResult) ||
      now < this.nextOcrAt
    ) {
      return;
    }

    if (this.translatorState !== "ready" && this.initialOcrSent) return;
    if (this.translatorState === "unavailable") return;

    const scrolling = now - this.lastScrollAt < SCROLL_SETTLE_MS;
    const deferredFor = this.changedSince ? now - this.changedSince : 0;
    if (scrolling && deferredFor < MAX_SCROLL_DEFERRAL_MS) return;

    this.#captureOcr();
  }

  async #captureOcr() {
    const generation = this.generation;
    const frameId = ++this.frameId;
    const captureScrollBase = this.scrollAccum;
    const sourceWidth = this.video.videoWidth;
    const sourceHeight = this.video.videoHeight;
    const target = computeOcrDimensions(sourceWidth, sourceHeight, this.pixelBudget);
    this.ocrInFlight = true;
    this.ocrFrameId = frameId;
    this.initialOcrSent = true;

    try {
      const bitmap = await this.#captureBitmap(target.width, target.height, "high");
      if (!this.active || generation !== this.generation || !this.worker) {
        bitmap.close();
        this.ocrInFlight = false;
        this.ocrFrameId = 0;
        return;
      }
      this.worker.postMessage(
        {
          type: "ocr",
          sessionId: generation,
          frameId,
          displayHeight: this.displayHeight,
          captureScrollBase,
          bitmap,
        },
        [bitmap],
      );
      this.#setStatus("ocr", "Scanning text...");
    } catch (error) {
      this.ocrInFlight = false;
      this.ocrFrameId = 0;
      this.nextOcrAt = performance.now() + 2000;
      console.warn("OCR frame capture failed:", error);
    }
  }

  #acceptOcrResult(message) {
    this.ocrInFlight = false;
    this.hasOcrResult = true;
    this.changedSince = 0;
    this.sceneCleared = false;
    this.minimumOcrFrameId = 0;
    this.pixelBudget = message.policy.pixelBudget;
    this.ocrAverageMs = message.policy.averageMs;
    this.ocrCooldownMs = message.policy.cooldownMs;
    this.nextOcrAt = performance.now() + this.ocrCooldownMs;
    this.perf.counts = message.counts;

    this.results = message.items.filter(
      (item) => item.mean >= CONFIDENCE_MIN && isReadableText(item.text),
    );
    this.resultWidth = message.width || 1;
    this.resultHeight = message.height || 1;
    this.resultScrollBase = message.captureScrollBase;
    this.#setStatus("ocr", "");
    this.#setStatus("error", "");
    this.#applyScrollTransform();
    this.#scheduleRender();
    this.#queueTranslations();
    this.#updateHud();
  }

  #queueTranslations() {
    if (!this.translator || this.translatorState !== "ready" || !this.results.length) {
      this.#scheduleRender();
      return;
    }

    const uniqueTexts = [];
    const seen = new Set();
    for (const item of this.results) {
      const text = normalizeText(item.text);
      const cacheKey = `${this.pairKey}:${text}`;
      if (!text || seen.has(cacheKey) || this.translationCache.get(cacheKey)) continue;
      seen.add(cacheKey);
      uniqueTexts.push({ text, cacheKey });
    }

    this.translationQueue.replace(uniqueTexts, {
      generation: this.generation,
      pair: this.pairKey,
      translator: this.translator,
    });
    this.#pumpTranslations();
  }

  async #pumpTranslations() {
    if (this.translationPumpRunning) return;
    this.translationPumpRunning = true;
    try {
      while (this.translationQueue.current) {
        const next = this.translationQueue.next((candidate) =>
          Boolean(this.translationCache.get(candidate.cacheKey)),
        );
        if (!next) continue;
        const { job, entry } = next;
        let promise = this.translationInFlight.get(entry.cacheKey);
        if (!promise) {
          promise = job.translator.translate(entry.text);
          this.translationInFlight.set(entry.cacheKey, promise);
        }

        try {
          const translated = await promise;
          // Pair-scoped text remains safe to cache even if a newer OCR result
          // superseded this job while the browser completed the active call.
          this.translationCache.set(entry.cacheKey, translated);
          if (job.pair === this.pairKey) this.#scheduleRender();
        } catch (error) {
          if (error?.name !== "AbortError") {
            console.warn("Translation failed for", JSON.stringify(entry.text), error);
          }
        } finally {
          this.translationInFlight.delete(entry.cacheKey);
        }
      }
    } finally {
      this.translationPumpRunning = false;
      if (this.translationQueue.current) this.#pumpTranslations();
    }
  }

  #scheduleRender() {
    if (this.renderHandle) return;
    this.renderHandle = requestAnimationFrame(() => {
      this.renderHandle = 0;
      this.#render();
    });
  }

  #render() {
    if (!this.displayWidth || !this.displayHeight || this.sameLanguage) {
      this.boxContainer.replaceChildren();
      this.nodeMap.clear();
      return;
    }

    const nextNodes = new Map();
    const desiredNodes = [];
    for (const item of this.results) {
      const sourceText = normalizeText(item.text);
      const translated = this.translationCache.get(`${this.pairKey}:${sourceText}`);
      if (!translated) continue;

      const rect = quadToDisplayRect(
        item.box,
        this.resultWidth,
        this.resultHeight,
        this.displayWidth,
        this.displayHeight,
      );
      if (rect.width <= 0 || rect.height <= 0) continue;

      const key = `${item.id}:${this.pairKey}`;
      const node = this.nodeMap.get(key) || document.createElement("div");

      const background = rgb(item.style, "bg", [245, 245, 245]);
      const preferredText = rgb(item.style, "text", [0, 0, 0]);
      const textColor = contrastText(background, preferredText);
      const lineHeight = Math.max(1, rect.boxHeight / Math.max(1, item.lineCount || 1));
      const fontSize = clamp(lineHeight * 0.72, 9, 32);
      const padding = 4;
      const signature = [
        translated,
        rect.left,
        rect.top,
        rect.width,
        rect.height,
        rect.angle,
        fontSize,
        ...background,
        ...textColor,
      ].join("|");

      if (node.translationSignature !== signature) {
        node.translationSignature = signature;
        node.className = "translate-box";
        node.textContent = translated;
        node.style.left = `${rect.left - padding}px`;
        node.style.top = `${rect.top - padding}px`;
        node.style.width = `${rect.width + padding * 2}px`;
        node.style.height = `${rect.height + padding * 2}px`;
        node.style.fontSize = `${fontSize}px`;
        node.style.fontFamily = FONT_FAMILY;
        node.style.backgroundColor = `rgba(${background.join(",")},0.96)`;
        node.style.color = `rgb(${textColor.join(",")})`;
        node.style.transform = `rotate(${rect.angle}rad)`;
      }

      nextNodes.set(key, node);
      desiredNodes.push(node);
    }

    for (const [key, node] of this.nodeMap) {
      if (!nextNodes.has(key)) node.remove();
    }
    for (let index = 0; index < desiredNodes.length; index++) {
      const node = desiredNodes[index];
      const current = this.boxContainer.children[index];
      if (current !== node) this.boxContainer.insertBefore(node, current || null);
    }
    this.nodeMap = nextNodes;
    this.#applyScrollTransform();
  }

  #applyScrollTransform() {
    const offset = this.scrollAccum - this.resultScrollBase;
    if (Math.abs(offset - this.lastAppliedScroll) < 0.05) return;
    this.lastAppliedScroll = offset;
    this.boxContainer.style.transform = `translate3d(0, ${offset}px, 0)`;
  }

  #resetScroll() {
    this.scrollAccum = 0;
    this.resultScrollBase = 0;
    this.lastScrollAt = 0;
    this.lastAppliedScroll = NaN;
    this.boxContainer.style.transform = "";
  }

  #clearResults(resetScroll) {
    this.results = [];
    this.hasOcrResult = false;
    this.translationQueue.clear();
    this.boxContainer.replaceChildren();
    this.nodeMap.clear();
    if (resetScroll) this.#resetScroll();
  }

  #handleVisibility() {
    this.documentVisible = !document.hidden;
    if (!this.active) return;
    if (!this.documentVisible) {
      this.#stopFrameLoop();
      this.generation++;
      this.samplePending = false;
      this.ocrInFlight = false;
      this.latestMotionFrameId = 0;
      this.ocrFrameId = 0;
      this.minimumOcrFrameId = 0;
      this.worker?.postMessage({
        type: "reset",
        sessionId: this.generation,
        frameId: 0,
      });
      return;
    }
    this.initialOcrSent = false;
    this.hasOcrResult = false;
    this.nextOcrAt = 0;
    if (this.translatorState !== "unavailable") this.#ensureWorker();
    this.#startFrameLoop();
  }

  #releaseResources() {
    this.#terminateWorker();
    this.#destroyTranslator();
    this.#setStatus("ocr", "");
    this.#setStatus("translator", "");
  }

  #setStatus(source, message) {
    if (message) this.status.set(source, message);
    else this.status.delete(source);
    const order = ["error", "translator", "ocr"];
    const activeSource = order.find((key) => this.status.has(key));
    this.statusElement.textContent = activeSource ? this.status.get(activeSource) : "";
  }

  #installDiagnostics() {
    this.hud = document.createElement("pre");
    this.hud.id = "perf-hud";
    document.body.appendChild(this.hud);
    if ("PerformanceObserver" in self) {
      try {
        this.longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.perf.longTasks++;
            this.perf.maxLongTask = Math.max(this.perf.maxLongTask, entry.duration);
          }
        });
        this.longTaskObserver.observe({ type: "longtask", buffered: true });
      } catch (_) {
        // Long-task observation is optional diagnostics only.
      }
    }
    this.#updateHud();
  }

  #recordHandler(duration) {
    if (!this.perfEnabled) return;
    this.perf.handlerTimes.push(duration);
    if (this.perf.handlerTimes.length > 180) this.perf.handlerTimes.shift();
  }

  #updateRates(now) {
    if (!this.perfEnabled || now - this.perf.lastRateAt < 1000) return;
    const seconds = (now - this.perf.lastRateAt) / 1000;
    this.perf.videoFps = this.perf.videoFrames / seconds;
    this.perf.sampleFps = this.perf.sampleFrames / seconds;
    this.perf.videoFrames = 0;
    this.perf.sampleFrames = 0;
    this.perf.lastRateAt = now;
    this.#updateHud();
  }

  #updateHud() {
    if (!this.hud) return;
    const counts = this.perf.counts || {};
    this.hud.textContent = [
      `video ${this.perf.videoFps.toFixed(1)} fps  sample ${this.perf.sampleFps.toFixed(1)} fps`,
      `ocr ${this.ocrAverageMs} ms  ${(this.pixelBudget / 1_000_000).toFixed(2)} MP  cooldown ${this.ocrCooldownMs} ms`,
      `regions ${counts.selected || 0}/${counts.detected || 0}  reused ${counts.reused || 0}`,
      `translations ${this.translationCache.size}/${CACHE_MAX}  queued ${this.translationQueue.current ? Math.max(0, this.translationQueue.current.entries.length - this.translationQueue.current.index) : 0}`,
      `main p95 ${percentile(this.perf.handlerTimes, 0.95).toFixed(2)} ms  long tasks ${this.perf.longTasks} (max ${this.perf.maxLongTask.toFixed(1)} ms)`,
      `worker ${this.worker ? (this.workerReady ? "ready" : "loading") : "idle"}  translator ${this.translatorState}`,
    ].join("\n");
  }
}
