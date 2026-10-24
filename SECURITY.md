# Security Policy

Context Fern runs a localhost daemon and, in isolate mode, proxies requests to your model provider and forwards your auth headers. Treat anything touching `packages/daemon/src/proxy/`, authentication, the installer, or the journal as sensitive.

## Reporting a vulnerability

Please do not open a public GitHub issue for security vulnerabilities. Instead, email the maintainer privately with:

- A description of the issue and its potential impact.
- Steps to reproduce, or a minimal proof of concept.
- The version/commit you tested against.

We aim to acknowledge reports within a few days. As a solo-maintained project, fixes may take time; critical issues (anything that could leak credentials, auth headers, or session content) are prioritized first.

## Scope

In scope: the daemon, the isolate-mode proxy, the installer scripts, and anything that handles API keys or auth headers. Out of scope: issues requiring local code execution the attacker already has (Context Fern assumes a trusted local machine), and third-party model provider vulnerabilities.
