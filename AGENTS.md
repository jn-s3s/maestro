# AGENTS.md

Guidance for AI coding agents working in this repository. Read this file before making changes.

---

## Project Overview

**Maestro** conducts all your AI coding agent configurations from one podium. It is a Windows desktop app that detects config files and folders for popular AI coding tools, then lets you view, edit, diff, back up and restore them from a single interface.

Detected out of the box: OpenCode, Aider, Claude Code, Gemini CLI, Codex CLI, Qoder CLI, Cline CLI, Continue, VS Code flavors (VS Code, Insiders, VSCodium), and the Cline, Roo Code and Kilo Code extensions. Users can register any other file or folder as a custom entry.

Core stack:

- Electron 44 with electron-vite (main, preload and renderer processes)
- React 19 function components and hooks
- TypeScript in strict mode (`tsconfig.node.json` for main/preload/shared, `tsconfig.web.json` for renderer)
- Tailwind CSS v4 via `@tailwindcss/vite`
- CodeMirror 6 editors (JSON, JSONC, YAML, TOML, Markdown, JavaScript, TypeScript and Python modes)
- electron-builder producing a Windows portable executable

The main process owns the filesystem: tool detection lives in `src/main/registry.ts`, backups in `src/main/backups.ts`, settings persistence in `src/main/store.ts`. The renderer talks to it exclusively through the IPC surface exposed by `src/preload/`. Shared types live in `src/shared/types`.

The Rust rewrite under `src-tauri/` is a full Tauri 2 desktop app (Phase 4), not a fixture. Its Tauri-free `maestro-core` crate owns detection, discovery states, safe file access, workspace discovery, search, validation advice, encrypted drafts, encrypted history, settings and watching. `src/app/` installs a typed Tauri bridge and mounts the same React UI from `src/renderer/src/`. The UI adds tabs with encrypted draft recovery, a command palette with sensitive-file-excluded content search, favorites, MCP and Library views, schema suggestions, deprecated-setting warnings, per-file discovery states, inline diagnostics, an inspector, a three-way conflict dialog and snapshot naming, pinning and retention. Electron remains the shipped build; the Tauri app uses its own app-data folder and does not read Electron settings or history yet. Full JSON Schema validation, the shared MCP manager and profiles remain follow-ups. Phase 5 migration remains open.

## Commands

This repository uses **pnpm 10** exclusively. Do not use npm or yarn, and do not produce an `npm run` or `yarn` command anywhere in this project.

- `pnpm dev` - start Electron in development mode with hot reload
- `pnpm build` - production build to `out/`
- `pnpm icon` - regenerate runtime icon assets from `resources/icon-source.png`
- `pnpm typecheck` - typecheck both node and renderer projects
- `pnpm lint` - lint the repo with oxlint, then ESLint (`pnpm lint:fix` to autofix)
- `pnpm logs` - print the main process log plus the settings path and the full backup tree
- `pnpm clear` - dry-run by default; pass `--yes` to delete `%APPDATA%\maestro\backups` and `%APPDATA%\maestro\logs` (leaves `settings.json` untouched)
- `pnpm dist` - regenerate icons, build and package into `release/`
- `pnpm app:dev` - start the Tauri desktop app in development mode with hot reload
- `pnpm app:build` - build the Tauri release executable to `src-tauri/target/release/maestro-prototype.exe`
- `pnpm app:dist` - build the optional Tauri installer with the WebView2 offline runtime
- `pnpm app:check parity` - run the Windows parity GUI check (needs `pnpm app:build` first)
- `pnpm app:check tray` - run the Windows tray lifecycle check (needs `pnpm app:build` first)
- `pnpm format` - `prettier --write .`
- `pnpm format:check` - `prettier --check .`

### Verification requirement

After any code change, run in this order:

1. If the repo has Prettier tooling, format the changed files: `pnpm exec prettier --write <changed files>` for a scoped change, or `pnpm format` when the change spans the whole repo.
2. Run the repo's `pnpm typecheck`.
3. Run the repo's `pnpm lint`.
4. Run the repo's `pnpm format:check` to confirm nothing was left unformatted.

All four MUST pass before a change is considered finished. The Electron app has no test framework configured; do not invent a test command for it.

For changes under `src-tauri/`, also run the Rust checks:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace
```

For changes that affect desktop behavior, also run the GUI checks after a release build. They drive the real WebView2 window against a synthetic home and data root, and they never touch the real profile:

```powershell
pnpm app:build
pnpm app:check parity
pnpm app:check tray
```

A direct `cargo build --release` embeds the development URL and is not a valid check binary; always build through `pnpm app:build`.

## Repository Layout

| Path              | Description                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/`       | Electron main process: window lifecycle, IPC handlers, registry, backups, store                                                                                                        |
| `src/preload/`    | Context bridge exposing typed IPC to the renderer                                                                                                                                      |
| `src/renderer/`   | React UI shared by Electron and Tauri: components in `components/`, entry in `main.tsx`, theme in `theme.tsx`                                                                          |
| `src/app/`        | Tauri frontend entry and typed desktop bridge; mounts the shared renderer                                                                                                              |
| `src/shared/`     | Types shared between main, preload and renderer                                                                                                                                        |
| `src/prototype/`  | Retired Phase 1 fixture interface, excluded from builds and linting                                                                                                                    |
| `src-tauri/`      | Tauri 2 desktop app (Phase 4): commands, state, tray, shell integration and the legacy probe                                                                                           |
| `src-tauri/core/` | Tauri-free `maestro-core` crate: detection and discovery states, workspaces, search, schema advice, encrypted drafts, settings, file access, encrypted history and watching with tests |
| `out/`            | electron-vite and Vite build output (gitignored, regenerated by `pnpm build` and `pnpm app:web:build`)                                                                                 |
| `release/`        | electron-builder packaging output (gitignored, produced by `pnpm dist`)                                                                                                                |
| `resources/`      | App icon and tray images bundled as extraResources and consumed by electron-builder as `buildResources`                                                                                |
| `scripts/`        | Build, GUI check and maintenance utilities such as icon generation, log dumping and data clearing                                                                                      |
| `.github/`        | CI/CD workflows, issue forms, PR template, community health files                                                                                                                      |

For end user documentation see [README.md](README.md). For contribution workflow and tracked style sources see [CONTRIBUTING.md](CONTRIBUTING.md).

## Coding Conventions

Read the relevant file before editing code in that area. Do not rely on general knowledge of a language or framework instead, because this repo intentionally diverges from common defaults in several places (strict typography rules and 4-space indentation are two examples). Formatting is also enforced by `.prettierrc.json` and `.editorconfig` where Prettier tooling exists.

| Area       | Doc                                            |
| ---------- | ---------------------------------------------- |
| HTML       | `~/.config/opencode/conventions/html.md`       |
| CSS        | `~/.config/opencode/conventions/css.md`        |
| JavaScript | `~/.config/opencode/conventions/javascript.md` |
| TypeScript | `~/.config/opencode/conventions/typescript.md` |
| React      | `~/.config/opencode/conventions/react.md`      |
| Electron   | `~/.config/opencode/conventions/electron.md`   |
| Tailwind   | `~/.config/opencode/conventions/tailwind.md`   |

### Fallback when shared conventions are unavailable

The shared convention library is optional and may not exist on every developer's machine.

If `~/.config/opencode/conventions/` is unavailable:

Continue using this project's AGENTS.md and repository documentation as the primary source of truth.
Follow the repository's existing code patterns, configuration, formatter, linter, and tooling.
Do not assume that a missing shared convention file means the project has no coding conventions.
Do not invent or impose framework-specific conventions that are not established by this repository.
When a shared convention is referenced but unavailable, use the closest existing project pattern instead.

## Documentation Workflow

- After every feature change, update the corresponding docs. Invoke `@docs-writer` when adding or updating docs.

## Reviewer Workflow

`@code-reviewer` and `@security-reviewer` both follow this same loop, whether invoked automatically after a change or directly by the user against specific files or folders.

### When to invoke a reviewer

Do not invoke a reviewer for every change. Check the diff against these triggers first.

**Invoke `@code-reviewer` when the change:**

- Adds, removes or renames an IPC channel or Tauri command, or changes the `Api` contract in `src/shared/types.ts`, `src/preload/` or `src/app/bridge.ts`
- Adds or modifies main process filesystem logic: `src/main/registry.ts`, `src/main/backups.ts` or `src/main/store.ts`
- Adds or modifies Rust filesystem, workspace detection, search, history or settings logic in `src-tauri/core/src/` or Tauri state and commands in `src-tauri/src/`
- Adds or modifies path validation or canonicalization in `src/main/index.ts`, `src/main/backups.ts`, `src-tauri/core/src/paths.rs` or `src-tauri/core/src/files.rs`
- Adds a new renderer component or view with non-trivial state or async logic (editor, diff, backup or restore flows)
- Touches both the backend and the renderer (a cross-process change)
- Changes detection rules, registered tool paths or packaging/build tooling (`electron-builder.yml`, `tauri.conf.json`, `scripts/`)
- Exceeds roughly 80 changed lines or touches more than 3 files

**Invoke `@security-reviewer` only when the change touches:**

- The IPC or command surface: new channels, preload bridge exposure (`src/preload/`), Tauri commands, capabilities or CSP in `src-tauri/capabilities/` and `src-tauri/tauri.conf.json`, or `webPreferences` and sandbox flags in `src/main/index.ts`
- Path handling: canonicalization, symlink resolution, containment checks or any `assert*` helper
- Read, write, delete or reveal operations on the user's real config files or backups, including `.env` files that carry API keys
- Custom entry registration or any other user-controlled input that reaches the filesystem
- External app launching via `shell.openPath`, `shell.showItemInFolder`, `src-tauri/src/shell.rs` or the Recycle Bin
- Anything that could corrupt or exfiltrate the user's AI agent configuration files

**Skip both reviewers** for a copy or content-only edit, a CSS or style-only tweak, a single-function bug fix with no new surface area, a dependency patch bump or a documentation-only change. Still run typecheck, lint and format for these.

When a change is borderline, treat it as qualifying. A missed review costs more than an extra one.

### The loop

- Pass `verificationStatus: "verified"` when invoking after a change where typecheck and lint already passed (see the pre-verified check rule below). Pass `"unverified"` or omit it for a review-only request.
- Scope the reviewer's context to the diff: the changed files or `git diff` output, plus only as much surrounding context as the reviewer needs to judge the change. Do not hand over whole unrelated files.
- If the reviewer returns REJECT, apply the listed fixes, run the repo's typecheck and lint, then invoke the same reviewer again.
- After two REJECTs on the same review, stop looping. Summarize the remaining flagged issues and ask the user how to proceed instead of invoking a third time.
- Repeat until APPROVE, or until the two-REJECT cap is hit.

This applies even when no code changed in the current turn. A REJECT on a review-only request still means fix and re-review, subject to the same two-REJECT cap.

### Reviewer pre-verified check rule

When invoking `@code-reviewer`, `@security-reviewer` or `@commiter`, pass a `verificationStatus` flag:

- `verificationStatus: "verified"` means the caller already ran the repo's typecheck and lint successfully. The reviewer agent MUST skip the redundant typecheck and lint run and focus on the review itself.
- `verificationStatus: "unverified"` (or omitted) means the reviewer agent runs typecheck and lint itself before reviewing. This is the safe default for a review-only request or when the caller did not verify.

The agent editing code MUST always pass `"verified"` when invoking a reviewer after making a change, because the verification requirement above already requires typecheck and lint to pass first.
