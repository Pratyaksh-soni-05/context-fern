import { homedir, platform } from "node:os";
import { join } from "node:path";
import { CLI_NAME } from "@context-fern/core";

/**
 * Where the embedding model is cached — the OS user cache dir, never the
 * repo or the project's .fern/ directory. embed configures the model
 * library's own cache dir to point here; embed's application code never
 * writes project data itself (see CLAUDE.md's architecture rules).
 */
export function modelCacheDir(): string {
  const home = homedir();
  switch (platform()) {
    case "win32":
      return join(
        process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
        CLI_NAME,
        "models",
      );
    case "darwin":
      return join(home, "Library", "Caches", CLI_NAME, "models");
    default:
      return join(
        process.env.XDG_CACHE_HOME ?? join(home, ".cache"),
        CLI_NAME,
        "models",
      );
  }
}
