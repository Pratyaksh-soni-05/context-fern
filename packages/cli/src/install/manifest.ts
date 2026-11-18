// The install manifest: exactly what `context-fern init` put where, with
// hashes, so `fern uninstall` (the next PR) can remove precisely that and
// nothing else. Written atomically (temp file, then rename). Records
// paths and hashes only — no project data, no content.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { discardOwnTemp } from "./safe-remove";

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  role: "binary" | "sidecar" | "model";
}

export interface PendingDelete {
  path: string;
  sha256: string;
}

export type PathEdit =
  | {
      kind: "windows-user-path";
      /** The directory added to the user PATH. */
      added: string;
      /** Registry value kind that was kept, e.g. ExpandString. */
      valueKind: string;
    }
  | {
      kind: "shell-rc";
      file: string;
      /** The marker lines that bracket the block we appended. */
      beginMarker: string;
      endMarker: string;
    };

export interface PluginRecord {
  method: "claude-cli" | "manual" | "skipped";
  marketplace?: string;
  plugin?: string;
}

export interface InstallManifest {
  schema: 1;
  version: string;
  installedAt: string;
  platform: string;
  prefix: string;
  binDir: string;
  shareDir: string;
  files: ManifestFile[];
  /** Files init moved aside (a running program held the old one) and could not delete yet. Deleted later only if they still match this hash. */
  pendingDeletes?: PendingDelete[];
  pathEdit: PathEdit | null;
  plugin: PluginRecord | null;
}

export { sha256File } from "./hash";

export async function readManifest(
  path: string,
): Promise<InstallManifest | null> {
  try {
    const parsed = JSON.parse(
      await readFile(path, "utf-8"),
    ) as Partial<InstallManifest>;
    if (parsed.schema !== 1 || !Array.isArray(parsed.files)) return null;
    return parsed as InstallManifest;
  } catch {
    return null;
  }
}

export async function writeManifest(
  path: string,
  manifest: InstallManifest,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Exclusive create ("wx"): never truncates or follows anything already at
  // that name, and the temp file is removed on failure only if this call
  // created it.
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  let created = false;
  try {
    await writeFile(
      tmp,
      `${JSON.stringify(manifest, null, 2)}
`,
      {
        encoding: "utf-8",
        flag: "wx",
      },
    );
    created = true;
    await rename(tmp, path);
  } catch (err) {
    if (created) await discardOwnTemp(tmp);
    throw err;
  }
}
