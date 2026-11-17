// Every secret pattern still redacts a realistic secret at its maximum
// plausible length, and one far past any bound the patterns carry. Secrets
// are assembled at runtime from a deterministic filler so no credential-
// shaped literal sits in the repo (synthetic, per CLAUDE.md privacy rules).

import { expect, test } from "bun:test";
import { quoteSnippetLines, redactSecrets } from "../src/reply-gist";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** n characters from the alphabet, deterministic (a fixed stride), no randomness. */
function filler(n: number, alphabet = ALNUM, seed = 7): string {
  let out = "";
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 31 + 17) % 9973;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

/** The secret body must be gone; what is left may only be a marker and plain words. */
function expectGone(out: string, ...fragments: string[]) {
  for (const f of fragments) expect(out).not.toContain(f);
  expect(out).toContain("[redacted]");
}

const jwt = (header: number, payload: number, sig: number) =>
  `eyJ${filler(header, B64URL, 1)}.${filler(payload, B64URL, 2)}.${filler(sig, B64URL, 3)}`;

test("a private key of about 3 KB, many lines, is redacted whole and the text before it is kept", () => {
  const lines = [];
  for (let i = 0; i < 47; i++) lines.push(filler(64, B64, i + 1));
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${lines.join("\n")}\n${filler(20, B64, 99)}==\n-----END RSA PRIVATE KEY-----`;
  expect(pem.length).toBeGreaterThan(3000);

  const out = quoteSnippetLines(`deploy notes\n${pem}`);
  expect(out).toContain("> deploy notes");
  expect(out).toContain("[redacted]");
  for (const line of lines) expect(out).not.toContain(line.slice(0, 40));
  expect(redactSecrets(pem)).toBe("[redacted]");
});

test("a private key survives CR line breaks and a 20 KB body too", () => {
  const body = filler(20_000, B64, 5);
  const pem = `-----BEGIN PRIVATE KEY-----\r${body}\r-----END PRIVATE KEY-----`;
  expectGone(quoteSnippetLines(pem), body.slice(0, 40));
});

test("a JWT of about 2 KB is redacted whole; so is one with 12 KB parts, past the 8 KB bound", () => {
  const token = jwt(40, 1900, 342);
  expect(token.length).toBeGreaterThan(2000);
  expect(redactSecrets(`Authorization header was ${token} ok`)).toBe(
    "Authorization header was [redacted] ok",
  );

  const huge = jwt(40, 12_000, 342);
  const out = redactSecrets(`x ${huge} y`);
  expectGone(out, huge.slice(40, 80), huge.slice(-60));
});

test.each([
  [
    "an OpenAI/Anthropic-style key, 200 characters",
    `sk-${filler(200, B64URL)}`,
  ],
  ["the same key, 5000 characters", `sk-${filler(5000, B64URL)}`],
  [
    "a fine-grained GitHub token, 82 characters",
    `github_pat_${filler(82, ALNUM)}`,
  ],
  ["a classic GitHub token, 36 characters", `ghp_${filler(36, ALNUM)}`],
  ["a GitHub token, 255 characters", `ghs_${filler(255, ALNUM)}`],
  [
    "an AWS access key id, 20 characters",
    `AKIA${filler(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")}`,
  ],
  ["a Google API key, 39 characters", `AIza${filler(35, B64URL)}`],
  ["a Slack token, 60 characters", `xoxb-${filler(55, `${ALNUM}-`)}`],
  ["a Stripe live key, 107 characters", `sk_live_${filler(99, ALNUM)}`],
  ["an npm token, 40 characters", `npm_${filler(36, ALNUM)}`],
  ["a GitLab token, 26 characters", `glpat-${filler(20, B64URL)}`],
  ["a Hugging Face token, 37 characters", `hf_${filler(34, ALNUM)}`],
  ["a PyPI token, 180 characters", `pypi-${filler(175, B64URL)}`],
  [
    "a SendGrid key, 69 characters",
    `SG.${filler(22, B64URL)}.${filler(43, B64URL)}`,
  ],
  ["a Google OAuth token, 200 characters", `ya29.${filler(195, B64URL)}`],
])("%s is redacted", (_name, secret) => {
  const out = redactSecrets(`here: ${secret} done`);
  expectGone(out, secret.slice(secret.length > 24 ? 12 : 4, 24));
  expect(out.startsWith("here: ")).toBe(true);
  expect(out.endsWith(" done")).toBe(true);
});

test.each([
  [
    "Bearer, a 2000-character opaque token",
    `Bearer ${filler(2000, `${B64URL}.~`)}`,
  ],
  ["Bearer, 20 characters", `Bearer ${filler(20, ALNUM)}`],
  ["Basic, 400 characters of base64", `Basic ${filler(398, B64)}==`],
])("an authorization header: %s", (_name, header) => {
  expectGone(redactSecrets(`Authorization: ${header}`), header.slice(10, 40));
});

test.each([
  ["a 128-character password", filler(128, ALNUM)],
  [
    "a 3000-character password, letters only, past any bound",
    filler(3000, LETTERS),
  ],
])(
  "a connection string with %s has the password removed",
  (_name, password) => {
    const out = redactSecrets(
      `DATABASE_URL=postgres://app_user:${password}@db.internal:5432/app`,
    );
    expect(out).not.toContain(password.slice(0, 20));
  },
);

test("a connection string with a 300-character user part is redacted", () => {
  const user = filler(300, LETTERS, 3);
  const out = redactSecrets(`mongodb://${user}:pw${filler(10)}@host/db`);
  expect(out).not.toContain(user.slice(0, 20));
});

test.each([
  [
    "a name of 52 characters before the keyword",
    `${filler(52, LETTERS)}_PASSWORD=hunter2`,
    "hunter2",
  ],
  [
    "a name of 400 characters before the keyword",
    `${filler(400, LETTERS)}_PASSWORD=hunter2`,
    "hunter2",
  ],
  [
    "a suffix of 100 characters after the keyword",
    `password${filler(100, LETTERS)}=hunter2`,
    "hunter2",
  ],
  [
    "a quoted value of 600 characters",
    `api_key: "${filler(600, ALNUM)}"`,
    'api_key: "A',
  ],
  [
    "a JSON-style secret",
    `{"client_secret": "${filler(64, ALNUM)}"}`,
    'client_secret": "A',
  ],
  [
    "the sentence form",
    `the password is ${filler(300, ALNUM)}`,
    "password is A",
  ],
])(
  "a credential-named key with %s keeps the key and drops the value",
  (_name, text, leaked) => {
    const out = redactSecrets(text);
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(leaked);
  },
);

test("a credential-named key with a suffix past 128 characters still loses a long secret value, through the token pattern", () => {
  const secret = filler(48, ALNUM, 11);
  const out = redactSecrets(`password${filler(200, LETTERS)}=${secret}`);
  expect(out).not.toContain(secret);
});

test.each([
  ["a SHA-256 digest, 64 hex characters", filler(64, "0123456789abcdef")],
  ["a 512-character base64 blob", filler(512, B64)],
  ["a 3000-character base64 blob", filler(3000, B64)],
  [
    "a blob whose first digit is far into the run",
    `${filler(600, LETTERS)}7${filler(40, LETTERS)}`,
  ],
])("a long mixed token (%s) is redacted", (_name, token) => {
  expectGone(redactSecrets(`id ${token} end`), token.slice(0, 30));
});

test("a 31-character token is left alone (below the threshold), a 32-character mixed one is not", () => {
  const short = filler(31, "0123456789abcdef");
  expect(redactSecrets(short)).toBe(short);
  expect(redactSecrets(filler(32, "0123456789abcdef"))).toBe("[redacted]");
  // a long run of one kind of character is a word or a bar of dashes, not a secret
  expect(redactSecrets(filler(60, LETTERS))).toBe(filler(60, LETTERS));
});

test("the line cap never leaves half a secret: a key straddling the 10,000th character is redacted first", () => {
  const key = `sk-ant-api03-${filler(100, B64URL)}`;
  const line = `${"x ".repeat(4990)}${key}`; // the key starts a few characters before the cut
  const out = quoteSnippetLines(line);
  expect(out).not.toContain("sk-ant");
  expect(out).not.toContain(key.slice(13, 30));
});
