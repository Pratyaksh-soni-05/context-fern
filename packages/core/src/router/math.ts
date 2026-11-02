// Pure numeric helpers for the router. No I/O, no randomness.

import { CLI_NAME } from "../brand";

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

// Phrases checked as substrings (word order/contraction matters, e.g.
// "were we" vs "we were") — checked before the single-word fallback
// below so multi-word references are caught even if a word in them
// (e.g. "far" in "so far") isn't meaningful alone.
const CONVERSATION_META_PHRASES = [
  "so far",
  "this session",
  "working on",
  "were we",
  "did we",
  "have we",
  "has it been",
];
// Single words checked after stripping punctuation — deliberately just
// the first-person-plural/session words themselves, not a broader
// "any question with 'we' in it" rule (which would also catch a real
// topic like "let's refactor our auth module").
const CONVERSATION_META_WORDS = new Set(["we", "our", "us", "session"]);

/**
 * True for a short question that's *about the conversation itself*
 * ("what were we working on?", "where were we?") rather than about any
 * real topic — these must never produce a `new`/`stray` suggestion,
 * however the scores happen to land, since there's no topic content to
 * evaluate in the first place. Requires question-form (reuses
 * `isShortQuestionForm`) specifically so this doesn't also catch a
 * short, non-question statement that happens to contain "we"/"our".
 * See docs/decisions.md.
 */
export function isConversationMetaQuestion(
  text: string,
  maxWords: number,
): boolean {
  if (!isShortQuestionForm(text, maxWords)) return false;
  const trimmed = text.trim().toLowerCase();
  if (CONVERSATION_META_PHRASES.some((p) => trimmed.includes(p))) return true;
  const words = trimmed.split(/\s+/).map((w) => w.replace(/[^a-z']/g, ""));
  return words.some((w) => CONVERSATION_META_WORDS.has(w));
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
  // Interrogatives — a question's own wording about what the fern is
  // doing is never the content of a new topic. Added after dogfooding
  // produced "what-were-working" as a proposed name for "what were we
  // working on?"; see docs/decisions.md.
  "what",
  "were",
  "was",
  "when",
  "where",
  "who",
  "whom",
  "which",
  "working",
  // Generic verbs — "make notes.txt" shouldn't name a frond "make"
  // any more than "fix the login bug" should drop the actual subject;
  // these carry no topic information on their own. Added after
  // dogfooding produced "make-notes-txt" (the verb plus a filename
  // split on its own dot — see the extension-stripping step below).
  "make",
  "add",
  "fix",
  "update",
]);

// A short list of common file extensions — stripped (with the
// preceding dot) before tokenizing, so "notes.txt" contributes the
// word "notes", not two unrelated-looking words "notes" and "txt".
// Deliberately short and extension-only (not a general dotted-word
// rule): stripping every "." would also mangle "e.g." or "3.5" in ways
// that don't matter here, since those were never going to produce a
// good name anyway.
const FILE_EXTENSION_RE =
  /\.(txt|md|json|ya?ml|toml|ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|hpp|css|html|sql|sh|log|csv|lock)\b/gi;

// A line that is itself a fern command — "/fern ..." or bare "fern ..."
// (e.g. a prompt that's just "fern new greetings") — names nothing about
// the user's actual topic; it's the mechanism, not the content. Built
// from CLI_NAME so a rename doesn't silently stop matching (CLAUDE.md:
// never hard-code the CLI name).
const ESCAPED_CLI_NAME = CLI_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FERN_COMMAND_LINE_RE = new RegExp(
  `^/?${ESCAPED_CLI_NAME}(?::${ESCAPED_CLI_NAME})?(?:\\s|$)`,
  "i",
);

/**
 * A short kebab-case slug of a prompt's key words — the proposed frond
 * name shown in a `new` suggestion's receipt and used when `/fern new`
 * accepts it with no name given. Deliberately simple: the first
 * `maxWords` non-stopword tokens, in order, not a ranked keyword
 * extraction — predictable beats clever for a name the user can always
 * override with `/fern new <name>`.
 *
 * Lines that are themselves a fern command — "/fern ..." or a bare
 * "fern ..." line, with or without a leading slash — are excluded from
 * the word pool; a plain "fern new greetings" prompt is just as much
 * the mechanism (not the topic) as "/fern new greetings" is. Returns
 * null, never a
 * generic placeholder like "topic", when no real content word survives;
 * callers must then ask the user for a name rather than invent one —
 * see docs/decisions.md.
 */
/**
 * A frond name's shape, wherever one is accepted from outside this
 * process: lowercase letters/digits/hyphens, 1-64 chars, no leading
 * hyphen. `proposeFrondName`'s own output always matches this; a
 * manually-typed name (`/fern new <name>`) does not get that guarantee
 * for free, and a frond name becomes part of a real filesystem path
 * (`.fern/fronds/<name>.md`) — reject anything else before it ever
 * reaches a file write, rather than trying to escape it. See
 * docs/decisions.md.
 */
export const FROND_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidFrondName(name: string): boolean {
  return FROND_NAME_RE.test(name);
}

export function proposeFrondName(text: string, maxWords = 3): string | null {
  const contentText = text
    .split("\n")
    .filter((line) => !FERN_COMMAND_LINE_RE.test(line.trim()))
    .join(" ")
    .replace(FILE_EXTENSION_RE, "");
  const words = (contentText.toLowerCase().match(/[a-z0-9']+/g) ?? [])
    .map((w) => w.replace(/'/g, ""))
    .filter((w) => w.length > 1 && !NAME_STOPWORDS.has(w));
  const slug = words.slice(0, maxWords).join("-");
  return slug.length > 0 ? slug : null;
}
