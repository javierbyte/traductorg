# translation-glass

Live German → English translation overlaid on a screen-shared video feed.

## How it works

1. **Screen capture.** The page asks to share a screen, window, or tab.
2. **OCR the whole frame.** Each captured frame is drawn to a canvas and, on a
   periodic cooldown, run through PaddleOCR (via [esearch-ocr](https://www.npmjs.com/package/esearch-ocr)
   on onnxruntime-web in the browser). Passes are skipped when a downscaled
   frame diff shows nothing changed on screen.
3. **Translate.** Detected German text is translated to English on-device using
   the Chrome built-in [Translator API](https://developer.chrome.com/docs/ai/translator-api),
   with results cached per string.
4. **Overlay.** Translated text boxes are drawn over the original text, aligned
   to the letterboxed feed.

No window-position detection, cropping, or filters — the entire frame is
translated.

## Requirements

- **Chrome** (the Translator API is Chrome-only).
- Served over a secure context — `localhost` works for local development.

## Run locally

```sh
npm run dev
# then open http://localhost:8000 in Chrome
```

The dev server (`server.js`, no dependencies) sends `Cross-Origin-Opener-Policy`
and `Cross-Origin-Embedder-Policy` headers so the page is **cross-origin
isolated** — required for `SharedArrayBuffer` / multi-threaded OCR. The same
headers are configured for production in `vercel.json`. A plain static file
server (e.g. `python3 -m http.server`) works but forces single-threaded OCR.

## Notes

Source/target languages are currently hardcoded to German → English; user-facing
controls will come later.
