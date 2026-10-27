// Pure numeric helpers for the router. No I/O, no randomness.

export function cosineSimilarity(
  a: ArrayLike<number> | null | undefined,
  b: ArrayLike<number> | null | undefined,
): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) {
    if (setB.has(x)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Folds `next` into a running mean that has already averaged `count` vectors. */
export function runningMean(
  existing: readonly number[] | null,
  count: number,
  next: ArrayLike<number>,
): number[] {
  if (!existing || count <= 0) return Array.from(next);
  const out = new Array<number>(existing.length);
  for (let i = 0; i < existing.length; i++) {
    out[i] =
      ((existing[i] as number) * count + (next[i] as number)) / (count + 1);
  }
  return out;
}

const FILE_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "json",
  "md",
  "toml",
  "yml",
  "yaml",
  "css",
  "scss",
  "html",
  "sh",
  "ps1",
  "rs",
  "go",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "sql",
  "lock",
  "txt",
  "ini",
  "cfg",
];

// Requires a recognized extension (same allowlist trade-off as
// bench/transcript.py's command-path heuristic, to avoid "1.2.3" or
// "example.com"), but — unlike that heuristic — a path separator is
// optional: prompts routinely say "edit login.ts" with no directory at
// all, and that bare mention is exactly the file-overlap signal we need.
const FILE_MENTION_RE = new RegExp(
  `(?:\\.{1,2}/)?(?:[\\w.-]+[/\\\\])*[\\w.-]+\\.(?:${FILE_EXTENSIONS.join("|")})\\b`,
  "g",
);

export function extractFileMentions(text: string): string[] {
  const matches = text.match(FILE_MENTION_RE) ?? [];
  return Array.from(new Set(matches));
}

const QUESTION_WORDS = [
  "what",
  "how",
  "why",
  "when",
  "where",
  "who",
  "which",
  "is",
  "does",
  "can",
  "could",
  "would",
];

export function isShortQuestionForm(text: string, maxWords: number): boolean {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > maxWords) return false;
  if (trimmed.endsWith("?")) return true;
  const first = words[0]?.toLowerCase().replace(/[^a-z]/g, "");
  return QUESTION_WORDS.includes(first ?? "");
}

// spec §7's "?" prefix: a lone "?" immediately followed by a space, at
// character 0 of the raw (untrimmed) prompt. Deliberately narrow — "?.."
// and a bare "?" with nothing after it are real questions, not the stray
// shorthand, so they must NOT match just because they start with "?".
const STRAY_PREFIX = "? ";

export function parseStrayPrefix(text: string): {
  isStray: boolean;
  prompt: string;
} {
  if (!text.startsWith(STRAY_PREFIX)) {
    return { isStray: false, prompt: text };
  }
  return {
    isStray: true,
    prompt: text.slice(STRAY_PREFIX.length).replace(/^\s+/, ""),
  };
}

const NAME_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "with",
  "and",
  "or",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "let",
  "lets",
  "please",
  "can",
  "could",
  "would",
  "should",
  "you",
  "i",
  "we",
  "my",
  "our",
  "me",
  "us",
  "do",
  "does",
  "did",
  "just",
  "now",
  "also",
  "need",
  "want",
  "like",
  "about",
  "up",
  "down",
  "out",
  "off",
  "into",
  "onto",
  "over",
  "switching",
  "switch",
  "moving",
  "back",
]);

const DEFAULT_PROPOSED_NAME = "topic";

/**
 * A short kebab-case slug of a prompt's key words — the proposed frond
 * name shown in a `new` suggestion's receipt and used when `/fern new`
 * accepts it with no name given. Deliberately simple: the first
 * `maxWords` non-stopword tokens, in order, not a ranked keyword
 * extraction — predictable beats clever for a name the user can always
 * override with `/fern new <name>`.
 */
export function proposeFrondName(text: string, maxWords = 3): string {
  const words = (text.toLowerCase().match(/[a-z0-9']+/g) ?? [])
    .map((w) => w.replace(/'/g, ""))
    .filter((w) => w.length > 1 && !NAME_STOPWORDS.has(w));
  const slug = words.slice(0, maxWords).join("-");
  return slug.length > 0 ? slug : DEFAULT_PROPOSED_NAME;
}
