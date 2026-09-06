// traduct.org — live local OCR and translation overlay
// Copyright (C) 2026 Javier Bórquez
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License, version 3, as published
// by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the LICENSE file distributed with this source.

import { TranslationSession } from "./ocr.js";
import { EXAMPLES } from "./examples.js";

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
let isStarting = false;
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
// Keep the original storage keys so existing language preferences survive the rename.
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
  // A <label> wrapper names the select without needing generated ids.
  const field = document.createElement("label");
  field.className = "lang-field";
  const caption = document.createElement("span");
  caption.className = "lang-label";
  caption.textContent = isSource ? "From" : "To";

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
  field.append(caption, select);
  return { field, select };
}

function createLanguageControls(variant) {
  const wrapper = document.createElement("div");
  wrapper.className = `lang-controls${variant ? ` ${variant}` : ""}`;
  const source = buildLanguageSelect(true);
  const target = buildLanguageSelect(false);

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

  if (variant === "intro") {
    source.field.querySelector(".lang-label").textContent = "Translate from";
    target.field.querySelector(".lang-label").textContent = "to";
    wrapper.append(source.field, target.field);
  } else {
    wrapper.append(source.field, swap, target.field);
  }
  languageControls.push({ sourceSelect: source.select, targetSelect: target.select });
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
  renderExamples();
  checkTranslatorAvailability();
  translationSession.setLanguages(sourceLanguage, targetLanguage);
}

// --- Sample page ----------------------------------------------------------
// The intro shows one museum page twice: as the shared window, and as the
// translation drawn over it. Both panels, and the pipe toy below them, are
// redrawn from the examples whenever the pickers change.
const sourceExample = document.getElementById("example-source");
const targetExample = document.getElementById("example-target");
const pipeDemo = document.getElementById("pipe-demo");
const pipeLaneIn = document.querySelector(".pipe-lane-in");
const pipeLaneOut = document.querySelector(".pipe-lane-out");

function exampleFor(code) {
  // English stands in if a language is ever offered without an example.
  return EXAMPLES[code] || EXAMPLES.en;
}

function fillExamplePanel(figure, code, url) {
  const example = exampleFor(code);
  figure.lang = code;
  figure.querySelector(".badge-language").textContent =
    LANGUAGES.find(([languageCode]) => languageCode === code)?.[1] || "English";
  figure.querySelector(".browser-url").textContent = url;
  const lines = [example.title, ...example.lines];
  figure.querySelectorAll(".browser-page p").forEach((paragraph, index) => {
    // The translated panel writes inside its highlight; the source panel is plain.
    (paragraph.querySelector(".hl") || paragraph).textContent = lines[index];
  });
}

function fillPipeLane(lane, code) {
  const { words } = exampleFor(code);
  lane.lang = code;
  // Both groups carry the same words, which is what hides the loop's wrap.
  for (const group of lane.querySelectorAll(".pipe-word-group")) {
    group.querySelectorAll(".pipe-word").forEach((word, index) => {
      word.textContent = words[index];
    });
  }
}

function renderExamples() {
  // The shared window keeps its own address; the translation is read here.
  fillExamplePanel(sourceExample, sourceLanguage, exampleFor(sourceLanguage).url);
  fillExamplePanel(targetExample, targetLanguage, "traduct.org");
  fillPipeLane(pipeLaneIn, sourceLanguage);
  fillPipeLane(pipeLaneOut, targetLanguage);
  pipeDemo.setAttribute(
    "aria-label",
    `A playful translation: ${languageName(sourceLanguage)} words enter a green ` +
      `pipe and come out in ${languageName(targetLanguage)}`,
  );
}

document
  .getElementById("intro-lang")
  .appendChild(createLanguageControls("intro"));
languageBar.appendChild(createLanguageControls("bar"));
const sourceBadgeSelect = buildLanguageSelect(true).select;
const targetBadgeSelect = buildLanguageSelect(false).select;
for (const [figure, select, name] of [
  [sourceExample, sourceBadgeSelect, "Original language"],
  [targetExample, targetBadgeSelect, "Translated language"],
]) {
  select.className = "badge-select";
  select.setAttribute("aria-label", name);
  figure.querySelector(".example-badge").appendChild(select);
}
languageControls.push({ sourceSelect: sourceBadgeSelect, targetSelect: targetBadgeSelect });
syncLanguageControls();
renderExamples();

// Nothing here works without the browser's built-in Translator, so the page
// says so and goes inert rather than failing at the first frame. Two ways it
// can fail: no Translator API at all, or no model for the chosen pair.
const hintText = document.querySelector(".hint:not(#startup-status)");
const unsupportedNotice = document.getElementById("unsupported");
const noApiMessage = unsupportedNotice.textContent.trim();
const translatorSupported = "Translator" in self;
let translatorUsable = translatorSupported;
let availabilityToken = 0;

function languageName(code) {
  const entry = LANGUAGES.find(([value]) => value === code);
  return entry ? entry[1] : code;
}

function showUnsupported(message) {
  unsupportedNotice.textContent = message;
  unsupportedNotice.hidden = false;
  hintText.hidden = true;
}

function hideUnsupported() {
  unsupportedNotice.hidden = true;
  hintText.hidden = false;
}

// The pickers stay live when only the pair is missing — changing them is how
// the reader gets out of it. With no API at all there is nothing to pick.
function setPickersEnabled(enabled) {
  for (const { sourceSelect, targetSelect } of languageControls) {
    sourceSelect.disabled = !enabled;
    targetSelect.disabled = !enabled;
  }
  for (const swap of document.querySelectorAll(".lang-swap")) {
    swap.disabled = !enabled;
  }
  for (const wrapper of document.querySelectorAll(".lang-controls")) {
    wrapper.classList.toggle("is-disabled", !enabled);
  }
}

function checkTranslatorAvailability() {
  if (!translatorSupported) return;
  const token = ++availabilityToken;
  const pair = { sourceLanguage, targetLanguage };
  Promise.resolve()
    .then(() => Translator.availability(pair))
    .then((availability) => availability === "unavailable" ? null : availability)
    .catch(() => null)
    .then((availability) => {
      if (token !== availabilityToken) return;
      translatorUsable = availability !== null;
      shareButton.disabled = isStarting || !translatorUsable;
      if (translatorUsable) hideUnsupported();
      else
        showUnsupported(
          `This browser cannot translate ${languageName(sourceLanguage)} to ` +
            `${languageName(targetLanguage)}. Try another pair.`,
        );
    });
}

if (!translatorSupported) {
  shareButton.disabled = true;
  setPickersEnabled(false);
  showUnsupported(noApiMessage);
} else {
  checkTranslatorAvailability();
}

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
  isStarting = false;
  shareButton.disabled = !translatorUsable;
  shareButton.textContent = "Share a window to translate";
  shareButton.removeAttribute("aria-busy");
  startupStatus.hidden = true;
  setPickersEnabled(translatorSupported);
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

async function startSession(stream, preparation) {
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
  await preparation;
  if (!isPlaying || track.readyState === "ended") return;
  await videoElement.play();

  isStarting = false;
  startupStatus.hidden = true;
  intro.style.display = "none";
  setPickersEnabled(true);
  document.body.classList.add("session-active");
  languageBar.classList.add("visible");
  layoutDisplay();
  translationSession.start();
}

const startupStatus = document.getElementById("startup-status");

shareButton.addEventListener("click", () => {
  if (isPlaying || !translatorUsable) return;
  isPlaying = true;
  isStarting = true;
  shareButton.disabled = true;
  shareButton.textContent = "Loading…";
  shareButton.setAttribute("aria-busy", "true");
  setPickersEnabled(false);
  startupStatus.textContent = "Loading text recognition and translation models…";
  startupStatus.hidden = false;

  // Both preparations begin in the click's activation task. The worker and
  // model downloads can proceed while the user chooses a screen to share.
  const translationReady = translationSession.prepare({ sourceLanguage, targetLanguage });
  const preparation = Promise.all([translationReady, translationSession.waitForOcr()])
    .then(() => {
      if (!translationSession.sameLanguage && translationSession.translatorState !== "ready") {
        throw new Error("Translation could not load. Please try again online.");
      }
    });
  // Handle failures immediately, even while the screen picker is still open.
  preparation.catch(() => {});

  navigator.mediaDevices
    .getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: false,
    })
    .then((stream) => startSession(stream, preparation))
    .catch((error) => {
      console.error("getDisplayMedia failed:", error);
      stopSession();
      if (error.name !== "NotAllowedError" && error.name !== "AbortError") {
        startupStatus.textContent = error.message || "Could not start translation. Please try again.";
        startupStatus.hidden = false;
      }
    });
});

videoElement.addEventListener("loadedmetadata", layoutDisplay);
window.addEventListener("resize", layoutDisplay, { passive: true });
window.addEventListener("pagehide", () => translationSession.dispose(), {
  once: true,
});
