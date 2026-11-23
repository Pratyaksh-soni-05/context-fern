# Contributing

Thanks for your interest in Context Fern.

## Licensing of contributions

Context Fern is licensed under Apache-2.0. As section 5 of the license ("Submission of Contributions") provides, unless you explicitly state otherwise, any contribution you intentionally submit for inclusion in the project is licensed under the terms of Apache-2.0, without any additional terms or conditions. There is no CLA and no sign-off to add to your commits.

## Before opening a PR

- Read [`docs/spec.md`](docs/spec.md) first; it is the source of truth for scope. If your change isn't covered by it, open an issue to discuss before writing code.
- One module, one branch, one PR.
- Include tests. Tests assert behaviour, not that a mock was called.
- If you made a non-obvious decision, add one dated line to [`docs/decisions.md`](docs/decisions.md).
- New dependency? Say why, in one line, in the PR description.
- Run `bun run lint`, `bun run typecheck`, and `bun run test` locally before pushing.

## Reporting bugs or security issues

Functional bugs: open a GitHub issue. Security issues: see [`SECURITY.md`](SECURITY.md) — do not open a public issue.
