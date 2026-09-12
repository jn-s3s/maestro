# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- JSONC formatting now preserves comments and trailing commas instead of rejecting files with comments ("JSONC formatting would remove comments" error)
- JSONC comments now render with proper syntax highlighting (previously showed as plain white text)


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
