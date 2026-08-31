# Project Guidelines

## Core Commands
- **Test:** `npm test`
- **Test single file:** `npm test -- path/to/file.test.ts`

## Principles (Wabi-Sabi Engineering)
- **Test-first:** write or run the failing test before writing the fix.
- **Minimal edits:** change only what the task requires. No unrelated refactors, no speculative abstractions.
- **Empirical verification:** trust the terminal, not assumption. Run the test/build and read its actual output before declaring done.
- **Zero fluff:** no dead code, no unused config, no comments that restate the code, no files beyond what the task needs.

## Code Style
- 2 spaces, no semicolons, single quotes.
- Strict TypeScript — never use `any`.
