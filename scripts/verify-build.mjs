import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OCR_ASSET_MANIFEST } from "../asset-manifest.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function requireFile(relativePath) {
  const path = join(DIST, relativePath);
  if (!(await stat(path)).isFile()) throw new Error(`Missing build file: ${relativePath}`);
  return path;
}

for (const relativePath of [
  "index.html",
  "fixtures/performance.html",
  "fixtures/worker-smoke.html",
]) {
  await requireFile(relativePath);
}

for (const [assetId, asset] of Object.entries(OCR_ASSET_MANIFEST)) {
  const bytes = await readFile(await requireFile(asset.path));
  const actual = sha256(bytes);
  if (actual !== asset.sha256) {
    throw new Error(`${assetId} has an unexpected build hash: ${actual}`);
  }
}

const index = await readFile(join(DIST, "index.html"), "utf8");
if (!index.includes("Content-Security-Policy")) {
  throw new Error("Built index is missing its Content Security Policy");
}

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(child)));
    else files.push(child);
  }
  return files;
}

const forbidden = [
  /https?:\/\/(?:cdn\.jsdelivr\.net|www\.modelscope\.cn)/i,
  /\b(?:sendBeacon|google-analytics|googletagmanager|posthog|sentry)\b/i,
  /\bmethod\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i,
];
const textExtensions = new Set([".html", ".js", ".mjs", ".css", ".map", ".json"]);
for (const path of await walk(DIST)) {
  if (!textExtensions.has(extname(path))) continue;
  const content = await readFile(path, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(content)) throw new Error(`Forbidden network capability in ${path}`);
  }
}

console.log(`Verified ${Object.keys(OCR_ASSET_MANIFEST).length} assets and production build policy.`);
