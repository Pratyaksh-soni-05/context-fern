// `fern tree`'s exact ASCII format — docs/design/blueprint/Install.dc.html's
// First-run board:
//
//   main ─┬─ auth-refactor  ●●●●●●●  active
//         ├─ docker-build   ●●●●
//         ├─ flaky-test     ●●●  merged
//         ├─ readme         ●●
//         └╌ strays         ○○○
//   roots: 0 memories
//
// Colors cycle the terminal palette from tokens.css, applied only when
// stdout is a TTY and NO_COLOR isn't set — a terminal concern, which is
// why this lives in the CLI, not the daemon (GET /tree returns plain data).

import { pluralize } from "@context-fern/core";

export interface TreeFrondInput {
  name: string;
  status: "active" | "resting" | "merged";
  leafletCount: number;
  colorIndex: number;
}

export interface TreeInput {
  stemName: string;
  fronds: TreeFrondInput[];
  strayCount: number;
  rootsCount?: number;
}

// tokens.css's --term-green/lake/iris/ochre, in palette order.
const TERM_COLORS = [
  "\x1b[38;2;141;184;134m", // --term-green #8DB886
  "\x1b[38;2;143;178;230m", // --term-lake  #8FB2E6
  "\x1b[38;2;183;164;242m", // --term-iris  #B7A4F2
  "\x1b[38;2;226;199;146m", // --term-ochre #E2C792
];
const TERM_EMBER = "\x1b[38;2;240;135;90m"; // --term-ember #F0875A — stray, always
const RESET = "\x1b[0m";

function colorFor(colorIndex: number): string {
  return TERM_COLORS[colorIndex % TERM_COLORS.length] ?? "";
}

function useColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function paint(text: string, color: string): string {
  return useColor() ? `${color}${text}${RESET}` : text;
}

function statusSuffix(status: TreeFrondInput["status"]): string {
  if (status === "active") return "  active";
  if (status === "merged") return "  merged";
  return "";
}

export function renderTree(input: TreeInput): string {
  const lines: string[] = [];
  const names = [...input.fronds.map((f) => f.name), "strays"];
  const nameWidth = Math.max(...names.map((n) => n.length)) + 2;
  const padding = " ".repeat(input.stemName.length + 2);

  input.fronds.forEach((frond, i) => {
    const prefix = i === 0 ? `${input.stemName} ─┬─ ` : `${padding}├─ `;
    const dots = "●".repeat(frond.leafletCount);
    const row = `${frond.name.padEnd(nameWidth)}${dots}${statusSuffix(frond.status)}`;
    lines.push(prefix + paint(row, colorFor(frond.colorIndex)));
  });

  const strayPrefix =
    input.fronds.length === 0 ? `${input.stemName} ─┬─ ` : `${padding}└╌ `;
  const strayDots = "○".repeat(input.strayCount);
  lines.push(
    strayPrefix +
      paint(`${"strays".padEnd(nameWidth)}${strayDots}`, TERM_EMBER),
  );

  lines.push(
    `roots: ${pluralize(input.rootsCount ?? 0, "memory", "memories")}`,
  );
  return lines.join("\n");
}
