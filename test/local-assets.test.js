import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchVerifiedAsset,
  resolveLocalAssetUrl,
  sha256Hex,
  verifySha256,
} from "../local-assets.js";

const HELLO_HASH = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

test("local OCR assets resolve only to the current origin", () => {
  const url = resolveLocalAssetUrl("detector", "https://local.test/app?mode=test");
  assert.equal(url.origin, "https://local.test");
  assert.equal(url.pathname, "/ocr-assets/ppocr-det.onnx");
  assert.throws(
    () => resolveLocalAssetUrl("missing", "https://local.test/"),
    /Unlisted OCR asset/,
  );
});

test("asset manifests reject remote and traversing paths", () => {
  for (const path of ["https://remote.test/model.onnx", "ocr-assets/../secret", "/model.onnx"]) {
    const manifest = { test: { path, sha256: HELLO_HASH, format: "binary" } };
    assert.throws(
      () => resolveLocalAssetUrl("test", "https://local.test/", manifest),
      /Unsafe OCR asset path/,
    );
  }
});

test("SHA-256 verification accepts matching bytes and rejects mismatches", async () => {
  const bytes = new TextEncoder().encode("hello");
  assert.equal(await sha256Hex(bytes), HELLO_HASH);
  assert.equal(await verifySha256(bytes, HELLO_HASH), bytes);
  await assert.rejects(
    verifySha256(new TextEncoder().encode("goodbye"), HELLO_HASH),
    /Asset integrity check failed/,
  );
});

test("verified asset fetches use GET and return decoded local text", async () => {
  const bytes = new TextEncoder().encode("hello");
  const manifest = {
    dictionary: {
      path: "ocr-assets/test.txt",
      sha256: HELLO_HASH,
      format: "text",
    },
  };
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(bytes, { status: 200 });
  };

  const value = await fetchVerifiedAsset("dictionary", {
    baseUrl: "https://local.test/",
    fetchImpl,
    manifest,
  });
  assert.equal(value, "hello");
  assert.equal(request.url.href, "https://local.test/ocr-assets/test.txt");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.credentials, "same-origin");
  assert.equal(request.options.redirect, "error");
});

test("verified asset fetches reject a cross-origin response URL", async () => {
  const manifest = {
    model: { path: "ocr-assets/test.onnx", sha256: HELLO_HASH, format: "binary" },
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: "https://remote.test/test.onnx",
    arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
  });
  await assert.rejects(
    fetchVerifiedAsset("model", {
      baseUrl: "https://local.test/",
      fetchImpl,
      manifest,
    }),
    /response was not same-origin/,
  );
});
