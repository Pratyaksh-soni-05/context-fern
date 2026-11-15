// The heavy half of `fern init`: materializing `.fern/fern.db` (schema
// + migrations, zero sessions) and touching the recent-projects
// registry. Deliberately a SEPARATE module from `./init.ts`, which
// `fern-dispatch.ts` imports via the lightweight "@context-fern/cli/init"
// subpath so the zero-model-turn "/fern init" dispatch (reachable from
// every passive Claude Code hook script) never pulls in bun:sqlite —
// see packages/plugin-claude-code/test/scripts-import-graph.test.ts and
// docs/decisions.md. Only the real terminal `fern init` command (this
// package's own index.ts) calls this, after `runInit`.
//
// fern ui's Start screen only accepts a path once .fern/fern.db exists,
// and nothing before this point creates it — so the in-chat "/fern init"
// path (which skips this) leaves that screen unable to pick the project
// until the daemon opens it for real on the next normal prompt, which
// always happens anyway. A known, narrow gap, not a bug: see
// docs/decisions.md.
//
// touchRecentProject comes from the "./project-registry-file" subpath,
// not the package's main barrel: @context-fern/daemon's index.ts also
// re-exports startDaemon/createWarmEmbedder, which eagerly pulls in
// @context-fern/embed (@huggingface/transformers, onnxruntime-node) —
// a real compiled-binary crash on this command, which never embeds
// anything, confirmed in docs/decisions.md's PR 1 addendum. bun:sqlite
// via openFernStore below is fine; the embedder chain specifically
// isn't — see test/init-materialize-import-graph.test.ts.

import { basename, join } from "node:path";
import { CONFIG_DIR } from "@context-fern/core";
import { canonicalizeProjectPath } from "@context-fern/daemon/client";
import { touchRecentProject } from "@context-fern/daemon/project-registry-file";
import { openFernStore } from "@context-fern/store";

export async function materializeAndRegisterProject(
  projectPath: string,
): Promise<void> {
  const canonicalPath = canonicalizeProjectPath(projectPath);
  const fernDir = join(canonicalPath, CONFIG_DIR);
  const store = await openFernStore(fernDir);
  store.close();
  await touchRecentProject(canonicalPath, basename(canonicalPath), 0);
}
