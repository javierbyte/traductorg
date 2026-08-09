# Translation Glass

Live, on-device translation over a screen-shared video feed. German to English
is the default; the source and target languages are selectable.

## Product promises

### Free

Translation Glass has no account, advertising, subscription, telemetry, usage
fee, or paid API. Anyone may run their own copy under the GPL-3.0 license.

### Local and private

Screen pixels, OCR output, and translated text never leave the user's device.
OCR runs in a local browser worker and translation uses Chrome's built-in
Translator API. There are no application API routes, uploads, analytics, or
remote error-reporting services.

The browser still makes ordinary network requests for the app's static files
and same-origin OCR assets. A hosting provider can observe those requests and
normal metadata such as the user's IP address, but the requests contain no
captured pixels or recognized/translated text. Chrome may separately download
browser-managed language packs. Selected language codes are stored only in
browser `localStorage`.

### Open source

The application source is licensed under
[GNU GPL version 3](./LICENSE). Runtime libraries and OCR assets retain their
own compatible licenses; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
Chrome and its built-in translation model are external runtime requirements and
are not part of this open-source project.

## Runtime architecture

1. **Native screen composition.** The captured stream is displayed directly in
   a `<video>` element at a requested maximum of 30 fps.
2. **Bounded sampling.** At most 15 small frame samples per second are sent to
   the OCR worker for change detection and vertical-scroll tracking.
3. **Verified local OCR.** Pinned OCR models, dictionaries, and ONNX Runtime
   WASM are served from the app's origin and checked against SHA-256 hashes.
   PaddleOCR inference then runs entirely inside the worker.
4. **Adaptive recognition.** OCR frames adapt within a 1–2 megapixel range,
   dense frames are capped at 120 regions, and recognition results are cached.
5. **On-device translation.** OCR lines are grouped into paragraphs and passed
   to Chrome's built-in Translator API. Translation is sequential, superseding,
   and cached per language pair.
6. **Lightweight overlay.** Keyed DOM nodes render translated text over the
   native video element and move as one compositor layer during scrolling.

The Content Security Policy limits scripts, workers, connections, styles, and
media to the app origin plus the browser-local blob/data sources needed for
screen sharing. Production code contains no third-party runtime URL.

## Requirements

- Chrome desktop with the built-in Translator API.
- A secure context. `localhost` works for local development.
- Cross-origin isolation for multi-threaded WebAssembly. The Vite development
  and preview servers provide the necessary COOP/COEP headers. A self-hosted
  production server must provide equivalent headers.
- Node.js 20.19+ or 22.12+ and pnpm for development.

## Develop and build

```sh
pnpm install
pnpm dev
# open http://localhost:5173
```

```sh
pnpm build
pnpm preview
# open http://localhost:4173
```

The build copies only the required assets from pinned npm packages. It also
downloads the pinned RapidOCR Latin recognition model and dictionary, verifies
their SHA-256 hashes, and writes all runtime assets beneath
`dist/ocr-assets/`. A hash mismatch fails the build. Once built, the browser
loads OCR code and models only from the app's own origin.

The app uses one Latin recognition model for German, English, Spanish, French,
Italian, Portuguese, and Dutch. Chinese uses a Chinese-and-English model.
Changing between Latin languages keeps the worker/model warm; changing scripts
replaces the worker so only one recognition model remains in memory.

OCR and Translator sessions are released 60 seconds after sharing stops. Text
caches survive so a later session can reuse previous translations.

## Checks

```sh
pnpm test          # deterministic unit tests
pnpm check:source  # production source network-policy audit
pnpm build         # asset integrity and build-output audit
pnpm test:privacy  # build plus real-Chrome same-origin privacy test
pnpm check         # all checks above
```

The privacy browser test runs a synthetic OCR pass while recording every
request. It requires a locally installed Google Chrome, asserts that application
requests remain same-origin GET/HEAD requests with no fixture text in request
metadata, and confirms that CSP blocks an external connection attempt.

For manual end-to-end validation, use a clean Chrome profile, open
`/fixtures/performance.html` in another tab, share that tab, and inspect the
Network panel. Only static same-origin GET requests should appear. Stop sharing
and wait 60 seconds to confirm OCR and Translator resources are released.

Additional diagnostics:

- `/?perf=1` shows an entirely local performance HUD.
- `/fixtures/worker-smoke.html` runs a synthetic Latin OCR pass.
- `/fixtures/worker-smoke.html?model=zh` runs the Chinese OCR path.

## Resource policy

- Capture: native resolution, at most 30 fps, `contentHint = "text"`.
- Motion analysis: at most 15 fps at 64×200 pixels.
- OCR: one inference at a time, 1–2 MP, 120 readable regions maximum.
- WASM threads: half the logical processors, minimum one and maximum four.
- Caches: 500 recognition entries and 1,000 pair-scoped translations.
- Lifecycle: no OCR for equal languages or hidden documents; OCR and active
  Translator resources are destroyed after the stopped-session grace period.

WebGPU is intentionally disabled. It should only become a default after the
exact OCR models demonstrate lower total power use and equivalent accuracy.
