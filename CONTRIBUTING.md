# Contributing

Thanks for your interest in ContextTree.

## Developer Certificate of Origin

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/) instead of a CLA. Add `-s` to your commit:

```
git commit -s -m "your message"
```

This appends a `Signed-off-by: Your Name <you@example.com>` line certifying you wrote the change or otherwise have the right to submit it under this project's license. PRs with unsigned commits will be asked to amend before merge.

## Before opening a PR

- Read [`docs/spec.md`](docs/spec.md) first; it is the source of truth for scope. If your change isn't covered by it, open an issue to discuss before writing code.
- One module, one branch, one PR.
- Include tests. Tests assert behaviour, not that a mock was called.
- If you made a non-obvious decision, add one dated line to [`docs/decisions.md`](docs/decisions.md).
- New dependency? Say why, in one line, in the PR description.
- Run `bun run lint`, `bun run typecheck`, and `bun run test` locally before pushing.

## Reporting bugs or security issues

Functional bugs: open a GitHub issue. Security issues: see [`SECURITY.md`](SECURITY.md) — do not open a public issue.
