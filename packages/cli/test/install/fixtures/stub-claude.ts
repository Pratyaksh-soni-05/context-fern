// A stand-in for the `claude` command, compiled into a real executable by the
// tests (stub-helpers.ts) so the code under test runs it through the same
// execFile path it uses for the real one. It records every call to the file
// named by STUB_CLAUDE_LOG and never touches any Claude configuration.
//
//   STUB_CLAUDE_LIST  what `plugin marketplace list --json` prints (default [])
//   STUB_CLAUDE_PLUGINS  what `plugin list --json` prints (default [])
//   STUB_CLAUDE_FAIL  comma-separated words; a call containing any of them exits 1

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const log = process.env.STUB_CLAUDE_LOG;
if (log) appendFileSync(log, `${JSON.stringify(args)}\n`);

if (args.join(" ") === "plugin list --json") {
  console.log(process.env.STUB_CLAUDE_PLUGINS ?? "[]");
  process.exit(0);
}
if (args.join(" ") === "plugin marketplace list --json") {
  console.log(process.env.STUB_CLAUDE_LIST ?? "[]");
  process.exit(0);
}
const failWords = (process.env.STUB_CLAUDE_FAIL ?? "")
  .split(",")
  .filter(Boolean);
if (failWords.some((w) => args.includes(w))) {
  console.error("stub claude: simulated failure");
  process.exit(1);
}
process.exit(0);
