# Security Policy

Context Fern runs a daemon on your machine, installs a Claude Code plugin and a few hooks, and keeps a journal of what it did. Treat anything touching the daemon, authentication, the installer or the journal as sensitive.

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Use GitHub's private vulnerability reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include:

- A description of the issue and its potential impact.
- Steps to reproduce, or a minimal proof of concept.
- The version or commit you tested against.

This is a solo-maintained project. I aim to acknowledge a report within a few days; fixes may take longer. Anything that could leak credentials or session content comes first.

## Scope

In scope: the daemon, the hooks and plugin, the installer and uninstaller, the release workflow, and anything that handles secrets. Out of scope: issues that need local code execution the attacker already has (Context Fern assumes a trusted local machine), and vulnerabilities in your model provider or in Claude Code itself.

## What the build does to keep you safe

- The daemon listens on `127.0.0.1` only, rejects any other `Host` and any browser `Origin` that is not local (a request with no `Origin` header still needs the token), and requires its token (or the browser session that token mints) for everything except the static files of `fern ui`.
- The embedding model and the native library are pinned by checksum and verified before use.
- `fern uninstall` removes only files that `fern init` recorded and whose contents still match; it never deletes `.fern/` or `~/.fern`.
- Isolate mode, which would proxy model traffic and forward your auth headers, is planned and is not in this release. This release has no proxy and forwards no auth header.
- Strings that look like secrets are filtered out of reply gists when they are written and out of briefs restored to the model. The filter is best-effort and your own prompt lines are not filtered when written; see [`TELEMETRY.md`](TELEMETRY.md).

## How releases are published

The release workflow builds the binaries on GitHub-hosted runners, writes a `SHA-256SUMS` file, and publishes only from a pushed `v*` tag, behind repository variables and GitHub Environments that the maintainer sets up. Every action in it is pinned to a full commit SHA.

- **npm** packages are published with provenance, so each one links to the workflow run that built it.
- **GitHub Release** tarballs carry build provenance.
- **PyPI** releases are published through PyPI trusted publishing, **without** PEP 740 attestations.

No release has been published yet. The provenance claims above describe what the workflow is set to do, and the first release candidate is where they get checked; treat them as unverified until a published release shows them.

## What is not promised

- **The binaries are not code-signed.** Windows SmartScreen and macOS Gatekeeper may warn when you first run one. Check the download against `SHA-256SUMS`, or install through `pip`, `uvx` or `npx`.
- **Intel Macs are not supported.** The macOS build is for Apple silicon.
- Builds are not claimed to be reproducible, and no SLSA level is claimed.
