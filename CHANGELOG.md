# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
