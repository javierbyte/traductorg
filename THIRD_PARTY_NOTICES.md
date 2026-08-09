# Third-party notices

Translation Glass is licensed under GPL-3.0-only. The following components are
distributed with or used to build the application under their own licenses.
Those licenses apply to the respective third-party components; GPL-3.0 applies
to Translation Glass's original application code.

## Runtime libraries

### eSearch OCR 8.5.0

- Purpose: PaddleOCR preprocessing, detection, recognition, and postprocessing.
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

### paddleocr-browser 1.0.3

- Purpose: build-time source for selected PaddleOCR model and dictionary files.
- Source: https://github.com/xulihang/paddleocr-browser
- License for package code: MIT License.
- License text: [`licenses/MIT.txt`](./licenses/MIT.txt).
- Copyright: paddleocr-browser contributors.

## OCR models and dictionaries

The OCR models originate from PaddleOCR and are redistributed through
paddleocr-browser and RapidOCR. RapidOCR states that OCR model copyright is
held by Baidu. PaddleOCR and RapidOCR are provided under the Apache License 2.0.

- PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR
- RapidOCR: https://github.com/RapidAI/RapidOCR
- Pinned RapidOCR asset release: `v3.9.2`
- License: Apache License 2.0.
- License text: [`licenses/APACHE-2.0.txt`](./licenses/APACHE-2.0.txt).

The build and browser verify the exact distributed files with SHA-256:

| Runtime file | SHA-256 |
| --- | --- |
| `ort-wasm-simd-threaded.wasm` | `040d52ce5066707a10d45cb9500c35e70a9c2fb33c4fb63428da9ae45b956b97` |
| `ppocr-det.onnx` | `5e7b06f5391ceda129ae89b3e2f878bd4e39c3a124146d8bbf7ca18ae9aa1ab8` |
| `latin-ppocrv5-rec.onnx` | `b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a` |
| `ppocrv5-latin-dict.txt` | `3c0a8a79b612653c25f765271714f71281e4e955962c153e272b7b8c1d2b13ff` |
| `ppocr-rec.onnx` | `8a3ea65009fd529688f316bf29b1b517b33b1dd23facae6e3270f509895b1600` |
| `ppocr-keys-v1.txt` | `28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7` |

Full license texts for installed npm dependencies are present in their npm
packages. The complete dependency graph and exact versions are recorded in
`pnpm-lock.yaml`.

## External runtime requirement

Google Chrome's built-in Translator API and browser-managed translation models
are required at runtime but are not distributed as part of this project. Their
terms are provided by the browser vendor.
