import { expect, test } from "bun:test";
import {
  cosineSimilarity,
  extractFileMentions,
  isConversationMetaQuestion,
  isShortQuestionForm,
  isValidFrondName,
  jaccard,
  parseStrayPrefix,
  proposeFrondName,
  runningMean,
} from "../../src/router/math";

test("cosineSimilarity: identical vectors are 1, orthogonal are 0, null is 0", () => {
  expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
  expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  expect(cosineSimilarity(null, [1, 0])).toBe(0);
  expect(cosineSimilarity([1, 0], null)).toBe(0);
  expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
});

test("cosineSimilarity: opposite vectors are -1", () => {
  expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
});

test("jaccard: empty vs empty is 0, disjoint is 0, identical is 1, partial overlap", () => {
  expect(jaccard([], [])).toBe(0);
  expect(jaccard(["a", "b"], ["c", "d"])).toBe(0);
  expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
  expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 6); // intersection 1, union 3
});

test("runningMean: first value is itself, folds in correctly over multiple calls", () => {
  const first = runningMean(null, 0, [2, 4]);
  expect(first).toEqual([2, 4]);

  const second = runningMean(first, 1, [4, 8]);
  expect(second).toEqual([3, 6]); // mean of [2,4] and [4,8]

  const third = runningMean(second, 2, [3, 0]);
  // mean of [2,4],[4,8],[3,0] = [3, 4]
  expect(third[0]).toBeCloseTo(3, 6);
  expect(third[1]).toBeCloseTo(4, 6);
});

test("extractFileMentions: finds repo-relative paths with recognized extensions only", () => {
  const text =
    "fix the bug in src/auth.ts and also check packages/core/src/index.ts, not just 1.2.3 or example.com";
  const found = extractFileMentions(text);
  expect(found).toContain("src/auth.ts");
  expect(found).toContain("packages/core/src/index.ts");
  expect(found).not.toContain("1.2.3");
  expect(found).not.toContain("example.com");
});

test("extractFileMentions: bare filenames with no directory are matched too", () => {
  expect(extractFileMentions("now edit login.ts to add the new field")).toEqual(
    ["login.ts"],
  );
});

test("extractFileMentions: no mentions returns empty array", () => {
  expect(extractFileMentions("what's a good name for a pet goldfish?")).toEqual(
    [],
  );
});

test("isShortQuestionForm: short question-shaped prompts are true", () => {
  expect(isShortQuestionForm("what's the weather like today?", 12)).toBe(true);
  expect(isShortQuestionForm("how do you reheat rice", 12)).toBe(true);
});

test("isShortQuestionForm: long prompts or statements are false", () => {
  const long =
    "what is the weather like today and tomorrow and the day after that as well, roughly";
  expect(isShortQuestionForm(long, 12)).toBe(false);
  expect(
    isShortQuestionForm("please fix the bug in the auth module now", 12),
  ).toBe(false);
});

test("isConversationMetaQuestion: true for realistic phrasings that refer to the conversation itself, not a real topic", () => {
  expect(isConversationMetaQuestion("what were we working on?", 12)).toBe(true);
  expect(isConversationMetaQuestion("where were we?", 12)).toBe(true);
  expect(isConversationMetaQuestion("what did we do so far?", 12)).toBe(true);
  expect(isConversationMetaQuestion("how's this session going?", 12)).toBe(
    true,
  );
  expect(isConversationMetaQuestion("what have we been doing?", 12)).toBe(true);
});

test("isConversationMetaQuestion: false for a real topic, even a short one, and false for a long prompt", () => {
  expect(isConversationMetaQuestion("let's refactor our auth module", 12)).toBe(
    false,
  );
  expect(isConversationMetaQuestion("what's the weather like today?", 12)).toBe(
    false,
  );
  const long =
    "what were we working on in this session so far, roughly speaking, over the last few days";
  expect(isConversationMetaQuestion(long, 12)).toBe(false);
});

test("parseStrayPrefix: '? ' at the very start strips the prefix and any extra whitespace", () => {
  expect(parseStrayPrefix("? side question about X")).toEqual({
    isStray: true,
    prompt: "side question about X",
  });
  expect(parseStrayPrefix("?   double space then prompt")).toEqual({
    isStray: true,
    prompt: "double space then prompt",
  });
});

test("parseStrayPrefix: '?' with no following space does not trigger", () => {
  expect(parseStrayPrefix("?.. not a stray")).toEqual({
    isStray: false,
    prompt: "?.. not a stray",
  });
  expect(parseStrayPrefix("?prompt with no space")).toEqual({
    isStray: false,
    prompt: "?prompt with no space",
  });
});

test("parseStrayPrefix: a bare '?' with nothing after it does not trigger", () => {
  expect(parseStrayPrefix("?")).toEqual({ isStray: false, prompt: "?" });
});

test("parseStrayPrefix: '?' not at the very start does not trigger", () => {
  expect(parseStrayPrefix(" ? leading space before the question mark")).toEqual(
    {
      isStray: false,
      prompt: " ? leading space before the question mark",
    },
  );
});

test("parseStrayPrefix: a real question is untouched", () => {
  expect(parseStrayPrefix("what's a good name for a pet goldfish?")).toEqual({
    isStray: false,
    prompt: "what's a good name for a pet goldfish?",
  });
});

test("proposeFrondName: picks the first non-stopword content words, kebab-cased", () => {
  expect(proposeFrondName("let's set up the docker build pipeline")).toBe(
    "set-docker-build",
  );
  expect(proposeFrondName("can you fix the flaky login test")).toBe(
    "flaky-login-test",
  );
});

test("proposeFrondName: caps at maxWords", () => {
  expect(proposeFrondName("refactor the authentication module today", 2)).toBe(
    "refactor-authentication",
  );
});

test("proposeFrondName: returns null (never a generic placeholder) when nothing but stopwords remain", () => {
  expect(proposeFrondName("can you do it for me")).toBeNull();
  expect(proposeFrondName("")).toBeNull();
});

test("proposeFrondName: skips lines that are themselves a slash command", () => {
  expect(proposeFrondName("/fern status\nfix the login bug")).toBe("login-bug");
  expect(proposeFrondName("/fern new something")).toBeNull();
});

test("proposeFrondName: skips lines that are a bare fern command, no leading slash", () => {
  expect(proposeFrondName("fern new greetings")).toBeNull();
  expect(proposeFrondName("fern new greetings\nfix the login bug")).toBe(
    "login-bug",
  );
  // "fernando" etc. must not false-match on the CLI name as a prefix.
  expect(proposeFrondName("fernando fixed the login bug")).toBe(
    "fernando-fixed-login",
  );
});

test("proposeFrondName: drops interrogatives, never proposing a name from a question's own wording", () => {
  expect(proposeFrondName("what were we working on")).toBeNull();
  expect(proposeFrondName("where was the docker build config")).toBe(
    "docker-build-config",
  );
});

test("proposeFrondName: strips punctuation and apostrophes", () => {
  expect(proposeFrondName("fix the broken token's refresh!!")).toBe(
    "broken-tokens-refresh",
  );
});

test("proposeFrondName: drops generic verbs and file extensions", () => {
  expect(proposeFrondName("make notes.txt")).toBe("notes");
  expect(proposeFrondName("add the config.yaml file")).toBe("config-file");
  expect(proposeFrondName("update readme.md please")).toBe("readme");
});

test("proposeFrondName's own output always satisfies isValidFrondName", () => {
  const name = proposeFrondName("fix the login bug in the auth module");
  expect(name).not.toBeNull();
  expect(isValidFrondName(name as string)).toBe(true);
});

test("isValidFrondName accepts a plain kebab-case slug", () => {
  expect(isValidFrondName("docker-build")).toBe(true);
  expect(isValidFrondName("a")).toBe(true);
  expect(isValidFrondName("a1-b2")).toBe(true);
});

test("isValidFrondName rejects path traversal and shell-meaningful names", () => {
  expect(isValidFrondName("../../etc/passwd")).toBe(false);
  expect(isValidFrondName("..")).toBe(false);
  expect(isValidFrondName("foo/bar")).toBe(false);
  expect(isValidFrondName("foo\\bar")).toBe(false);
  expect(isValidFrondName("x; rm -rf .")).toBe(false);
  expect(isValidFrondName("$(touch pwned)")).toBe(false);
  expect(isValidFrondName("")).toBe(false);
  expect(isValidFrondName("-leading-hyphen")).toBe(false);
  expect(isValidFrondName("UPPERCASE")).toBe(false);
});
