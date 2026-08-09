import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRODUCTION_FILES = [
  "index.html",
  "script.js",
  "ocr.js",
  "ocr-worker.js",
  "performance-core.js",
  "local-assets.js",
  "asset-manifest.js",
  "style.css",
];

const FORBIDDEN = [
  [/https?:\/\//i, "remote URL"],
  [/\b(?:XMLHttpRequest|WebSocket|EventSource)\b/, "unexpected network client"],
  [/\b(?:sendBeacon|reportError)\b/, "telemetry API"],
  [/\b(?:google-analytics|googletagmanager|segment|sentry|posthog)\b/i, "analytics SDK"],
  [/\bmethod\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i, "upload-capable request"],
];

const failures = [];
for (const relativePath of PRODUCTION_FILES) {
  const source = await readFile(join(ROOT, relativePath), "utf8");
  for (const [pattern, description] of FORBIDDEN) {
    if (pattern.test(source)) failures.push(`${relativePath}: ${description}`);
  }
}

if (failures.length) {
  throw new Error(`Production source network audit failed:\n${failures.join("\n")}`);
}
console.log(`Audited ${PRODUCTION_FILES.length} production source files.`);
