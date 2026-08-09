import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OCR_ASSET_MANIFEST } from "../asset-manifest.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_ROOT = join(ROOT, "public");

const SOURCES = Object.freeze({
  ortWasm: {
    packagePath: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
  },
  detector: {
    packagePath: "node_modules/paddleocr-browser/dist/ppocr_det.onnx",
  },
  chineseRecognition: {
    packagePath: "node_modules/paddleocr-browser/dist/ppocr_rec.onnx",
  },
  chineseDictionary: {
    packagePath: "node_modules/paddleocr-browser/dist/ppocr_keys_v1.txt",
  },
  latinRecognition: {
    remoteUrl:
      "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv5/rec/latin_PP-OCRv5_rec_mobile.onnx",
  },
  latinDictionary: {
    remoteUrl:
      "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/paddle/PP-OCRv5/rec/latin_PP-OCRv5_rec_mobile/ppocrv5_latin_dict.txt",
  },
});

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyFile(assetId, path) {
  const bytes = await readFile(path);
  const actual = hash(bytes);
  const expected = OCR_ASSET_MANIFEST[assetId].sha256;
  if (actual !== expected) {
    throw new Error(`${assetId} failed SHA-256 verification: expected ${expected}, got ${actual}`);
  }
}

async function downloadVerified(assetId, url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Failed to download ${assetId} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = hash(bytes);
  const expected = OCR_ASSET_MANIFEST[assetId].sha256;
  if (actual !== expected) {
    throw new Error(`${assetId} download failed SHA-256 verification`);
  }
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

for (const [assetId, asset] of Object.entries(OCR_ASSET_MANIFEST)) {
  const source = SOURCES[assetId];
  if (!source) throw new Error(`No build source configured for ${assetId}`);
  const target = join(OUTPUT_ROOT, asset.path);
  await mkdir(dirname(target), { recursive: true });

  try {
    await verifyFile(assetId, target);
    continue;
  } catch {
    await rm(target, { force: true });
  }

  if (source.packagePath) {
    const packagePath = join(ROOT, source.packagePath);
    await verifyFile(assetId, packagePath);
    await copyFile(packagePath, target);
  } else {
    await downloadVerified(assetId, source.remoteUrl, target);
  }
  await verifyFile(assetId, target);
}

console.log(`Verified ${Object.keys(OCR_ASSET_MANIFEST).length} local OCR assets.`);
