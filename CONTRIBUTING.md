# Contributing to Maestro

Thanks for your interest in contributing. This guide covers everything you need to get started.

## Prerequisites

- Node.js 22 or newer (the version CI builds and tests against)
- pnpm 10 (run `corepack enable` once to pick up the version pinned in `package.json`)
- Windows 10 or newer (tool detection and packaging targets Windows)

## Getting started

```powershell
git clone https://github.com/jn-s3s/maestro.git
cd maestro
pnpm install
pnpm dev
```

Useful commands:

| Command | Description |
| --- | --- |
| `pnpm dev` | Run the app in development mode with hot reload |
| `pnpm build` | Production build to `out/` |
| `pnpm typecheck` | Typecheck both TypeScript projects |
| `pnpm lint` | Lint the repo with ESLint (`pnpm lint:fix` to autofix) |
| `pnpm logs` | Print the main process log plus the settings path and the full backup tree |
| `pnpm clear` | Dry-run by default; pass `--yes` to delete `%APPDATA%\maestro\backups` and `%APPDATA%\maestro\logs` (leaves `settings.json` untouched) |
| `pnpm dist` | Regenerate icons, build and full packaged output into `release/` |

There is no test framework configured yet, so `pnpm typecheck` and `pnpm lint` are the verification gates. CI runs typecheck, lint and build on every push and pull request targeting `main`.

## How to contribute

1. Open an issue first for anything that changes behavior, so we can agree on the approach before you write code. Small fixes can go straight to a pull request.
2. Fork the repo and create a branch from `main`. Name it after the change, for example `feat/custom-tool-groups` or `fix/diff-scroll-sync`.
3. Make your changes. Follow the patterns in neighboring files and the tracked style configs (`.editorconfig`, `.prettierrc.json`, `eslint.config.mjs`, `tsconfig.node.json`, `tsconfig.web.json`).
4. Run `pnpm typecheck`, `pnpm lint` and `pnpm build` and make sure all pass.
5. Open a pull request against `main` and fill in the template.

## Commit messages

This repo follows Conventional Commits:

```
<type>(<scope>): <summary>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`.

Examples:

- `feat(registry): detect Codex prompts folder`
- `fix(backups): keep history sorted by newest first`
- `docs: add download section to README`

Keep the summary lowercase, imperative and under about 69 characters.

## Style notes

Formatting is enforced by `.prettierrc.json` and `.editorconfig`: 4 space indentation, double quotes, semicolons, CRLF line endings. TypeScript runs in strict mode; avoid `any` and prefer union types over enums. React code uses function components with hooks only, one component per file. Lint rules are in `eslint.config.mjs`, and the strict TypeScript settings live in `tsconfig.json`, `tsconfig.node.json` and `tsconfig.web.json`. Follow the patterns already used by neighboring files rather than introducing a new style.

## Reporting bugs and security issues

Bug reports go through the bug report issue form. Security vulnerabilities must not be opened as public issues; see [SECURITY.md](SECURITY.md) instead.

## Licensing

By contributing you agree that your contributions will be licensed under the MIT License that covers this project.
