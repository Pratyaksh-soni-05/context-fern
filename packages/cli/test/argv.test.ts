import { expect, test } from "bun:test";
import { parseArgs } from "../src/argv";

test("parses a command with flag/value pairs", () => {
  const parsed = parseArgs([
    "route",
    "--replay",
    "stream.jsonl",
    "--config",
    "cfg.toml",
  ]);
  expect(parsed.command).toBe("route");
  expect(parsed.flags.replay).toBe("stream.jsonl");
  expect(parsed.flags.config).toBe("cfg.toml");
  expect(parsed.positional).toEqual([]);
});

test("a flag with no following value becomes a boolean-ish 'true'", () => {
  const parsed = parseArgs(["route", "--replay", "stream.jsonl", "--verbose"]);
  expect(parsed.flags.verbose).toBe("true");
});

test("positional arguments are collected separately from flags", () => {
  const parsed = parseArgs(["status", "extra-positional"]);
  expect(parsed.command).toBe("status");
  expect(parsed.positional).toEqual(["extra-positional"]);
});
