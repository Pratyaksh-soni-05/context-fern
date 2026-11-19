// The cleanup helper must not depend on any PowerShell cmdlet. On the GitHub
// Windows runner the first version's `Get-FileHash` was "not recognized" in the
// Windows PowerShell child (the default shell there is PowerShell 7, which
// sets PSModulePath for its own modules), and the helper silently did nothing.
// The script uses only the language and .NET so nothing about the environment
// it inherits can take a command away. This runs on every platform.

import { expect, test } from "bun:test";
import {
  DELETE_HELPER_SCRIPT,
  encodedBootstrap,
  manualRemoveCommand,
} from "../../src/install/windows-self-delete";

test("the helper script calls no cmdlet (Verb-Noun command) and no alias for one", () => {
  // Strings and comments are not commands.
  const code = DELETE_HELPER_SCRIPT.replace(/'[^']*'/g, "''").replace(
    /^\s*#.*$/gm,
    "",
  );
  const cmdlets = code.match(
    /\b(?:Get|Set|New|Remove|Test|Out|Add|Start|Stop|Wait|Write|ConvertFrom|ConvertTo|Select|Where|ForEach|Import|Invoke|Join|Split|Copy|Move|Rename|Clear)-[A-Z][A-Za-z]+/g,
  );
  expect(cmdlets).toBeNull();
  // The aliases the earlier version leaned on.
  expect(code).not.toMatch(/\b(?:sleep|rm|del|gci|ls|iex|%|\?)\s/i);
});

test("the encoded bootstrap is fixed text that only runs the script from the environment", () => {
  const decoded = Buffer.from(encodedBootstrap(), "base64").toString("utf16le");
  expect(decoded).toBe("& ([scriptblock]::Create($env:FERN_DEL_SCRIPT))");
});

test("the printed manual command doubles every kind of single quote PowerShell recognises", () => {
  const out = manualRemoveCommand("C:/Bob\u2019s/it's/\u2018x\u2019.exe.old-1");
  expect(out).toContain("Bob\u2019\u2019s");
  expect(out).toContain("it''s");
  expect(out).toContain("\u2018\u2018x\u2019\u2019");
});
