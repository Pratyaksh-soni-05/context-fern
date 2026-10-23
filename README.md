# ContextTree

ContextTree is a free, local, open-source context router for coding agents: it splits a long session into a topic tree, sends the model only the trunk plus the active branch, keeps each branch as a markdown brief that survives compaction, and logs every routing decision so you can see it, undo it or merge it. No account, no hosted service, no content telemetry. Apache-2.0.

See [`docs/spec.md`](docs/spec.md) for scope and acceptance, and [`docs/architecture.md`](docs/architecture.md) for how it's built. This project is in early development; nothing here is released yet.
