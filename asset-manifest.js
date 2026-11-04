// traduct.org — live local OCR and translation overlay
// Copyright (C) 2026 Javier Bórquez
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License, version 3, as published
// by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the LICENSE file distributed with this source.

// One PP-OCRv6 "tiny" model pair reads Chinese, English and the Latin-script
// languages the app offers, so every language shares the same two models.
export const OCR_ASSET_MANIFEST = Object.freeze({
  ortWasm: Object.freeze({
    path: "ocr-assets/ort-wasm-simd-threaded.wasm",
    sha256: "040d52ce5066707a10d45cb9500c35e70a9c2fb33c4fb63428da9ae45b956b97",
    format: "binary",
  }),
  detector: Object.freeze({
    path: "ocr-assets/ppocrv6-det-tiny.onnx",
    sha256: "f42c0fbd294d95eac1a550e131b277dac97462c8025fa4b6c3cec1b7894bd3d5",
    format: "binary",
  }),
  recognizer: Object.freeze({
    path: "ocr-assets/ppocrv6-rec-tiny.onnx",
    sha256: "e16e242de5937ad92609223f19bc2aff3727ee40b095f996907c24749bad251b",
    format: "binary",
  }),
  dictionary: Object.freeze({
    path: "ocr-assets/ppocrv6-tiny-dict.txt",
    sha256: "c5cbe34ef40c29c4df07ed012bf96569cb69a2d2a01a07027e9f13cb832bd9cd",
    format: "text",
  }),
});
