// traduct.org — live local OCR and translation overlay
// Copyright (C) 2026 Javier Bórquez
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License, version 3, as published
// by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the LICENSE file distributed with this source.

export const OCR_ASSET_MANIFEST = Object.freeze({
  ortWasm: Object.freeze({
    path: "ocr-assets/ort-wasm-simd-threaded.wasm",
    sha256: "040d52ce5066707a10d45cb9500c35e70a9c2fb33c4fb63428da9ae45b956b97",
    format: "binary",
  }),
  detector: Object.freeze({
    path: "ocr-assets/ppocr-det.onnx",
    sha256: "5e7b06f5391ceda129ae89b3e2f878bd4e39c3a124146d8bbf7ca18ae9aa1ab8",
    format: "binary",
  }),
  latinRecognition: Object.freeze({
    path: "ocr-assets/latin-ppocrv5-rec.onnx",
    sha256: "b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a",
    format: "binary",
  }),
  latinDictionary: Object.freeze({
    path: "ocr-assets/ppocrv5-latin-dict.txt",
    sha256: "3c0a8a79b612653c25f765271714f71281e4e955962c153e272b7b8c1d2b13ff",
    format: "text",
  }),
  chineseRecognition: Object.freeze({
    path: "ocr-assets/ppocr-rec.onnx",
    sha256: "8a3ea65009fd529688f316bf29b1b517b33b1dd23facae6e3270f509895b1600",
    format: "binary",
  }),
  chineseDictionary: Object.freeze({
    path: "ocr-assets/ppocr-keys-v1.txt",
    sha256: "28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7",
    format: "text",
  }),
});
