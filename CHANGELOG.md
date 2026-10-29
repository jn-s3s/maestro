# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Detection of Qoder CLI and Cline CLI configs
- Syntax highlighting for JavaScript, TypeScript and Python files, plus in-editor formatting for JavaScript and TypeScript, so hook and script configs open readable
- Phase 1 of the Rust rewrite: an isolated Tauri prototype with a synthetic CodeMirror fixture, native tray verification and a synthetic Electron backup compatibility probe
- Phase 2 of the Rust rewrite: a Tauri-free `maestro-core` crate with tool detection, conflict-aware reads and writes, encrypted history and filesystem watching, covered by synthetic-fixture tests
- Phase 3 of the Rust rewrite: a Tauri desktop app with feature parity, including real tool detection, conflict-aware saving, encrypted history and restore, folder management, custom entries, settings, watching, tray recents and close to tray
- Phase 4 of the Rust rewrite: tabbed editing with in-memory drafts, a command palette with content search that skips secret and `.env` files, registered workspaces with project-local configs, favorites and sidebar filtering, inline syntax diagnostics, an inspector, a three-way conflict dialog and snapshot names, pins and configurable retention
- Phase 4 follow-ups: schema key suggestions and deprecated-setting warnings for known JSON configs, MCP and Library navigation views, available, missing, unreadable and unsupported discovery states, and encrypted drafts that are restored after a restart
- Phase 5 of the Rust rewrite: a Maestro 1 migration in Settings that imports settings and decrypts Electron snapshot history into the Tauri data folder, leaving `%APPDATA%\maestro` untouched for rollback
- A typed Tauri bridge in `src/app` that reuses the existing React interface, with theme, recent-file and filesystem-change events
- Rust settings, JSON and JSONC save validation, folder policies, history path validation and Windows-safe entry name validation in `maestro-core`
- Workspace discovery, registered-file search and snapshot metadata in `maestro-core`, with 40 Tauri commands and permission entries for each, including `legacy_status` and `import_legacy`
- A Maestro 1 migration and rollback entry in the Windows desktop check suite, backed by a synthetic Electron safe storage profile

### Changed

- `pnpm lint` now runs oxlint (correctness, suspicious and perf rules) before ESLint, and both must pass
- CI now runs `pnpm format:check` as its first step, so unformatted code fails the build instead of merging
- Electron packaging now includes only the built main, preload and renderer output, so prototype assets cannot enter the portable app
- The Tauri app keeps its own settings, encrypted history and encrypted drafts in its app-data folder, leaves the Electron data in `%APPDATA%\maestro` untouched and does not run the legacy destructive startup resets
- The Phase 1 fixture interface in `src/prototype` is retired and excluded from builds, and the stale `prototype:*` scripts are removed in favor of the `app:*` commands
- Tauri-only controls for workspaces, content search, snapshot metadata, retention and migration are hidden in the Electron build through API capability flags
- The Tauri beta now uses the identifier `dev.jn-s3s.maestro` and the binary `maestro.exe`, with its data root at `%APPDATA%\dev.jn-s3s.maestro`
- The Electron snapshot decoder moved into `maestro-core`, so the compatibility probe and migration share one implementation

### Fixed

- JSONC formatting now preserves comments and trailing commas instead of rejecting files with comments ("JSONC formatting would remove comments" error)
- JSONC comments now render with proper syntax highlighting (previously showed as plain white text)
- Registering a custom file or folder outside an already registered region now works instead of being rejected by the duplicate check
- Invalid JSON and JSONC now fail before a backup is written or the configuration file is replaced
- The Tauri release app now ships its full Tailwind stylesheet: content detection starts at the `src/app` Vite root, so `main.css` declares both UI trees as explicit sources and the GUI check fails if computed styles are missing
- Renaming a managed file now moves its encrypted snapshot history to the new path instead of leaving it behind
- Activating a tab now re-checks the file, so an edit made while another tab was active reloads a clean tab or warns about a dirty one instead of showing stale content
- Draft write failures now show a warning instead of silently leaving unsaved edits without a recovery copy
- The snapshot limit field now clamps typed values to the supported 1 to 100 range

## [1.0.0] - 2026-08-29

### Added

- Detection of AI coding agent configs out of the box: OpenCode, Aider, Claude Code, Gemini CLI, Codex CLI, Continue, VS Code flavors and the Cline, Roo Code and Kilo Code extensions
- Custom entries so users can register any file or folder
- CodeMirror editors with JSON, JSONC, YAML, TOML and Markdown modes
- Folder browser with drill-down navigation, file and folder creation, rename, delete and reveal in Explorer via inline controls, keyboard shortcuts and a right-click context menu
- Automatic backups with deduplication, history browsing, diff, restore, delete and load into editor actions
- Filesystem watcher that reloads a file within 250 ms when another process edits it, with a banner that protects unsaved edits
- Recent files surfaced through the tray menu, with a close to tray toggle
- System, light and dark themes with a hide tools list for unused entries
- Secret file flagging for configs containing tokens and API keys
- Windows portable executable distribution

## [1.0.1] - 2026-09-02

### Fixed

- OpenCode plugins folder now detects the correct `plugins` directory instead of the non-existent `plugin` folder

### Changed

- Folder labels in the tools list are lowercase to match the detected folder names

## [1.1.0] - 2026-09-07

### Added

- Live Markdown preview with GitHub Flavored Markdown support
- In-editor formatting for JSON, JSONC, YAML, TOML and Markdown
- Optional soft wrapping for long editor lines

### Fixed

- Editor cursor and selection now stay at their original position after saving a file, instead of jumping to the start of the document
- Saves no longer appear as external file changes because writes use a temporary file and atomic rename
- Markdown links no longer navigate the app window and instead open in the default browser

### Changed

- The minimum window width is now 480 pixels
- Registered subfolders opened from the sidebar now keep normal folder navigation and back-button behavior

### Security

- Backups of secret-flagged config files are now encrypted at rest with OS-managed keys (DPAPI on Windows); existing plaintext secret backups are migrated in place on first launch, and no backup is written when encryption is unavailable
- Config file reads, backup snapshots and destructive file operations are hardened against symlink swap races inside registered folders, and new files are created exclusively so planted symlinks cannot be followed
- DevTools are disabled in packaged builds and window navigation is locked to the app's own entry page
- The packaged renderer CSP no longer allows websocket connections to arbitrary hosts (development still allows the Vite HMR websocket on localhost)
