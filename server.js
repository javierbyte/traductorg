import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT) || 8000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  // Cross-origin isolation — required for SharedArrayBuffer / threaded WASM.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");

  // Resolve the request path safely within ROOT.
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relPath = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(ROOT, relPath);
  if (urlPath.endsWith("/")) filePath = join(filePath, "index.html");

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    res.setHeader("Content-Type", MIME[extname(filePath)] || "application/octet-stream");
    res.writeHead(200).end(body);
  } catch (err) {
    if (err.code === "ENOENT") res.writeHead(404).end("Not found");
    else {
      console.error(err);
      res.writeHead(500).end("Server error");
    }
  }
});

server.listen(PORT, () => {
  console.log(`translation-glass dev server → http://localhost:${PORT}`);
});
