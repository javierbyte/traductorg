// traduct.org — live local OCR and translation overlay
// Copyright (C) 2026 Javier Bórquez
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License, version 3, as published
// by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the LICENSE file distributed with this source.

import { OCR_ASSET_MANIFEST } from "./asset-manifest.js";

const SAFE_ASSET_PATH = /^ocr-assets\/[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function defaultBaseUrl() {
  if (globalThis.location?.href) return globalThis.location.href;
  throw new Error("A base URL is required outside a browser");
}

export function resolveLocalAssetUrl(
  assetId,
  baseUrl = defaultBaseUrl(),
  manifest = OCR_ASSET_MANIFEST,
) {
  const asset = manifest[assetId];
  if (!asset) throw new Error(`Unlisted OCR asset: ${assetId}`);
  if (!SAFE_ASSET_PATH.test(asset.path)) {
    throw new Error(`Unsafe OCR asset path: ${asset.path}`);
  }
  if (!SHA256.test(asset.sha256)) {
    throw new Error(`Invalid SHA-256 for OCR asset: ${assetId}`);
  }

  const base = new URL(baseUrl);
  const resolved = new URL(`/${asset.path}`, base.origin);
  if (resolved.origin !== base.origin || resolved.pathname !== `/${asset.path}`) {
    throw new Error(`OCR asset must be same-origin: ${assetId}`);
  }
  return resolved;
}

export async function sha256Hex(bytes, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("Web Crypto SHA-256 is unavailable");
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export async function verifySha256(bytes, expectedHash, subtle) {
  if (!SHA256.test(expectedHash)) throw new Error("Invalid expected SHA-256");
  const actualHash = await sha256Hex(bytes, subtle);
  if (actualHash !== expectedHash) {
    throw new Error(`Asset integrity check failed: expected ${expectedHash}, got ${actualHash}`);
  }
  return bytes;
}

export async function fetchVerifiedAsset(
  assetId,
  {
    baseUrl = defaultBaseUrl(),
    fetchImpl = globalThis.fetch,
    subtle = globalThis.crypto?.subtle,
    manifest = OCR_ASSET_MANIFEST,
  } = {},
) {
  if (!fetchImpl) throw new Error("Fetch is unavailable");
  const asset = manifest[assetId];
  const url = resolveLocalAssetUrl(assetId, baseUrl, manifest);
  const response = await fetchImpl(url, {
    method: "GET",
    cache: "force-cache",
    credentials: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    throw new Error(`Failed to load ${assetId} (${response.status})`);
  }

  const responseUrl = new URL(response.url || url, url);
  if (responseUrl.origin !== url.origin || responseUrl.pathname !== url.pathname) {
    throw new Error(`OCR asset response was not same-origin: ${assetId}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await verifySha256(bytes, asset.sha256, subtle);
  if (asset.format === "text") return new TextDecoder().decode(bytes);
  return bytes;
}
