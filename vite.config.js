import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Permissions-Policy":
    "display-capture=(self), camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function assetFileNames(assetInfo) {
  if (
    assetInfo.name?.endsWith(".wasm") ||
    assetInfo.names.some((name) => name.endsWith(".wasm"))
  ) {
    return "ocr-assets/ort-wasm-simd-threaded.wasm";
  }
  return "assets/[name]-[hash][extname]";
}

export default defineConfig({
  server: { headers: SECURITY_HEADERS },
  preview: { headers: SECURITY_HEADERS },
  worker: {
    rollupOptions: { output: { assetFileNames } },
  },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(ROOT, "index.html"),
        performance: resolve(ROOT, "fixtures/performance.html"),
        workerSmoke: resolve(ROOT, "fixtures/worker-smoke.html"),
      },
      output: {
        assetFileNames,
      },
    },
  },
});
