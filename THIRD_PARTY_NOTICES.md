# Third-party notices

traduct.org is licensed under GPL-3.0-only. The following components are
distributed with or used to build the application under their own licenses.
Those licenses apply to the respective third-party components; GPL-3.0 applies
to traduct.org's original application code.

## Runtime libraries

### eSearch OCR 8.5.0

- Purpose: layout analysis that groups recognized lines into columns and
  paragraphs.
- Source: https://github.com/xushengfeng/eSearch-OCR
- License: Apache License 2.0.
- License text: [`licenses/APACHE-2.0.txt`](./licenses/APACHE-2.0.txt).
- Copyright: eSearch OCR contributors.

### ONNX Runtime Web 1.26.0

- Purpose: local WebAssembly inference for ONNX OCR models.
- Source: https://github.com/microsoft/onnxruntime
- License: MIT License.
- License text: [`licenses/MIT.txt`](./licenses/MIT.txt).
- Copyright: Microsoft Corporation and contributors.

### Inter 4.1

- Purpose: the interface typeface, self-hosted as `public/fonts/InterVariable*.woff2`.
- Source: https://github.com/rsms/inter
- License: SIL Open Font License 1.1.
- License text: [`licenses/OFL-1.1.txt`](./licenses/OFL-1.1.txt).
- Copyright: 2016 The Inter Project Authors.

## OCR models and dictionary

The text detection and recognition models are the PP-OCRv6 "tiny" models
from PaddleOCR, in the ONNX export redistributed by RapidOCR. RapidOCR states
that OCR model copyright is held by Baidu. PaddleOCR and RapidOCR are provided
under the Apache License 2.0.

- PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR
- RapidOCR: https://github.com/RapidAI/RapidOCR
- Pinned RapidOCR asset release: `v3.10.0`
- License: Apache License 2.0.
- License text: [`licenses/APACHE-2.0.txt`](./licenses/APACHE-2.0.txt).

The build and browser verify the exact distributed files with SHA-256:

| Runtime file | SHA-256 |
| --- | --- |
| `ort-wasm-simd-threaded.wasm` | `040d52ce5066707a10d45cb9500c35e70a9c2fb33c4fb63428da9ae45b956b97` |
| `ppocrv6-det-tiny.onnx` | `f42c0fbd294d95eac1a550e131b277dac97462c8025fa4b6c3cec1b7894bd3d5` |
| `ppocrv6-rec-tiny.onnx` | `e16e242de5937ad92609223f19bc2aff3727ee40b095f996907c24749bad251b` |
| `ppocrv6-tiny-dict.txt` | `c5cbe34ef40c29c4df07ed012bf96569cb69a2d2a01a07027e9f13cb832bd9cd` |

Full license texts for installed npm dependencies are present in their npm
packages. The complete dependency graph and exact versions are recorded in
`pnpm-lock.yaml`.

## External runtime requirement

Google Chrome's built-in Translator API and browser-managed translation models
are required at runtime but are not distributed as part of this project. Their
terms are provided by the browser vendor.
