// Three shapes redaction used to miss (docs/decisions.md): a credential name
// written as a quoted JSON key, an Authorization header whose value is a
// scheme word and a token (the generic key pattern stopped at the space and
// left the token), and a bare private_key. The scaling of the same shapes is in
// redact-scaling.test.ts. Values are plain words, not credential-shaped.

import { expect, test } from "bun:test";
import { quoteSnippetLines, redactSecrets } from "../src/reply-gist";

const SECRET = "hunter2zzz";

function expectNoSecret(input: string) {
  const out = redactSecrets(input);
  expect(out, input).not.toContain(SECRET);
  expect(out, input).toContain("[redacted]");
  // the same through the path that quotes restored snippets
  expect(quoteSnippetLines(input), input).not.toContain(SECRET);
}

test("JSON-style quoted keys lose their values: double and single quotes, with and without a space, and JSON inside a string", () => {
  for (const key of [
    "password",
    "passwd",
    "passphrase",
    "secret",
    "token",
    "api_key",
    "apiKey",
    "api-key",
    "client_secret",
    "access_token",
    "private_key",
    "credential",
    "authorization",
    "Authorization",
    "PASSWORD",
  ]) {
    expectNoSecret(`{"${key}": "${SECRET}"}`);
    expectNoSecret(`{"${key}":"${SECRET}"}`);
    expectNoSecret(`{ "${key}" : "${SECRET}" , "other": 1 }`);
    expectNoSecret(`{'${key}': '${SECRET}'}`);
    expectNoSecret(`{"${key}": ${SECRET}}`);
    expectNoSecret(`body = "{\\"${key}\\": \\"${SECRET}\\"}"`);
  }
});

test("the surrounding JSON that is not a secret survives", () => {
  const out = redactSecrets(
    `{"name": "build", "password": "${SECRET}", "ok": true}`,
  );
  expect(out).toContain('"name": "build"');
  expect(out).not.toContain(SECRET);
});

test("an Authorization header after a colon loses the whole value, whatever the scheme and however short the token", () => {
  for (const line of [
    `Authorization: Basic ${SECRET}`,
    `authorization: basic ${SECRET}`,
    `AUTHORIZATION:Basic ${SECRET}`,
    `Authorization = Basic ${SECRET}`,
    `Authorization: Bearer ${SECRET}`,
    `Authorization: Token ${SECRET}`,
    `Authorization: Digest ${SECRET}`,
    `Authorization: ${SECRET}`,
    `"Authorization": "Basic ${SECRET}"`,
    `'Authorization': 'Basic ${SECRET}'`,
    `curl -H "Authorization: Basic ${SECRET}" https://example.com`,
    `headers = {\\"Authorization\\": \\"Basic ${SECRET}\\"}`,
  ])
    expectNoSecret(line);
  // the old output kept the token: "Authorization=[redacted] abc"
  expect(redactSecrets("Authorization: Basic abc")).toBe(
    "Authorization=[redacted]",
  );
});

test("a quoted value goes whole, spaces and escaped quotes included (reviewer finding: the part after the first space used to stay)", () => {
  const tail = "leftoverword";
  for (const line of [
    `Authorization: "Basic ${SECRET} ${tail} more"`,
    `Authorization: "my secret ${SECRET} ${tail}"`,
    `Authorization: 'Bearer ${SECRET} ${tail}'`,
    `{"Authorization": "Bearer ${SECRET} ${tail}.x"}`,
    `password: "ab\\"cd ${SECRET} ${tail}"`,
    `{"password": "ab\\"cd ${SECRET} ${tail}"}`,
  ]) {
    const out = redactSecrets(line);
    expect(out, line).not.toContain(SECRET);
    expect(out, line).not.toContain(tail);
  }
});

test("a quoted value of a megabyte is still redacted (the regex engine gives up silently past its backtrack limit, which once left the whole input unredacted)", () => {
  const MB = 1024 * 1024;
  for (const [prefix, close] of [
    ['password: "', '"'],
    ["token='", "'"],
    ['Authorization: "Basic ', '"'],
    ['{"password": "', '"}'],
    ['password: \\"', '\\"'],
    ["api_key=\\'", "\\'"],
  ] as const) {
    const input = `${prefix}${`${SECRET} b `.repeat(MB / 12)}${close} tail`;
    const out = redactSecrets(input);
    expect(out.includes(SECRET), prefix).toBe(false);
  }
});

test("a quoted value with more than 1024 escapes still loses its first token (past the cap the match falls back to the unquoted form, by design)", () => {
  // only the first token is promised: later words of such a value can stay
  const input = `password: "${SECRET}${"\\n ".repeat(2000)}rest" tail`;
  expect(redactSecrets(input)).not.toContain(SECRET);
});

test("a quote that never closes does not swallow the lines after it", () => {
  const out = redactSecrets(
    'password: "x\nline two is kept\nline three too\nlater "end" more',
  );
  expect(out).toContain("line two is kept");
  expect(out).toContain("line three too");
});

test("text around an Authorization header is kept", () => {
  expect(
    redactSecrets(`sent Authorization: Basic ${SECRET} to the server`),
  ).toContain("to the server");
});

test("a bare private_key (and its spelled-out forms) loses its value", () => {
  for (const line of [
    `private_key = ${SECRET}`,
    `private_key=${SECRET}`,
    `private-key: ${SECRET}`,
    `PRIVATE_KEY=${SECRET}`,
    `export PRIVATE_KEY=${SECRET}`,
    `my_private_key: ${SECRET}`,
    `"private_key": "${SECRET}"`,
    `the private key is ${SECRET}`,
    `private key = ${SECRET}`,
  ])
    expectNoSecret(line);
});

test("ordinary prose and code that merely mention these words are left alone", () => {
  for (const text of [
    "the authorization flow is described in the docs",
    "rotate the private key every year",
    "a token bucket limits requests",
    "set the password field to required",
    "authorization header",
  ])
    expect(redactSecrets(text), text).not.toContain("[redacted]=");
  expect(redactSecrets("rotate the private key every year")).toBe(
    "rotate the private key every year",
  );
});
