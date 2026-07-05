# CodexPro Handoff Plan Template

## Task

Describe the requested change in one or two sentences.

## Scope

- Files or modules expected to change:
- Files or modules that must not change:

## SoulForge Boundaries

- Keep v0.1/v0.3 lightweight and lazy.
- Do not let renderer code access the filesystem directly.
- Do not write user mod workspaces directly; use the Patch Engine.
- Do not claim native binary parsing without a real parser.
- Keep mock data tiny and synthetic.

## Implementation Plan

1. Read the relevant files and tests.
2. Make the smallest sufficient change.
3. Run focused validation.
4. Summarize changed files, verification, and remaining risk.

## Verification

- Command:
- Expected result:
