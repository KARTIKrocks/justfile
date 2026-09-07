# Justfile for VS Code

A VS Code extension for [`just`](https://github.com/casey/just), the command runner.

> **Status: pre-implementation.** The product requirements are complete; no code has been written yet.

## Design

The full product requirements document lives in [`PRD.md`](PRD.md). The short version:

**Two tiers, with a hard boundary.**

| | Tier 1 — in-process parser | Tier 2 — `just` CLI |
|---|---|---|
| Runs | On every keystroke | On save, in trusted workspaces only |
| Provides | Highlighting, outline, completion, navigation | Diagnostics, canonical metadata, formatting |
| Cost | Sub-millisecond, no I/O | Subprocess, cached, single-flight |

Two rules follow from that split, and the rest of the design is downstream of them:

1. **Tier 1 never emits a semantic diagnostic.** `just` is the only authority on whether a Justfile is valid. A wrong squiggle is worse than no squiggle.
2. **Tier 2 never runs in an untrusted workspace.** `just` evaluates backticks and `shell()` at *parse* time, so merely reading a Justfile with the CLI executes whatever it contains.

## Requirements

* VS Code 1.101.0 or later
* `just` 1.27.0 or later, for the features that need the CLI

## Development

Not yet applicable — see [PRD.md § 34](PRD.md) for the planned build order.
