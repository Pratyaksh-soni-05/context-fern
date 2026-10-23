# Telemetry

ContextTree has no content telemetry. It never sends transcript content, file paths, branch names, briefs, or journal entries anywhere. Everything it builds — the tree, the briefs, the journal — stays in `.contexttree/` on your machine.

## The only network call: an opt-in version check

ContextTree may make a single, optional ping to check whether a newer version is available. It sends nothing but the current version string and receives back the latest version string. No user identifier, no machine identifier, no usage data.

This check is **opt-in**. It is disabled by default and disabled unconditionally when the environment variable `DO_NOT_TRACK=1` is set, per [consoledonottrack.com](https://consoledonottrack.com/).

## Model provider calls

In `suggest` mode's Stage 2 router escalation, or in `isolate` mode, ContextTree sends your turn content to whichever model provider you've configured (your own API key, or your local Ollama). That traffic goes directly to the provider you chose — it is not ContextTree telemetry, and we never see it.

## Why this matters

Memory and context tooling that sees everything you type is only trustworthy if what it does with that data is inspectable. ContextTree's answer is: nothing leaves your machine except the calls you already configured to your own model provider.
