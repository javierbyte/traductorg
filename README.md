# translation-glass

Live, on-device translation over a screen-shared video feed. The source and
target languages are selectable; German → English is the default.

## Runtime architecture

1. **Native screen composition.** The captured stream is displayed directly in
   a `<video>` element at a requested maximum of 30 fps. No full-resolution
   canvas is copied on every frame.
2. **Bounded sampling.** At most 15 tiny frame samples per second are sent to an
   OCR worker for change detection and vertical-scroll tracking. Static screens
   stop triggering OCR after the first pass.
3. **Adaptive OCR.** PaddleOCR runs entirely in the worker. OCR frames start at
   1.5 megapixels and adapt within a 1–2 megapixel range according to measured
   inference time. Cooldowns keep continuous inference near a 40% duty ceiling.
4. **Recognition reuse.** Unreadably small regions are skipped, dense frames are
   capped at 120 regions, and matching line crops reuse a bounded recognition
   cache while scrolling or partially changing.
5. **Paragraph translation.** Compatible OCR lines are grouped into paragraphs
   before being sent through Chrome's built-in Translator API. Translation is
   sequential, latest-result-first, and cached per language pair.
6. **Lightweight overlay.** OCR-sampled background colors replace per-box
   backdrop blurs. Keyed DOM nodes render translated text and the whole overlay
   glides as one compositor layer during scrolling.

OCR, translation, and their models remain on the user's computer. Models are
downloaded from pinned jsDelivr and RapidOCR/ModelScope releases and cached by
the browser.

## Requirements

- Chrome desktop with the built-in Translator API.
- A secure context. `localhost` works for local development.
- Cross-origin isolation for multi-threaded WebAssembly. The included local
  server and Vercel configuration provide the required COOP/COEP headers.

## Run locally

```sh
npm run dev
# open http://localhost:8000
```

The app uses a Latin recognition model for German, English, Spanish, French,
Italian, Portuguese, and Dutch. Chinese uses the Chinese+English model. Changing
between Latin languages keeps the worker/model warm; changing scripts replaces
the worker so only one recognition model remains in memory.

OCR and Translator sessions are released 60 seconds after sharing stops. Text
caches survive so a later session can still reuse prior translations.

## Performance diagnostics

Open `http://localhost:8000/?perf=1` to show a local diagnostics HUD containing:

- delivered video and analyzed sample rates;
- OCR duration, pixel budget, and cooldown;
- detected, selected, recognized, and reused region counts;
- translation cache and queue sizes;
- main-thread handler p95 and observed long tasks.

No diagnostics leave the browser.

For repeatable manual scenarios, open
`http://localhost:8000/fixtures/performance.html` in another tab and share that
tab. It provides static accented text, Chinese and rotated text, long scrolling
content, more than 120 dense regions, and moving subtitles.

`http://localhost:8000/fixtures/worker-smoke.html` runs a complete synthetic
Latin OCR pass and reports PASS/FAIL without requesting a screen. Add `?model=zh`
to exercise the Chinese model instead.

## Checks

```sh
npm test   # deterministic node:test coverage for policies and pure algorithms
npm run check
```

The unit suite covers adaptive resolution/cooldowns, aspect-ratio bounds, LRU
eviction, translation-job supersession, stale session generations, paragraph
grouping, readable-region selection, image fingerprints, frame differences,
scroll direction, and overlay geometry.

## Resource policy

- Capture request: native resolution, at most 30 fps, `contentHint = "text"`.
- Motion analysis: at most 15 fps at 64×200 pixels.
- OCR: one in flight, 1–2 MP, 120 readable regions maximum.
- WASM threads: half the logical processors, minimum one and maximum four.
- Caches: 500 recognition entries and 1,000 pair-scoped translations.
- Lifecycle: no OCR for equal languages or hidden documents; worker and active
  Translator destroyed after the stopped-session grace period.

WebGPU is intentionally not enabled. It should only become a default after the
exact OCR models demonstrate lower total power usage and equivalent accuracy.
