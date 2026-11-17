// redactSecrets and quoteSnippetLines must stay linear on adversarial pasted
// text: restore runs them synchronously inside the daemon's /status, and the
// hook gives up after 300 ms. Each shape is a unit repeated to 60 KB,
// 240 KB and 1 MB. A case fails if 1 MB takes over 1.5 s, or if a 4x larger
// input costs far more than 4x the time. The margins are generous on
// purpose (best of three, and ratios are only judged once the smaller run is
// long enough to measure) so a busy CI runner does not flake; a real
// quadratic is 16x and blows through both.

import { expect, test } from "bun:test";
import { quoteSnippetLines, redactSecrets } from "../src/reply-gist";

const KB = 1024;
const SIZES = [60 * KB, 240 * KB, 1024 * KB] as const;
const ABSOLUTE_MAX_MS = 1500;
/** 4x the input may cost at most this many times the time (linear is 4). */
const MAX_GROWTH_PER_4X = 8;
/** Below this, a timing is noise; the ratio is not judged. */
const MEASURABLE_MS = 30;

const NL = String.fromCharCode(10);

const SHAPES: readonly string[] = [
  "eyJ-",
  "eyJa-",
  "eyJaaaaaaaaa.",
  "eyJaaaaaaaaa.bbbbbbbbb ",
  // many starts that reach a dot, each followed by a long dotless second part
  `${"eyJ-".repeat(256)}.${"a".repeat(9000)}`,
  `eyJaaaaaaaaa.${"b-".repeat(5000)}`,
  "Bearer ",
  "Basic ",
  "sk-",
  "password ",
  "password is ",
  "password=",
  "password= ",
  "password = ",
  "password=" + NL,
  "token:",
  'token: "',
  "api_key: '",
  `password${" ".repeat(200)}`,
  "a://b:",
  "://",
  "@",
  "a://b:@",
  "x://u:",
  "http://a:b@",
  "-----BEGIN ",
  "-----BEGIN A",
  "-----BEGIN RSA ",
  "-----BEGIN PRIVATE KEY-----",
  "ghp_",
  "xoxb-",
  "npm_",
  "AKIA",
  "SG.",
  "ya29.",
  "a-",
  "a/",
  "a+",
  "a1-",
  "a",
  "1a",
  " ",
  NL,
  `x${NL}`,
];

function repeatTo(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length));
}

function bestOfThree(fn: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

for (const [name, run] of [
  ["redactSecrets", (text: string) => redactSecrets(text)],
  ["quoteSnippetLines", (text: string) => quoteSnippetLines(text)],
] as const) {
  test(`${name} scales linearly: ${SHAPES.length} adversarial shapes at 60 KB, 240 KB and 1 MB`, () => {
    const failures: string[] = [];
    for (const unit of SHAPES) {
      const times = SIZES.map((size) => {
        const text = repeatTo(unit, size);
        return bestOfThree(() => run(text));
      });
      const label = JSON.stringify(unit.slice(0, 30));
      if ((times[2] ?? 0) > ABSOLUTE_MAX_MS) {
        failures.push(`${label}: 1 MB took ${times[2]?.toFixed(0)} ms`);
      }
      for (let i = 0; i + 1 < SIZES.length; i++) {
        const small = times[i] ?? 0;
        const large = times[i + 1] ?? 0;
        const sizeRatio = (SIZES[i + 1] ?? 1) / (SIZES[i] ?? 1);
        // 60 KB -> 240 KB is 4x; 240 KB -> 1 MB is ~4.3x.
        const allowed = MAX_GROWTH_PER_4X * (sizeRatio / 4);
        if (small >= MEASURABLE_MS && large / small > allowed) {
          failures.push(
            `${label}: ${(SIZES[i] ?? 0) / KB} KB ${small.toFixed(0)} ms -> ${(SIZES[i + 1] ?? 0) / KB} KB ${large.toFixed(0)} ms (${(large / small).toFixed(1)}x for ${sizeRatio.toFixed(1)}x the input)`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
}
