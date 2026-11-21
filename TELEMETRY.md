# Telemetry

Context Fern has no telemetry. It does not send transcript content, file paths, frond names, briefs or journal entries anywhere, and it has no usage counters, crash reporter or account.

There is also no version check in this release. Context Fern never contacts a server of ours to ask whether a newer version exists; to update, run the install command again.

## Where your data lives

- Per project, in `.fern/` inside the project folder: the fern database (`fern.db`), one markdown brief per frond, and the journal of routing decisions (`journal.jsonl`).
- Per machine, in `~/.fern`: the running daemon's address and token, and the list of projects it has seen.
- The embedding model ships inside the package you install, and `init` copies it into your operating system's user cache folder. It is read from disk and is never downloaded when you run Context Fern.

`fern uninstall` removes what `fern init` installed. It never deletes `.fern/` or `~/.fern`; it prints where they are and the one command that deletes them, and you run it.

## Network traffic

- **The daemon** listens on `127.0.0.1` only and rejects any other `Host` or `Origin`. It requires its token, or the browser session that token mints, for everything except the static files of `fern ui`. Nothing outside your machine can reach it.
- **Your prompts** go to your model provider exactly as they do without Context Fern. Context Fern runs beside Claude Code and does not change where Claude Code sends them.
- **Context Fern itself makes no model calls in this release.** A second-stage router that would ask a local Ollama model exists only in the replay and benchmark tools and is not connected to the running product. When it is connected, each call will be recorded in the journal with the model name and token counts.
- **Isolate mode** is planned and is not in this release, so Context Fern does not proxy model traffic or forward any auth header.

## What is stored, and what is only best-effort

- A frond's brief keeps the first line of each of your last five prompts for that frond (up to 140 characters, as you typed it) and, under each, a one-line gist of the reply (up to 120 characters). It also keeps the frond's goal, which is the first line of its opening prompt, and the paths of files touched.
- The reply gist is passed through a secret filter before it is written. Your own prompt lines are not filtered when they are written, so a secret at the start of a prompt can be in the brief file.
- When a brief is handed back to the model after `/clear`, compaction, resume or fork, every line of it is passed through the filter and quoted as data, not as instructions. The filter looks for API keys, tokens, `Authorization` headers, private keys, `password = ...` style lines and long random-looking strings, and it drops lines that read like instructions to the model. It is best-effort and can miss a secret.
- Keep `.fern/` out of version control (`fern init` offers to add it to `.gitignore`), and delete a brief you do not want kept.

## One local switch to know about

`FERN_DEBUG=1` makes the Claude Code hooks append their raw input, which includes your prompts, to `.fern/hook-debug.log`. It is off unless you set it, it writes only inside `.fern/`, and it is yours to delete when you are done.

## Why this matters

Context tooling that sees everything you type is only trustworthy if what it does with that data is inspectable. Context Fern's answer is that nothing it builds leaves your machine, and every decision it makes is in a journal you can read.
