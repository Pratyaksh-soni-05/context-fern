// The one-line gist of an assistant reply that Recent keeps next to its
// prompt, so a restore after /clear can say what a turn led to and not
// only what was asked. Pure: text in, text out. Deliberately
// conservative — it keeps the first line of prose, at most
// REPLY_GIST_MAX characters, and never anything that looks like code or
// file contents; a candidate secret is replaced, never kept. The gist
// lives in the brief file only, never in fern.db. See docs/decisions.md
// (2026-11-17).

export const REPLY_GIST_MAX = 120;

const REDACTED = "[redacted]";

/** Ordered, deliberately broad: a false positive costs a few characters of a gist, a miss leaks a credential into a markdown file. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g,
  /\beyJ[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\b/g, // JWT: header up to 1 KB, payload and signature up to 4 KB each; a longer part is still caught on its own as a long mixed token
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style keys
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // user:pass@ in a URL; the scheme is bounded, user and password are not (both stop at the next "/", and every start needs "://")
  /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe
  /\b(?:npm|glpat|hf|dop_v1|pypi)[_-][A-Za-z0-9_-]{16,}/g, // npm, GitLab, Hugging Face, DigitalOcean, PyPI
  /\bSG\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\bya29\.[A-Za-z0-9._-]{16,}/g, // Google OAuth
  // "the password is hunter2" / "token was abc"
  /\b(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|credentials?)\s+(?:is|was|are|=)\s+\S+/gi,
  // key = value / key: value, where the key names a credential: keep the key, drop the value (a quoted value goes whole).
  // No pattern in front of the keyword: the match starts at it, so a name of any length before it still works. A suffix up to 128 characters.
  /((?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|credential|authorization)[A-Za-z0-9_-]{0,128})\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
];

/** Any long unbroken mixed token (hex digests, base64 blobs, random ids). The digit-and-letter test is in the replacer, not a lookahead, so there is nothing to bound. */
const LONG_TOKEN = /\b[A-Za-z0-9+/_-]{32,}={0,2}/g;

/**
 * Linear on long pasted blobs: a 60 KB line of "a-" repeated once took ~16 s
 * under unbounded lookaheads and prefixes. The only bounds left are the
 * three JWT parts (header 1 KB, payload and signature 4 KB each; a longer
 * part with both a digit and a letter is still caught on its own as a long
 * mixed token), the URL scheme (30) and a credential name's suffix (128);
 * see docs/decisions.md (2026-11-17).
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, key: unknown) =>
      typeof key === "string" && key.length > 0 && match.startsWith(key)
        ? `${key}=${REDACTED}`
        : REDACTED,
    );
  }
  return out.replace(LONG_TOKEN, (match) =>
    /\d/.test(match) && /[A-Za-z]/.test(match) ? REDACTED : match,
  );
}

/**
 * Cheap heuristic for a line aimed at the model rather than describing
 * work: "ignore previous instructions", role markers, instruction tags,
 * "you must ...", "from now on ...". Not a defence on its own — everything
 * restored is also quoted and introduced as not-instructions — just a
 * filter for the obvious cases. Kept narrow on purpose: a false positive
 * drops real text, so ordinary words ("always run tests", a `<User>`
 * component, "User: ...") are left alone.
 */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b.{0,40}\b(?:previous|prior|above|earlier|everything|all|your)\b.{0,30}\b(?:instructions?|prompts?|rules?|guidelines?|constraints?|said|written)\b/i,
  /\b(?:ignore|disregard)\s+(?:everything|all)\s+(?:above|before|earlier|prior)\b/i,
  /^\W*(?:system|assistant)\s*:/i,
  // lowercase or UPPERCASE tags, with spaces or attributes; PascalCase (<System>) is a component name, left alone
  /<\s*\/?\s*(?:system|instructions?|assistant)\b[^>]{0,200}>/,
  /<\s*\/?\s*(?:SYSTEM|INSTRUCTIONS?|ASSISTANT)\b[^>]{0,200}>/,
  /\b(?:you (?:must|are now|need to)|from now on|new instructions?|do not (?:tell|mention|reveal|inform)|act as (?:an?|the) )\b/i,
  /^\W*(?:important|attention|note to (?:the )?(?:ai|assistant|model))\s*:/i,
  /\b(?:when you (?:read|see) this|if you are (?:an? )?(?:ai|llm|assistant|model|claude))\b/i,
];

/**
 * What the filter reads, not what is kept: compatibility-normalised
 * (fullwidth letters become ASCII), invisible format characters (zero-width
 * space and joiners, bidi marks) removed, and every kind of whitespace
 * (no-break space included) turned into one plain space.
 */
function normalizeForFilter(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ");
}

export function looksLikeInstruction(text: string): boolean {
  const seen = normalizeForFilter(text);
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(seen));
}

/** Redact, flatten to one line, cap at REPLY_GIST_MAX characters. Idempotent, so the hook and the daemon can both apply it. Null when nothing is left, or when the line reads as an instruction to the model (a gist describes work; it never directs the reader). */
export function sanitizeReplyGist(text: string): string | null {
  // A gist is at most 120 characters; never feed the regexes a whole reply line.
  const oneLine = redactSecrets(text.slice(0, 4000))
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length === 0) return null;
  if (looksLikeInstruction(oneLine)) return null;
  if (oneLine.length <= REPLY_GIST_MAX) return oneLine;
  return `${oneLine.slice(0, REPLY_GIST_MAX - 1).trimEnd()}…`;
}

/**
 * The first line of prose in an assistant reply, as a gist. Null when the
 * reply opens with code (a fence, an indented block, a diff header) —
 * that would be file contents, not a description — or has no text.
 */
export function extractReplyGist(message: string): string | null {
  const firstLine = message
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  if (firstLine === undefined) return null;
  const trimmed = firstLine.trim();
  if (/^(```|~~~)/.test(trimmed)) return null;
  if (/^( {4}|\t)/.test(firstLine)) return null;
  if (/^(diff --git|index [0-9a-f]+\.\.|@@ |\+\+\+ |--- )/.test(trimmed)) {
    return null;
  }
  const prose = trimmed
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^[-*]\s+/, "");
  return sanitizeReplyGist(prose);
}

const REMOVED = "[removed: read like an instruction]";
/** Every line break a reader may honour, not only LF: CR, LS, PS, NEL, VT, FF. */
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029\u0085\v\f]/;
/** Applied after redaction, so a cut can never leave half a secret: well above the ~6.6 KB a restore can use. */
const LINE_MAX_CHARS = 10_000;

/**
 * Recorded text as the model sees it on restore: every non-empty line
 * redacted, any line that reads like an instruction replaced by a marker,
 * and each prefixed with "> ". Applied to every section of a brief, not
 * only Recent: Goal is a pasted prompt and Notes, Decided and Open can
 * carry pasted text too, so nothing recorded is presented as trusted.
 */
export function quoteSnippetLines(text: string): string {
  // Redact the whole text first so a multi-line private key is one match
  // and a secret is never cut in half by the line cap; then split on every
  // line break, so a forged heading after a lone CR starts its own quoted
  // line, and cap each line.
  return redactSecrets(text)
    .split(LINE_BREAKS)
    .map((line) =>
      line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line,
    )
    .filter((line) => line.trim().length > 0)
    .map((line) => `> ${looksLikeInstruction(line) ? REMOVED : line}`)
    .join("\n");
}
