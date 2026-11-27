export const PRODUCT_NAME = "Context Fern";
export const CLI_NAME = "fern";
export const CONFIG_DIR = ".fern";
export const ENV_PREFIX = "FERN_";
export const NPM_PACKAGE = "context-fern";
export const PYPI_PACKAGE = "context-fern";

/**
 * The GitHub account this repo lives under today — the one thing to
 * change when the repo transfers to an organisation (see
 * docs/decisions.md's "install-names" entry on why no launch install
 * command may name it). Every future reference to the repo's GitHub
 * location (release URLs, a Homebrew tap, a marketplace add command —
 * none of them launch paths; see the same entry) must import this
 * instead of hardcoding the owner slug a second place.
 */
export const REPO_OWNER = "Pratyaksh-soni-05";
export const REPO_URL = `https://github.com/${REPO_OWNER}/context-fern`;

/**
 * The unambiguous binary name hooks, slash commands, and the MCP server
 * invoke — `fern` collides with the real, already-published Fern API
 * docs CLI, also literally called `fern`. Both names ship and both stay
 * usable interactively; only the plugin's own machine-invoked entries
 * (packages/plugin-claude-code/hooks/hooks.json,
 * .claude-plugin/plugin.json, commands/fern.md) use this one. See
 * docs/decisions.md's Phase-4 PR 2 entry.
 */
export const CLI_BINARY_NAME = "context-fern";

/**
 * A hardcoded, compile-safe version string — never read from
 * package.json at runtime (that doesn't survive `bun build --compile`,
 * see docs/decisions.md's PR 1 spike entries). Bump this together with
 * packages/plugin-claude-code/.claude-plugin/plugin.json's own
 * "version" field; `context-fern hook <event>` compares the two and
 * prints a one-line, non-blocking receipt on a mismatch rather than
 * silently running with mismatched code. Until PR 3's release pipeline
 * stamps a real per-build version in, this is the only version either
 * side has.
 */
export const CLI_VERSION = "0.1.0-rc.2";
