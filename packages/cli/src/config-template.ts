// Renders DEFAULT_CONFIG as the snake_case TOML `loadFernConfig`
// (packages/store/src/config.ts) expects — `fern init`'s starting
// `.fern/config.toml`, fully commented so a user can see what each
// value does without reading the source.

import { DEFAULT_CONFIG } from "@context-fern/core";

export function renderDefaultConfigToml(): string {
  const t = DEFAULT_CONFIG.thresholds;
  const w = DEFAULT_CONFIG.weights;
  const c = DEFAULT_CONFIG.cues;
  const e = DEFAULT_CONFIG.escalation;
  const sp = DEFAULT_CONFIG.suggestionPrecision;
  const b = DEFAULT_CONFIG.briefs;

  const strList = (xs: readonly string[]) =>
    `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;

  return `# Context Fern router config — see docs/spec.md §5.
# Defaults here are the measured values from ReplayBench, not hand-tuned.

[thresholds]
continue_min = ${t.continueMin}
new_max = ${t.newMax}
return_min = ${t.returnMin}
stray_max_similarity = ${t.strayMaxSimilarity}
stray_max_prompt_words = ${t.strayMaxPromptWords}

[weights]
embedding = ${w.embedding}
file_overlap = ${w.fileOverlap}

[cues]
new = ${strList(c.new)}
return = ${strList(c.return)}
stray = ${strList(c.stray)}

[escalation]
# Stage 2 (LLM escalation) stays off unless you configure a model —
# this band is only consulted if you wire that up yourself.
low = ${e.low}
high = ${e.high}

# Minimum confidence for a "new"/"stray" suggestion to be shown at all.
# INTERIM — measured on spliced data, not natural labels yet. See
# docs/decisions.md.
[suggestion_precision]
new = ${sp.new}
stray = ${sp.stray}

# What a frond's brief file keeps next to each prompt in its Recent section.
# Text stays in the brief file only — never in fern.db. Set to false to keep
# prompts only: no reply gist is then written. The gist is the first line of
# the assistant's reply, at most 120 characters, secrets redacted, never
# file contents.
[briefs]
record_reply_gist = ${b.recordReplyGist}
`;
}
