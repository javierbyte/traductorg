import { TranslationSession } from "./ocr.js";

const videoElement = document.querySelector("video");
const translateOverlay = document.getElementById("translate-overlay");
const shareButton = document.getElementById("share-btn");
const languageBar = document.getElementById("lang-bar");
const intro = document.getElementById("intro");

const translationSession = new TranslationSession({
  video: videoElement,
  overlay: translateOverlay,
});

let isPlaying = false;
let lastLayout = "";

// Only languages with an installed OCR recognition model are offered. Latin
// languages share the smaller Latin model; Chinese uses the Chinese+English
// model. Target choices mirror sources so inversion is always valid.
const LANGUAGES = [
  ["de", "German"],
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["zh", "Chinese"],
];
const STORAGE_SOURCE = "traducto.srcLang";
const STORAGE_TARGET = "traducto.tgtLang";

function loadStoredLanguage(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    if (LANGUAGES.some(([code]) => code === value)) return value;
  } catch (_) {
    // Storage may be unavailable in private contexts.
  }
  return fallback;
}

let sourceLanguage = loadStoredLanguage(STORAGE_SOURCE, "de");
let targetLanguage = loadStoredLanguage(STORAGE_TARGET, "en");
const languageControls = [];

function buildLanguageSelect(isSource) {
  const select = document.createElement("select");
  select.className = "lang-select";
  for (const [code, name] of LANGUAGES) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = name;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    if (isSource) sourceLanguage = select.value;
    else targetLanguage = select.value;
    applyLanguages();
  });
  return select;
}

function createLanguageControls(variant) {
  const wrapper = document.createElement("div");
  wrapper.className = `lang-controls${variant ? ` ${variant}` : ""}`;
  const sourceSelect = buildLanguageSelect(true);
  const targetSelect = buildLanguageSelect(false);

  const swap = document.createElement("button");
  swap.type = "button";
  swap.className = "lang-swap";
  swap.title = "Invert languages";
  swap.setAttribute("aria-label", "Invert languages");
  swap.textContent = "⇄";
  let swapTurns = 0;
  swap.addEventListener("click", () => {
    [sourceLanguage, targetLanguage] = [targetLanguage, sourceLanguage];
    swapTurns++;
    swap.style.transform = `rotate(${swapTurns * 180}deg)`;
    applyLanguages();
  });

  wrapper.append(sourceSelect, swap, targetSelect);
  languageControls.push({ sourceSelect, targetSelect });
  return wrapper;
}

function syncLanguageControls() {
  for (const { sourceSelect, targetSelect } of languageControls) {
    sourceSelect.value = sourceLanguage;
    targetSelect.value = targetLanguage;
  }
}

function applyLanguages() {
  try {
    localStorage.setItem(STORAGE_SOURCE, sourceLanguage);
    localStorage.setItem(STORAGE_TARGET, targetLanguage);
  } catch (_) {
    // The active selection still works without persistence.
  }
  syncLanguageControls();
  translationSession.setLanguages(sourceLanguage, targetLanguage);
}

document
  .getElementById("intro-lang")
  .appendChild(createLanguageControls("intro"));
languageBar.appendChild(createLanguageControls("bar"));
syncLanguageControls();

function layoutDisplay() {
  const sourceWidth = videoElement.videoWidth;
  const sourceHeight = videoElement.videoHeight;
  if (!sourceWidth || !sourceHeight) return;

  const scale = Math.min(
    window.innerWidth / sourceWidth,
    window.innerHeight / sourceHeight,
  );
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  const left = Math.round((window.innerWidth - width) / 2);
  const top = Math.round((window.innerHeight - height) / 2);
  const signature = `${left},${top},${width},${height}`;
  if (signature === lastLayout) return;
  lastLayout = signature;

  for (const element of [videoElement, translateOverlay]) {
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
  }
  translationSession.setDisplaySize(width, height);
}

function stopSession() {
  if (!isPlaying && !videoElement.srcObject) return;
  isPlaying = false;
  translationSession.stop();

  if (videoElement.srcObject) {
    for (const track of videoElement.srcObject.getTracks()) track.stop();
    videoElement.srcObject = null;
  }
  lastLayout = "";
  document.body.classList.remove("session-active");
  languageBar.classList.remove("visible");
  intro.style.display = "";
}

async function startSession(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("Screen share did not provide a video track");

  if ("contentHint" in track) {
    track.contentHint = "text";
    if (track.contentHint !== "text") track.contentHint = "detail";
  }
  try {
    await track.applyConstraints({ frameRate: { ideal: 30, max: 30 } });
  } catch (error) {
    console.warn("The browser could not apply the 30 fps capture cap:", error);
  }

  videoElement.srcObject = stream;
  track.addEventListener("ended", stopSession, { once: true });
  await videoElement.play();

  document.body.classList.add("session-active");
  languageBar.classList.add("visible");
  layoutDisplay();
  translationSession.start(stream);
}

shareButton.addEventListener("click", () => {
  if (isPlaying) return;
  isPlaying = true;
  intro.style.display = "none";

  // Both preparations begin in the click's activation task. The worker and
  // model downloads can proceed while the user chooses a screen to share.
  translationSession.prepare({ sourceLanguage, targetLanguage });

  navigator.mediaDevices
    .getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: false,
    })
    .then(startSession)
    .catch((error) => {
      console.error("getDisplayMedia failed:", error);
      stopSession();
    });
});

videoElement.addEventListener("loadedmetadata", layoutDisplay);
window.addEventListener("resize", layoutDisplay, { passive: true });
window.addEventListener("pagehide", () => translationSession.dispose(), {
  once: true,
});
