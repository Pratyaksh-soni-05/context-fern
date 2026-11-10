// Serves packages/ui/dist/* for GET /ui and /ui/* — the one daemon
// route reachable with no credential at all, since these files carry no
// project data (CSP keeps the page itself from doing anything a third
// party could exploit). Still path-traversal-hardened: the requested
// path ultimately reaches disk, and it's attacker-controlled. If dist/
// doesn't exist yet (the UI hasn't been built), /ui serves a plain
// instructional page instead of a crash or a confusing 404. See
// docs/decisions.md.

import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

// packages/daemon/src/ui-assets.ts -> packages/ui/dist
function defaultDistDir(): string {
  return resolve(import.meta.dir, "../../ui/dist");
}

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot);
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function securityHeaders(isHtml: boolean): Record<string, string> {
  return {
    ...(isHtml ? { "content-security-policy": CSP } : {}),
    "x-content-type-options": "nosniff",
  };
}

const NOT_BUILT_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>fern ui</title></head>
<body><p>fern ui hasn't been built yet. Run <code>bun run build</code> in packages/ui, then restart the daemon.</p></body>
</html>`;

/**
 * Resolves a requested /ui path to a real file under DIST_DIR, or null
 * if it doesn't exist or would escape DIST_DIR. Backslashes are treated
 * as path separators (a Windows filesystem does too, even though the
 * URL spec doesn't), and any leading absolute-looking segment (a
 * leading `/`, `//server/share`, or a drive letter like `C:`) is
 * stripped before resolving — `path.resolve()` treats an absolute
 * second argument as overriding the base entirely, which would
 * otherwise let a crafted path skip the containment check below rather
 * than merely fail it. The containment check (is the resolved path
 * still inside DIST_DIR) is what actually rejects `..`, encoded
 * traversal (`%2e%2e`, `%2f`), and every combination of the two, since
 * it doesn't matter how a path got outside — only whether it ended up
 * there.
 */
function resolveAssetPath(pathname: string, distDir: string): string | null {
  const withoutPrefix = pathname.replace(/^\/ui\/?/, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutPrefix);
  } catch {
    return null; // malformed percent-encoding
  }
  const normalizedSeparators = decoded.replace(/\\/g, "/");
  const stripped = normalizedSeparators.replace(/^([a-zA-Z]:)?\/+/, "");
  const relPath = stripped || "index.html";
  const resolved = resolve(distDir, relPath);
  const distWithSep = distDir.endsWith(sep) ? distDir : distDir + sep;
  if (resolved !== distDir && !resolved.startsWith(distWithSep)) return null;
  return resolved;
}

/** `distDir` defaults to the real packages/ui/dist; tests override it to exercise "not built yet" and traversal cases against a controlled directory, independent of whatever actually happens to be built in this checkout. */
export async function serveUiAsset(
  pathname: string,
  distDir: string = defaultDistDir(),
): Promise<Response> {
  if (!existsSync(distDir)) {
    return new Response(NOT_BUILT_HTML, { headers: securityHeaders(true) });
  }

  const resolved = resolveAssetPath(pathname, distDir);
  if (!resolved || !existsSync(resolved) || !statSync(resolved).isFile()) {
    return new Response("not found", { status: 404 });
  }

  const isHtml = resolved.endsWith(".html");
  return new Response(Bun.file(resolved), {
    headers: {
      "content-type": contentTypeFor(resolved),
      ...securityHeaders(isHtml),
    },
  });
}
