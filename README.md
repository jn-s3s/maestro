# Maestro

<p align="center">
  <img src="resources/icon-source.png" width="96" alt="Maestro icon">
</p>

Conduct all your AI coding agent configurations from one podium.

[![CI](https://github.com/jn-s3s/maestro/actions/workflows/ci.yml/badge.svg)](https://github.com/jn-s3s/maestro/actions/workflows/ci.yml)
[![CodeQL](https://github.com/jn-s3s/maestro/actions/workflows/codeql.yml/badge.svg)](https://github.com/jn-s3s/maestro/actions/workflows/codeql.yml)
[![Release](https://github.com/jn-s3s/maestro/actions/workflows/release.yml/badge.svg)](https://github.com/jn-s3s/maestro/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Maestro is a Windows desktop app that detects config files and folders for popular AI coding tools on your machine, then lets you view, edit, diff, back up and restore them from a single interface. No more hunting through dotfolders to remember which agent keeps its settings where.

## Supported tools out of the box

| Tool | What Maestro manages |
| --- | --- |
| OpenCode | `opencode.json` / `opencode.jsonc`, commands, agents and plugins folders |
| Aider | `.aider.conf.yml` and `~/.env` API keys |
| Claude Code | `settings.json`, `.claude.json`, commands, agents and skills folders |
| Gemini CLI | `settings.json`, `GEMINI.md`, commands folder |
| Codex CLI | `config.toml`, `auth.json`, prompts folder |
| Continue | `config.yaml` plus legacy `config.json` |
| VS Code / Insiders / VSCodium | User `settings.json` for each installed flavor |
| Cline / Roo Code / Kilo Code | MCP settings per VS Code flavor |
| Custom entries | Any file or folder you register yourself |

## Features

- CodeMirror editors with syntax modes for JSON, JSONC, YAML, TOML and Markdown (dotenv and other plain text files open in a syntax free mode)
- Folder browser with drill-down navigation, file and folder creation, rename, delete and reveal in Explorer via inline controls, keyboard shortcuts and a right-click context menu
- Automatic backups with deduplication, history browsing, diff against the live editor, restore, delete and load into editor
- Secret files are flagged so you know which entries hold tokens and API keys
- Custom entries for any other config file or folder on disk
- System, light and dark themes with a system tray that keeps the app in the background and surfaces recent files
- Hide tools you do not use, switch to close to tray, and jump back to the last five files you opened from the tray menu
- Filesystem watcher reloads a file within 250 ms when another process edits it, with a banner that protects unsaved edits

## Limits

Maestro opens config files inside its built-in editor up to **5 MB**. Anything larger returns an error that suggests opening the file in your default editor instead. Backup history is capped at 20 snapshots per file regardless of size, and identical snapshots are skipped to keep history focused on real changes.

All persistent state (settings, custom entries, recent files, backups, logs) lives under `%APPDATA%\maestro`.

Inside the data root:

- `settings.json` holds theme, tray, hidden tools, recent files and custom entries.
- `backups\<basename>-<12-char-sha1>\` stores the per-file backup snapshots, capped at 20 per file with deduplication.
- `logs\main.log` is the rotating main process log (rotated to `main.log.old` at 512 KB).

Use `pnpm clear` during development to reset just the `backups/` and `logs/` folders (it leaves `settings.json` alone, dry-runs by default and only deletes when you pass `--yes`), and `pnpm logs` to print the log lines together with the settings path and the full backup tree.

## Download

Grab `Maestro-Portable-<version>.exe` from the latest [release](https://github.com/jn-s3s/maestro/releases/latest). It is a portable executable, no installer required.

> Windows only today. The tool detection paths are Windows specific (`%USERPROFILE%` and `%APPDATA%`).

## Development

Prerequisites:

- Node.js 22 or newer (the version CI builds and tests against)
- pnpm 10 (`corepack enable` gets you the pinned version)

```powershell
pnpm install
pnpm dev
```

| Command | Description |
| --- | --- |
| `pnpm dev` | Start Electron in development mode with hot reload |
| `pnpm build` | Production build to `out/` |
| `pnpm icon` | Regenerate runtime icon assets from `resources/icon-source.png` |
| `pnpm typecheck` | Typecheck main/preload/shared and renderer projects |
| `pnpm lint` | Lint the repo with ESLint |
| `pnpm logs` | Print the main process log plus the settings path and the full backup tree |
| `pnpm clear` | Dry-run by default; pass `--yes` to delete `%APPDATA%\maestro\backups` and `%APPDATA%\maestro\logs` (leaves `settings.json` untouched) |
| `pnpm dist` | Regenerate icons, build and package into `release/` |

### Project structure

```
src/
  main/       Electron main process: window lifecycle, IPC handlers, registry, backups, store
  preload/    Context bridge exposing typed IPC to the renderer
  renderer/   React UI (components, theme, entry)
  shared/     Types shared between main and renderer
scripts/      Build-time utilities such as icon generation
resources/    App icon and tray images bundled as extraResources
```

### Updating the icon

Replace `resources/icon-source.png` with a square PNG (at least 256x256, 1024x1024 recommended) and run:

```powershell
pnpm icon
```

This regenerates `resources/icon.png`, `resources/tray.png`, `resources/tray-2x.png` and `resources/icon.ico`. The generated files are gitignored, so the source PNG is the only icon asset tracked in the repo. `pnpm dist` runs `pnpm icon` automatically before packaging.

## Tech stack

Electron 44 with electron-vite, React 19, TypeScript strict mode, Tailwind CSS v4 and CodeMirror 6, packaged with electron-builder as a Windows portable executable.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and conventions. Please follow Conventional Commits and make sure `pnpm typecheck` passes before opening a pull request.

## Security

Found a vulnerability? Please do not open a public issue. See [SECURITY.md](SECURITY.md) for how to report it privately.

## License

Released under the [MIT License](LICENSE).
