import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PRODUCTION_FILES = [
  "index.html",
  "script.js",
  "examples.js",
  "ocr.js",
  "ocr-worker.js",
  "performance-core.js",
  "local-assets.js",
  "asset-manifest.js",
  "style.css",
];

// Markup legitimately carries absolute URLs that are not loads the app performs:
// canonical/Open Graph metadata, and links the reader may choose to follow.
// Strip exactly those, then hold the remainder to the same blanket rule — so a
// new <script src>, <link rel=stylesheet href> or <img src> pointing off-origin
// still fails the audit.
const INERT_MARKUP_URL = [
  /<a\b[^>]*?\bhref="[^"]*"/gis,
  /<meta\b[^>]*?\bcontent="[^"]*"/gis,
  /<link\b[^>]*?\brel="canonical"[^>]*>/gis,
];

function stripInertMarkupUrls(source) {
  return INERT_MARKUP_URL.reduce(
    (text, pattern) => text.replace(pattern, ""),
    source,
  );
}

const FORBIDDEN = [
  [/https?:\/\//i, "remote URL"],
  [/\b(?:XMLHttpRequest|WebSocket|EventSource)\b/, "unexpected network client"],
  [/\b(?:sendBeacon|reportError)\b/, "telemetry API"],
  [/\b(?:google-analytics|googletagmanager|segment|sentry|posthog)\b/i, "analytics SDK"],
  [/\bmethod\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i, "upload-capable request"],
];

const failures = [];
for (const relativePath of PRODUCTION_FILES) {
  const raw = await readFile(join(ROOT, relativePath), "utf8");
  const source = relativePath.endsWith(".html")
    ? stripInertMarkupUrls(raw)
    : raw;
  for (const [pattern, description] of FORBIDDEN) {
    if (pattern.test(source)) failures.push(`${relativePath}: ${description}`);
  }
}

if (failures.length) {
  throw new Error(`Production source network audit failed:\n${failures.join("\n")}`);
}
console.log(`Audited ${PRODUCTION_FILES.length} production source files.`);
