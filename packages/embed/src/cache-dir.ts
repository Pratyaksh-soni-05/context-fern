import { homedir, platform } from "node:os";
import { join } from "node:path";
import { CLI_NAME } from "@context-fern/core";

/**
 * Where the embedding model is cached — the OS user cache dir, never the
 * repo or the project's .fern/ directory. embed configures the model
 * library's own cache dir to point here; embed's application code never
 * writes project data itself (see CLAUDE.md's architecture rules).
 *
 * `homeDir` defaults to the real home dir but is overridable — tests
 * pass a fake one explicitly rather than relying on `os.homedir()`
 * falling through to the real one; see docs/decisions.md.
 */
export function modelCacheDir(homeDir: string = homedir()): string {
  switch (platform()) {
    case "win32":
      return join(
        process.env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local"),
        CLI_NAME,
        "models",
      );
    case "darwin":
      return join(homeDir, "Library", "Caches", CLI_NAME, "models");
    default:
      return join(
        process.env.XDG_CACHE_HOME ?? join(homeDir, ".cache"),
        CLI_NAME,
        "models",
      );
  }
}
