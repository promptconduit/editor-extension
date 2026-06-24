# Contributing to the PromptConduit Editor Extension

Thanks for your interest in contributing. This document covers how to get set up, what kinds of contributions are most valuable, and how to get your PR merged.

This is the VS Code / Cursor extension that shows your AI coding session cost live in the status bar. It is written in TypeScript and renders cost records streamed by the local `promptconduit` CLI — it never talks to a server.

## Development Setup

**Prerequisites:** Node.js 18+, npm, and a build of the `promptconduit` CLI on your `PATH` (`brew install promptconduit/tap/promptconduit`).

```bash
git clone https://github.com/promptconduit/editor-extension.git
cd editor-extension
npm ci             # install exact dependencies from the lockfile
npm run compile    # type-check and emit to out/ (or: npm run watch)
```

To run the extension end-to-end, press **F5** in VS Code / Cursor to launch an Extension Development Host, then open a folder where you run Claude Code and watch the status bar update as you work.

## What We're Looking For

### Bug Fixes

Check existing issues before opening a new one. Include your editor and extension version, OS, and any output from the **PromptConduit Cost** channel in the Output panel.

### Enhancements

Improvements to the cost breakdown, status-bar rendering, settings, or support for additional editors are all welcome. For larger changes, open an issue first so we can agree on the approach.

## Pull Request Guidelines

1. **Branch naming:** `feat/description`, `fix/description`, `chore/description`
2. **Never commit directly to main** — always use a feature branch.
3. **Compile:** `npm run compile` must succeed with no TypeScript errors.
4. **Package:** `npx vsce package` must succeed (do not commit the generated `.vsix`).
5. **Squash merge:** PRs are squash-merged — keep your history clean or we'll squash it.

## Open Source Guardrails

This repo is public. Please ensure your contributions:

- Do **not** reference platform internals, Cloudflare resource IDs, or private API endpoints
- Do **not** include API keys, tokens, or credentials of any kind
- Keep the extension local-only — it should talk only to the `promptconduit` CLI, never to a remote server
- Keep commit messages and PR descriptions free of proprietary business logic

When in doubt, open an issue and ask before implementing.

## License

By contributing, you agree your contributions will be licensed under the [MIT License](./LICENSE).
