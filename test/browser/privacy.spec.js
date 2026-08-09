import { expect, test } from "@playwright/test";

const PRIVATE_FIXTURE_TEXT = [
  "Translation café performance test",
  "翻译性能测试",
];

test("OCR stays on same-origin GET requests and CSP blocks external connections", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (request) => {
    requests.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      body: request.postData() || "",
    });
  });

  await page.goto("/");
  const externalFetch = await page.evaluate(async () => {
    try {
      await fetch("https://privacy-probe.invalid/captured-text");
      return "allowed";
    } catch (error) {
      return error.name;
    }
  });
  expect(externalFetch).not.toBe("allowed");

  await page.goto("/fixtures/worker-smoke.html");
  await expect(page.locator("html")).toHaveAttribute("data-result", "pass", {
    timeout: 100_000,
  });

  for (const request of requests) {
    const url = new URL(request.url);
    expect(url.origin).toBe("http://127.0.0.1:4173");
    expect(["GET", "HEAD"]).toContain(request.method);
    const serialized = `${request.url}\n${JSON.stringify(request.headers)}\n${request.body}`;
    for (const privateText of PRIVATE_FIXTURE_TEXT) {
      expect(serialized).not.toContain(privateText);
    }
  }
});
