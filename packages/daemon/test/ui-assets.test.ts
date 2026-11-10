// serveUiAsset's path-traversal hardening and "not built yet" fallback,
// against a controlled temp dist dir (not whatever happens to be built
// in this checkout). See docs/decisions.md.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveUiAsset } from "../src/ui-assets";

let distDir: string | undefined;

afterEach(async () => {
  if (distDir) await rm(distDir, { recursive: true, force: true });
  distDir = undefined;
});

async function freshDist(): Promise<string> {
  const base = join(tmpdir(), `fern ui-assets test ${Date.now()}`);
  await mkdir(base, { recursive: true });
  distDir = await mkdtemp(join(base, "dist-"));
  await writeFile(join(distDir, "index.html"), "<p>hello fern</p>", "utf-8");
  await mkdir(join(distDir, "assets"), { recursive: true });
  await writeFile(join(distDir, "assets", "app.js"), "console.log(1)", "utf-8");
  return distDir;
}

test("serves index.html for /ui with a CSP header and nosniff", async () => {
  const dist = await freshDist();
  const res = await serveUiAsset("/ui", dist);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("hello fern");
  expect(res.headers.get("content-security-policy")).toContain(
    "default-src 'self'",
  );
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("serves a real nested asset for /ui/assets/app.js without a CSP header (non-HTML)", async () => {
  const dist = await freshDist();
  const res = await serveUiAsset("/ui/assets/app.js", dist);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("console.log(1)");
  expect(res.headers.get("content-type")).toContain("javascript");
  expect(res.headers.get("content-security-policy")).toBeNull();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
});

test("404s for an asset that doesn't exist, rather than falling back to index.html", async () => {
  const dist = await freshDist();
  const res = await serveUiAsset("/ui/assets/missing.js", dist);
  expect(res.status).toBe(404);
});

test("serves the 'not built yet' page with a CSP header when the dist dir doesn't exist at all", async () => {
  const neverCreated = join(tmpdir(), `fern-ui-assets-missing-${Date.now()}`);
  const res = await serveUiAsset("/ui", neverCreated);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("bun run build");
  expect(res.headers.get("content-security-policy")).toContain(
    "default-src 'self'",
  );
});

const TRAVERSAL_PATHS = [
  "/ui/../secret.txt",
  "/ui/../../secret.txt",
  "/ui/%2e%2e/secret.txt",
  "/ui/%2e%2e%2fsecret.txt",
  "/ui/..%2fsecret.txt",
  "/ui/assets/../../secret.txt",
  "/ui/..\\secret.txt",
  "/ui//etc/passwd",
];

for (const path of TRAVERSAL_PATHS) {
  test(`rejects path-traversal attempt: ${path}`, async () => {
    const dist = await freshDist();
    // Plant a real secret just outside dist/ — if any traversal variant
    // escapes the containment check, this is what it would read.
    const secretPath = join(dist, "..", "secret.txt");
    await writeFile(secretPath, "TOP SECRET", "utf-8");
    try {
      const res = await serveUiAsset(path, dist);
      if (res.status === 200) {
        expect(await res.text()).not.toContain("TOP SECRET");
      } else {
        expect(res.status).toBe(404);
      }
    } finally {
      await rm(secretPath, { force: true });
    }
  });
}

test("a Windows absolute-looking segment can't override the dist base", async () => {
  const dist = await freshDist();
  const res = await serveUiAsset("/ui/C:\\Windows\\system.ini", dist);
  expect(res.status).toBe(404);
});
