import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OCR_ASSET_MANIFEST } from "../asset-manifest.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT_ROOT = join(ROOT, "public");

// The OCR models are the ONNX exports RapidOCR publishes for PP-OCRv6; the
// release tag and the SHA-256 in the manifest pin the exact files.
const RAPIDOCR_RELEASE =
  "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0";

const SOURCES = Object.freeze({
  ortWasm: {
    packagePath: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
  },
  detector: {
    remoteUrl: `${RAPIDOCR_RELEASE}/onnx/PP-OCRv6/det/PP-OCRv6_det_tiny.onnx`,
  },
  recognizer: {
    remoteUrl: `${RAPIDOCR_RELEASE}/onnx/PP-OCRv6/rec/PP-OCRv6_rec_tiny.onnx`,
  },
  dictionary: {
    remoteUrl: `${RAPIDOCR_RELEASE}/paddle/PP-OCRv6/rec/PP-OCRv6_rec_tiny/ppocrv6_tiny_dict.txt`,
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
