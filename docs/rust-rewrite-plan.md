# Maestro 2 Rust rewrite plan

Status: Phase 5 is complete as of 2026-10-29. The Tauri beta imports Maestro 1 settings and encrypted history, keeps the legacy data untouched for rollback, and builds its own installer. Electron remains the application shipped by the normal build commands.

The original findings came from `review/fix-issues`. Phase 1 uses `feat/rust-rewrite-plan` at `d12492a`, whose package version is 1.1.0. The branch-specific inventory and verification results are recorded below.

## Recommended direction

Build Maestro 2 as a local-first configuration workbench with a Rust backend, Tauri 2 desktop shell and redesigned React interface. Keep CodeMirror for editing.

This replaces Electron but retains JavaScript in the frontend. If removing JavaScript is essential, evaluate Iced instead. A fully Rust interface would require substantially more work on editing, Markdown preview and accessibility. Tauri is the recommended starting point because it preserves the existing editor capabilities.

Target Windows first. Keep the app usable without an account or cloud dependency.

## Current design and proposed improvements

Preserve the existing tool detection, editing, encrypted secret backups, diffing and filesystem watching. Build the new workflows around those capabilities.

| Current design                                          | Proposed improvement                                                      | Source                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| Single active document                                  | Tabs, split comparison and recoverable unsaved drafts                     | `src/renderer/src/App.tsx`, `AppContent` |
| Tool definitions concentrated in one detection function | Version-aware tool adapters with testable detection rules                 | `src/main/registry.ts`, `detectTools`    |
| Save API accepts only path and content                  | Expected-revision checks to detect conflicting disk changes before saving | `src/shared/types.ts`, `Api.writeFile`   |
| Secret classification depends on registered flags       | Encrypt all snapshots and allow explicit sensitive-file classification    | `src/main/registry.ts`, `isSecretPath`   |
| TOML formatting parses and reserializes the document    | Comment-preserving TOML editing and formatting                            | `src/renderer/src/lib/beautify.ts`       |
| No automated test framework                             | Rust unit and integration tests plus desktop workflow tests               | `CONTRIBUTING.md`                        |

## Interface redesign

Use a developer-tool layout with resizable panels:

- Top bar: workspace selector, global search and command palette.
- Left navigation: Configurations, MCP, Library, History and Settings.
- Main workspace: tabbed editor, structured settings forms and side-by-side comparisons.
- Optional inspector: validation problems, configuration source, scope and backup status.
- Status bar: saved state, external changes and whether the target tool needs restarting.

Use readable typography, a clear visual hierarchy and one accent color. Support keyboard navigation, high contrast and reduced motion from the start.

The landing page should show actionable problems and recent work. Avoid decorative statistics.

## Essential features for 2.0

### Project and global configuration

Register workspaces, detect project-local files and show which settings override others. Explain precedence only where the tool's rules are known.

### Editing

Add tabs, quick file switching, search across registered roots, split diff and encrypted draft recovery. Exclude sensitive content from search by default.

### Configuration validation

Show inline syntax errors, schema-backed suggestions and deprecated-setting warnings. Preserve comments, unknown fields, line endings and encoding where supported.

### Conflict-aware saving

Compare the loaded revision with disk before writing. Offer a three-way comparison when both changed. The filesystem watcher should not be the only protection against conflicting edits.

### Recovery

Add named snapshots, pinned backups, configurable retention and a preview before restoration. Preserve history after deleting or renaming a managed file.

### Discovery

Add a hidden-files toggle, favorites and better filtering. Distinguish missing files from unreadable and unsupported files.

## Follow-up features

| Feature                         | Behavior                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Shared MCP manager              | Define a server once, preview compatible configuration for selected tools and apply explicitly              |
| Profiles                        | Switch between work, personal and experimental configurations with a complete change preview                |
| Skills and instructions library | Organize prompts, agents and rules; copy or adapt them without assuming formats are interchangeable         |
| Configuration health checks     | Find invalid references, duplicate entries, missing executables and unsupported options                     |
| Import/export bundles           | Share selected configuration with secrets excluded by default; offer separately encrypted sensitive exports |
| Local CLI                       | Expose discovery, validation and snapshot operations for scripts                                            |

MCP connection tests require explicit approval because launching a configured server can execute code or contact external services.

Defer cloud sync, marketplaces, remote management and an embedded AI chat assistant. They add substantial complexity without fixing the core configuration experience.

## Rust architecture

Keep the application in three parts:

| Part              | Responsibilities                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Core library      | Tool detection, document parsing, validation, safe filesystem operations and backup handling |
| Tauri application | Typed commands, scoped permissions, window lifecycle, tray and native dialogs                |
| Frontend          | Presentation and editor state, without unrestricted filesystem or shell access               |

Use declarative tool definitions for straightforward paths and small Rust adapters for tool-specific behavior. Avoid an executable plugin system initially.

### Safety requirements

- Use Windows-aware replacement semantics for writes and preserve appropriate permissions.
- Account for junctions, symlinks and concurrent changes in filesystem checks.
- Block writes when a required backup fails.
- Use preflight checks, snapshots and a recovery journal for multi-file changes. Do not describe these changes as fully atomic across files.
- Keep configuration contents and credentials out of logs.

## Migration phases

| Phase                      | Deliverable and completion criteria                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Baseline and prototype  | Inventory existing behavior, record startup, memory and package measurements, then prove Tauri editing, tray support and WebView2 distribution |
| 2. Rust core               | Implement detection, reads, conflict-aware writes, watching and encrypted history against synthetic fixtures                                   |
| 3. Feature parity          | Preserve every existing workflow, including custom entries, formatting, Markdown preview and backup restoration                                |
| 4. Redesign and essentials | Deliver the new navigation, tabs, workspaces, validation and recovery workflows                                                                |
| 5. Migration and beta      | Import existing settings and history, test packaged builds and confirm rollback before replacing Electron                                      |

### Existing backup compatibility

Prove backup compatibility during the prototype. Existing encrypted snapshots use Electron `safeStorage` with a versioned wrapper in `src/main/store.ts`, through `encodeStoredBackup` and `decodeStoredBackup`.

Use synthetic backups to establish Rust interoperability. Do not assume direct DPAPI decryption is sufficient.

Keep legacy data untouched during migration and prevent both versions from writing concurrently.

### Verification

Test normal editing and recovery workflows alongside these failure cases:

- Locked files and permission failures.
- Disk-full failures and interrupted writes.
- Corrupt settings and unavailable encryption.
- External edits while a document has unsaved changes.
- Junctions, symlinks and concurrent path changes.
- Import of existing settings and encrypted history, followed by rollback.

Compare startup time, memory use and package size with the Electron baseline before making performance claims. Verify the packaged Windows app and its WebView2 requirements as part of the prototype and beta.

## First release scope

Ship Rust/Tauri feature parity with the redesigned editor, workspaces, validation and safer recovery. Add MCP management and profiles next.

## Phase 1 development record

Recorded on 2026-10-28. Phase 1 is complete. The portable exe and the optional installer were confirmed on a clean Windows environment, and the code review was approved. Electron remains the application shipped by the normal build commands.

### Baseline inventory

| Area                   | Behavior on this branch                                                                                                                                                        | Source                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Discovery              | OpenCode, Aider, Claude Code, Gemini CLI, Codex CLI, Qoder CLI, Cline CLI, Continue, three VS Code flavors and their Cline/Roo/Kilo extensions; custom file and folder entries | `src/main/registry.ts`                                                                     |
| Discovery roots        | Windows home and roaming/local app data, XDG overrides, `CODEX_HOME`, `QODER_CONFIG_DIR` and `CLINE_DATA_DIR`                                                                  | `src/main/registry.ts`                                                                     |
| Editor                 | One active document, eight syntax modes, plain-text fallback, soft wrap, unsaved-change prompts, formatting and Markdown preview                                               | `src/renderer/src/App.tsx`, `src/renderer/src/components/EditorPane.tsx`                   |
| Formatting             | JSON, JSONC, YAML, TOML, Markdown, JavaScript and TypeScript. TOML uses parse/stringify and can lose comments; it is not disabled on this branch                               | `src/renderer/src/lib/beautify.ts`                                                         |
| Filesystem             | Registered-path validation, 5 MiB read limit, temporary-file replacement, folder browsing, create, rename, trash, reveal and external opening                                  | `src/main/index.ts`                                                                        |
| Save limitations       | No expected-revision argument. Backup errors can be logged while the write continues. These behaviors must not become the Rust production contract                             | `src/main/index.ts`, `src/shared/types.ts`                                                 |
| Watching               | One active file or folder watcher, 250 ms event debounce and one-second suppression of self-writes; the editor warns about external changes while dirty                        | `src/main/index.ts`, `src/renderer/src/App.tsx`                                            |
| History                | Per-file directory keyed by normalized-path SHA-1, content deduplication, 20 snapshots, diff, restore, load into editor, delete and clear                                      | `src/main/store.ts`, `src/main/backups.ts`, `src/renderer/src/components/HistoryModal.tsx` |
| Settings and lifecycle | Schema version 1, theme, hidden tools, custom entries, wrap, optional close-to-tray, five recent files and single-instance handling                                            | `src/main/store.ts`, `src/main/index.ts`                                                   |
| Startup migrations     | Missing reset flags can delete existing backup history; secret-backup migration also runs at startup                                                                           | `src/main/index.ts`                                                                        |
| Packaging              | Windows portable executable built by electron-builder                                                                                                                          | `electron-builder.yml`                                                                     |

This is a source inventory, not a claim that every legacy workflow was manually retested. The baseline GUI check opens, edits and saves only a synthetic Claude Code settings file. Its child process redirects every detection root and verifies the resolved home directory before launching Electron.

### Prototype boundaries

- `src-tauri/` is the desktop shell and fixture backend. `src/prototype/` is its React frontend, using CodeMirror and the existing editor theme without the Electron bridge. Phase 3 replaced the fixture backend and retired this frontend in place; the files are excluded from every build.
- The only frontend commands are `read_fixture`, `save_fixture` and `hide_to_tray`, permitted only for the local main window. There are no filesystem, shell or network plugins.
- The backend holds one anonymous temporary file open for the session. The renderer never supplies a path. JSON and a 1 MiB limit are checked in Rust. A revision hash rejects stale saves within this fixture workflow.
- These are in-place writes to disposable data, not the production atomic-replacement, backup or concurrent-filesystem protocol. Phase 2 still owns those requirements.
- The prototype has its own application identifier and WebView2 profile. It never imports settings or reads configuration roots. Do not paste credentials into it.
- Closing hides the window. The tray offers Open and Quit. Windows removes the anonymous fixture when its handle closes, including process termination.
- Electron packaging includes only `out/main`, `out/preload` and `out/renderer`, keeping prototype assets and measurement output out of the legacy executable.

### Synthetic backup compatibility

The probe bundles the existing `encodeStoredBackup` and `decodeStoredBackup` functions and runs them in Electron 44.2.0 with a fresh synthetic profile. Rust successfully verifies ten cases: empty text, JSON, Unicode, mixed line endings, an embedded NUL, plaintext legacy content, a modified authentication tag, invalid base64, an unknown ciphertext prefix and truncated ciphertext.

The observed format is `maestro-enc:v1:` followed by base64 containing `v10`, a 12-byte nonce and AES-256-GCM ciphertext with an authentication tag. The encryption key comes from `os_crypt.encrypted_key` in that Electron profile's `Local State` file. Its base64 payload starts with `DPAPI`; Windows DPAPI unwraps the remaining bytes into the AES key.

Direct DPAPI decryption of the snapshot failed. Migration must preserve access to the original Electron profile key as well as the backup files and Windows account. The proof covers this installed Electron version on this machine, not every historical version, another Windows account or a missing profile key. No real backup, key or settings file was opened. The decoder is a probe binary, not a migration command exposed to the desktop frontend.

### Measurements

Environment: Windows 10.0.26200 x64, Node 26.10.0, pnpm 10.33.2, Rust/Cargo 1.99.1, Visual Studio Build Tools 2022, Electron 44.2.0, Tauri 2.11.6 and WebView2 155.0.4283.62.

| Measurement               | Electron unpackaged                    | Electron packaged                          | Tauri fixture prototype                                       |
| ------------------------- | -------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| Startup                   | 5485, 2363 and 2220 ms; median 2363 ms | 27341, 2005 and 2165 ms; median 2165 ms    | 1841, 1869 and 2420 ms; median 1869 ms                        |
| Working set after editing | 415064, 413844 and 418656 KiB          | 410420 to 418976 KiB                       | 372196 to 403088 KiB, including WebView2 children             |
| Distribution              | 97737808 bytes, portable executable    | 97737808 bytes, the same portable artifact | 9135104 bytes portable exe, plus optional 219985284 byte NSIS |

Startup includes automation attachment. Every Electron measurement uses the production renderer; the packaged checks launch `release/phase1/win-unpacked/Maestro.exe` rather than the portable wrapper, which adds extraction time. The three unpackaged launches and the three packaged launches each share their own synthetic profile. The first packaged launch took 27.3 seconds, likely cold start scanning, while the next two took about 2 seconds. Tauri uses a release executable with a fresh WebView2 profile and stops when Rust has loaded the fixture. Memory is summed working set, which can count shared pages more than once. Electron uses `getAppMetrics`; Tauri uses the Windows process tree.

Electron stops the timer when Claude Code navigation is visible; Tauri stops when the fixture has loaded. These readiness points, workloads and distribution formats still differ. They are initial measurements, not evidence that Tauri is faster or uses less memory.

The portable exe is the primary prototype artifact. It requires an installed WebView2 runtime, which Windows 11 includes and most updated Windows 10 machines have through Edge. The optional NSIS installer covers machines without WebView2 by embedding the offline runtime. Choose the portable exe unless a target machine is known to lack WebView2.

The optional installer's bundler cached `MicrosoftEdgeWebView2RuntimeInstallerX64.exe` at 214884560 bytes during this build. The NSIS package is about 4 MB smaller than that payload plus the app executable, which is consistent with compression and installer overhead. The offline mode declared in `tauri.conf.json` embeds the runtime only in the installer. This check inspected the cached payload and package sizes; the installer was not executed.

Local evidence lives in ignored `out/phase1/`: `electron-baseline.json`, `electron-packaged.json`, `tauri-smoke.json`, `tray-smoke.json`, `legacy-compatibility.json`, `tray-menu.png`, `tray-reopened-draft.png` and the other GUI screenshots. Successful checks remove their synthetic sandbox. Failed checks keep it and print the path for diagnosis. Sandboxes are never migration inputs.

### Commands and verification

These Phase 1 commands are historical. The `prototype:*` scripts were replaced by the `app:*` scripts in Phase 3; use the Phase 3 commands for the current desktop app.

Install the Windows MSVC build tools, Rust and WebView2 before running the desktop prototype. The lockfile was built with Rust 1.99.1; its declared Rust 1.85 minimum has not been separately verified. Keep the Tauri Rust and JavaScript API minor versions compatible.

```powershell
pnpm install --frozen-lockfile
pnpm prototype:dev
pnpm prototype:build
pnpm prototype:check tauri
pnpm prototype:check tray
pnpm prototype:check compat
pnpm prototype:dist
```

`prototype:check tray` drives the native caption close button, the tray icon and its menu through Windows UI Automation. Keep one prototype window open at most while it runs. `prototype:build` creates the primary portable executable at `src-tauri/target/release/maestro-prototype.exe`. `prototype:dist` creates the optional current-user NSIS installer containing the WebView2 offline installer; its first build downloads bundling tools and runtime files. Neither command installs the result on this machine.

For the Electron baseline and Rust checks:

```powershell
pnpm build
pnpm exec electron-builder --win portable --config.directories.output=release/phase1
pnpm prototype:check electron
pnpm prototype:check electron-packaged
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace
```

`prototype:check electron-packaged` measures `release/phase1/win-unpacked/Maestro.exe`, which the packaging step creates.

Passed locally:

- The repository's typecheck, lint and formatting checks, Rust Clippy and four Rust unit tests.
- The actual Electron GUI editing check and Tauri GUI save/reload, Unicode, rejected invalid JSON, retained draft, cancelled discard and confirmed discard flows. Screenshots were inspected.
- Native hiding of the same Tauri window after clicking Hide to tray. WebView2 does not reliably report this through `document.visibilityState`, so the driver checks the Windows handle.
- The full tray lifecycle on the release build: type an unsaved draft, close through the native window message, confirm the window is hidden and the draft survives, reopen with a tray icon activation, repeat with the tray menu Open item, then quit through the tray menu and confirm exit code 0. The draft survived every transition and the tray menu screenshot was inspected.
- The ten-case Electron-to-Rust backup probe.
- Electron portable packaging, the Tauri portable exe build and the optional Tauri offline NSIS packaging.
- Three consecutive packaged Electron measurements and three consecutive Tauri tray runs while the desktop stayed in use.
- Browser-only preview shows that the desktop bridge is unavailable instead of pretending to save. The development server was started for this check.
- Fixture cleanup. The earlier named temporary file left four 35 to 99 byte synthetic files behind when the driver killed the process. The anonymous handle replaced it and later runs left no named fixture files. Those four files and the session's synthetic sandboxes were removed.

The tray driver opens the menu with the keyboard context-menu key because the owner-drawn popup exposes no accessible items and its icon bounds can be empty during shell reflow. It waits for a short desktop-idle window before native interaction, refuses to run while another prototype instance is open, and checks that the shell flyout owns the foreground before sending the context-menu key. Before each selection key it checks that the menu is still alive and that the shell or Maestro owns the foreground, so it cannot type into another application. Mouse input is disabled by default and is available only with `-AllowMouseFallback` for an attended run. The caption close button is not exposed through UI Automation for this WebView2 window, so the driver sends `WM_CLOSE`, the same message the button sends. WebView2 also logs `Chrome_WidgetWin_0` class cleanup noise during exit; the process still exits with code 0.

The Tauri driver keeps Windows profile environment variables intact and redirects only WebView2 storage. Replacing the Windows home variables prevented its debugging endpoint from opening on this machine. The Electron baseline still redirects all detection roots. The driver enables a localhost debugging port only in its own Tauri child; shipped configuration does not enable one. The working launch recipe can be captured with `/run-skill-generator`.

A self-review covered the command surface, capabilities, CSP, path handling and the Rust probe during this session. It tightened the oversized fixture read so it checks bytes before UTF-8 conversion and added a DPAPI null-buffer guard. It also added retrying cleanup for WebView2 profile locks.

### Phase 1 completion

The user confirmed the portable exe and the optional installer on a clean Windows environment on 2026-10-28 and approved the code review. Phase 1 has no open gates. The detailed clean-machine results are not stored in this repository.

## Phase 2 development record

Recorded on 2026-10-28. Phase 2 is complete. The Rust core is implemented and tested against synthetic fixtures only. It was not wired into the Tauri application or the Electron app during this phase; Phase 3 wired it into the Tauri app. No real configuration file, backup or key was read or written during Phase 2.

### Core crate layout

`src-tauri/` is now a Cargo workspace. The Tauri prototype remains the root package and the new Tauri-free `maestro-core` crate lives in `src-tauri/core/`. The prototype app does not depend on the core yet; Phase 3 owns the bridge.

| Module         | Responsibility                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `detection.rs` | Full port of `src/main/registry.ts`: every detected tool, folder, note and secret flag, custom entries, environment overrides and lookups |
| `paths.rs`     | Lexical cleanup, symlink and junction resolution through existing ancestors, component-wise containment and Windows case folding          |
| `files.rs`     | Registered path validation, bounded reads, SHA-256 revisions, conflict-aware writes and self-write marking                                |
| `crypto.rs`    | AES-256-GCM snapshot encryption and the DPAPI-protected history key                                                                       |
| `history.rs`   | Per-file encrypted snapshots with deduplication, retention, listing, reading, deletion and clearing                                       |
| `watch.rs`     | notify-based file and folder watching with debounce and self-write suppression                                                            |

Detection reads an injectable `DetectionEnv` instead of process globals, so XDG, `CODEX_HOME`, `QODER_CONFIG_DIR` and `CLINE_DATA_DIR` overrides are exercised without touching the real user profile. Path lookups are case-insensitive on Windows and aware of junctions through canonical resolution.

### Save protocol

1. Resolve the requested path, refuse link-like leaves and reject anything outside a registered file or folder.
2. Read disk content and compare it with the expected revision. Existing files require a matching revision. New files require no revision. A file that disappeared after loading is a conflict.
3. Re-check size and modification time before proceeding, so a change between the revision comparison and the replacement is also a conflict.
4. Snapshot existing non-empty UTF-8 content into encrypted history. A failed snapshot aborts the save.
5. Replace existing files through a temporary file in the same folder and `ReplaceFileW`, which preserves the original ACLs. Filesystems without `ReplaceFileW` fall back to `MoveFileExW`. Sharing violations retry briefly. New files are installed through the same temporary write and an atomic no-clobber hard link, with an exclusive-create fallback for filesystems without hard links.
6. Mark the written and temporary paths so the watcher ignores the save.

Deliberate limits: JSON and JSONC validation is not in the core yet, so Phase 3 still has to port the legacy pre-save syntax check. Three-way merges, multi-file journals and version-aware tool adapters remain future work. Save targets that are any Windows reparse point are refused conservatively. Existing files above 5 MiB or without valid UTF-8 content cannot be backed up losslessly, so they are refused before any write.

### Encrypted history

- Every snapshot is encrypted, not only snapshots of secret-flagged files.
- The history key is 32 random bytes stored as `history.key` in the data root. On Windows it is protected with current-user DPAPI. A missing key is generated once; an unreadable, unprotected or damaged key fails closed instead of being replaced.
- The on-disk format is `maestro-rust-enc:v1:` followed by base64 of a version marker, a 12-byte nonce and AES-256-GCM ciphertext. The wrapper prefix is authenticated as associated data. This prefix is intentionally distinct from the Electron `maestro-enc:v1:` format, which remains readable only through the Phase 1 probe.
- Per-file directory names match the Electron convention exactly: the lowercased normalized path hashed with SHA-1, truncated to 12 hex characters, plus the sanitized basename truncated to 40 characters. A fixed vector was checked against the Node implementation.
- Identical content is not stored twice, retention defaults to 20 snapshots, reads are capped at 5 MiB, and entry names reject traversal and Windows alternate data streams. Symlinked entries inside the history root are ignored.

Electron-era snapshots and their profile key are not imported or modified. The existing migration probe stays a probe; Phase 5 owns real history migration and rollback.

### Watching

File mode watches the parent folder and reports only the target and its `.tmp-` save files. Folder mode watches recursively. Both coalesce events for 250 ms, drop paths marked as self-writes for one second, and deliver a backend error to the event callback before the watch stops.

### Verification

- 45 core tests across 26 unit, 6 detection, 11 file and 2 workflow cases, plus the 4 existing prototype tests, all pass.
- Detection tests cover every bundled tool, environment overrides, China-edition Qoder, the user-local OpenCode fallback, custom file and folder entries, language inference and case-insensitive lookups.
- File tests cover missing and existing reads, creation, stale and missing revisions, deleted targets, oversized and non-UTF-8 files, outside and traversal paths, folder and reveal validation, secret classification, backup failure blocking a save, temporary-file cleanup, deduplication and junction escapes or junction targets.
- History tests cover round trips with Unicode, NUL and empty content, fresh nonces, tampering, wrong keys, DPAPI persistence, concurrent key creation, unprotected key refusal, retention, traversal, alternative-stream and device names, legacy directory naming and corrupted snapshots.
- Watch tests cover file and recursive folder events, unrelated siblings, debounce, self-write suppression and stopping.
- File symlink checks skip themselves when the account cannot create symlinks. Junction checks use `mklink /J`, which does not require administrator rights.

Rust formatting, Clippy with warnings denied and the full workspace test suite pass. The repository's typecheck, lint and format checks still pass because no TypeScript or build tooling changed.

Phase 3 added command wiring, the frontend bridge, JSON and JSONC validation and backup restoration. Formatting and Markdown preview were already renderer features and are now reachable from the Tauri app. Migration and the redesigned workspace remain in Phases 4 and 5.

## Phase 3 development record

Recorded on 2026-10-28. Phase 3 is complete. The Tauri shell runs every existing workflow against real configuration files. Electron remains the application shipped by the normal build commands, and the two versions keep separate settings and history.

### Delivered surface

| Area               | Behavior                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery          | The full `src/main/registry.ts` behavior is reachable through Tauri: every bundled tool, environment override, custom file and custom folder, with `exists`, language, secret flags, notes and sections preserved |
| Editing            | The existing React renderer is mounted unchanged through a typed bridge. CodeMirror modes, soft wrap, unsaved prompts, formatting and the Markdown preview work as in Electron                                    |
| Saving             | Loaded revisions are sent with each save. JSON and JSONC are validated in the core before a snapshot is written. A stale, deleted or externally changed file returns a conflict instead of overwriting            |
| History            | Encrypted snapshots are listed, diffed, loaded, restored, deleted and cleared through the existing history modal. A failed snapshot aborts the save                                                               |
| Folders            | Browsing, create file, create folder, rename file, rename folder and delete to the Recycle Bin. Registered roots and folders containing tracked config files are protected                                        |
| Custom entries     | Arbitrary absolute files and folders can be registered, hidden and removed. A custom file becomes an editable entry and a custom folder becomes browsable                                                         |
| Settings           | Theme, close to tray, soft wrap, hidden tools, five recent files and custom entries persist atomically in the Tauri data root                                                                                     |
| Tray and lifecycle | Tray icon with Open, up to five recent files and Quit. Close to tray hides the window and keeps the draft. A second launch focuses the existing window through the single-instance plugin                         |
| Shell integration  | Reveal in Explorer, open with the default handler, validated http, https and mailto links, and Recycle Bin deletion through the `trash` crate                                                                     |
| Watching           | One active file or folder watch, 250 ms debounce, self-write suppression and an `fs-changed` event that drives the external-change banner                                                                         |

### Command and permission surface

The Tauri app exposes 28 commands: `list_tools`, `read_file`, `write_file`, `file_stat`, `reveal_path`, `open_file`, `open_external`, `get_settings`, `set_hidden`, `set_theme`, `set_close_to_tray`, `set_soft_wrap`, `add_custom`, `remove_custom`, `push_recent`, `list_backups`, `read_backup`, `delete_backup`, `clear_backups`, `watch_file`, `watch_folder`, `list_folder`, `create_file_in`, `create_folder_in`, `rename_file`, `rename_folder`, `delete_file` and `delete_folder`.

Each command validates its path through the detected registry before touching the filesystem. The `app` capability enables `core:default` and only those 28 generated permissions for the `main` window. The content security policy allows local assets and Tauri IPC only.

### Data boundary

- The Tauri app keeps settings, the DPAPI-protected history key, encrypted snapshots and logs in its own platform app-data folder for the existing prototype identifier, normally `%APPDATA%\dev.jn-s3s.maestro.prototype` on Windows.
- It never opens `%APPDATA%\maestro`, so Electron settings, backups and the Electron profile key remain untouched.
- The legacy destructive startup resets are not ported. The `historyResetDone`, `perFileHistoryResetDone` and `secretBackupsEncrypted` flags are not read, no backup tree is deleted and no snapshot is re-encrypted at startup.
- The on-disk snapshot prefix remains `maestro-rust-enc:v1:`. Electron snapshots stay unreadable until Phase 5 imports their profile key and rewrites them.
- The identifier and the `maestro-prototype.exe` binary name are unchanged in Phase 3 so a parity build cannot collide with the shipped app. Phase 5 owns the rename, real migration and rollback.

### Deliberate differences

- Saving now carries the revision returned when the document was loaded. The bridge reads the current revision only when a caller omits it, which is the history restore path. A dirty editor over a changed file now reports a conflict instead of overwriting the external edit.
- JSON and JSONC validation moved into the core and runs before the snapshot. The 10,000-level nesting guard is preserved. `serde_json` also enforces its default 128-level recursion limit, so a deeper but otherwise valid document is rejected with an invalid JSON error. No known tool configuration reaches that depth.
- Custom entry registration now accepts arbitrary absolute paths. The Electron handler called the registered-path validator before the duplicate check, which rejected any new path outside an already registered region. The parity build fixes the documented "register any other file or folder" workflow instead of preserving the bug.
- Tauri keeps native window decorations in Phase 3. The Electron title-bar overlay and its reserved control strip are not reproduced; Phase 4 owns the new shell chrome.
- The tray Quit item carries a `&Quit` mnemonic so the UI Automation driver can activate it without depending on the recent-file count. The menu still shows Open, Recent files and Quit.

### Verification

- 63 core tests pass: 41 unit tests plus 6 detection, 14 file and 2 workflow integration tests. The 2 legacy probe tests also pass.
- Rust formatting, Clippy with warnings denied and the full workspace test suite pass with `--locked`.
- `pnpm typecheck`, `pnpm lint` and `pnpm format:check` pass.
- `node scripts/check-app.mjs parity` passes 15 checks against the release executable: discovery, open, save with encrypted backup, history encryption, invalid JSON rejected, backup restore, external change warning, Markdown preview, custom entry, folder create, folder rename, folder delete to the Recycle Bin, settings persistence, theme switching and no page errors.
- `node scripts/check-app.mjs tray` passes the tray lifecycle: native close hides the window with the draft intact, tray activation restores the draft, and tray Quit exits with code 0.
- Evidence lives in ignored `out/phase3/`: `parity.json`, `tray.json`, `history.png`, `parity.png`, `tray-reopened.png` and `tray-menu.png`.
- The parity driver launches the release executable with a synthetic home, app data, local app data and data root. It never touches the real profile or Electron data. It sends one synthetic empty file to the Recycle Bin as part of the delete check.
- Not verified: a machine without WebView2, an installed NSIS build, and real settings or history migration. Those remain Phase 5 work. No installer or application was installed on this machine.

A self-review covered the command surface, capability list, CSP, path validation, history path APIs, tray menu and the delegated path checks. It confirmed that the `@iarna/toml` formatter probes `eval("require('util').inspect")` inside a try/catch, so the strict `script-src 'self'` policy does not break TOML formatting. It also moved reserved device name checks into one shared helper so history entries and new files use the same rule.

### Commands

```powershell
pnpm app:web
pnpm app:dev
pnpm app:build
pnpm app:dist
node scripts/check-app.mjs parity
node scripts/check-app.mjs tray
```

`pnpm app:build` must run before either desktop check. A direct `cargo build --release` embeds the development URL instead of the bundled frontend and is not a valid check binary.

### Phase 3 completion

Phase 3 completion criteria are met for the existing workflows: custom entries, formatting, Markdown preview, backup restoration, folder management, settings, watching and tray behavior. Phase 4 now owns the redesigned navigation, tabs, workspaces, validation and recovery workflows. Phase 5 still owns migration, packaged beta and rollback before Electron is replaced.

## Phase 4 development record

Recorded on 2026-10-29. Phase 4 delivered the redesigned navigation shell and the essentials around tabbed editing, workspaces, validation and recovery. The Tauri app keeps its native window decorations; the new top bar sits below them. A custom title bar is deferred.

The phase also fixed a Phase 3 defect: the release app shipped without most Tailwind utilities because the Tauri Vite root is `src/app` while the shared renderer lives under `src/renderer`. Automation passed because it only checked behavior. `main.css` now declares explicit `@source` paths, and the GUI check asserts computed styles so a missing stylesheet fails the run.

### Delivered surface

| Area            | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation      | A top bar carries the workspace selector, the search trigger and the inspector toggle. The sidebar switches between Configurations, MCP and Library collections, filters configurations by text, shows favorites first and groups workspace configs separately. Close to tray, theme switching and settings keep their existing places.                                                                                                                                                                                                                                                                                      |
| Tabs            | Every open file becomes a tab with a dirty marker and a close prompt. The active editor captures its content as an in-memory draft when another tab or a folder takes over, so switching tabs does not lose unsaved edits. Activating a tab re-checks its stat, so a change made while it was in the background reloads a clean tab or marks a dirty one. Ctrl+Tab cycles tabs and Ctrl+W closes one.                                                                                                                                                                                                                        |
| Draft recovery  | Unsaved edits are also written to an encrypted draft file shortly after typing stops. Drafts survive a restart and are restored as dirty tabs with the disk revision they were edited from. Saving, reloading, discarding a conflict or closing a dirty tab deletes the draft. The Electron build keeps drafts in memory only and reports no draft capability.                                                                                                                                                                                                                                                               |
| Command palette | Ctrl+P opens a keyboard-driven palette with file switching, editor and app commands and content matches. Content search covers registered files only, skips secret-flagged and dotenv files, and returns at most five hits per file.                                                                                                                                                                                                                                                                                                                                                                                         |
| Workspaces      | A registered workspace surfaces the project configs that exist under it: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.mcp.json`, Claude project settings, OpenCode project config, Gemini project settings, Continue project config, VS Code workspace settings and Aider project config. Precedence notes appear in the editor banner. The workspace filter narrows the sidebar to one project.                                                                                                                                                                                                                                 |
| Collections     | The MCP view collects `.mcp.json`, `mcp.json` and Cline, Roo Code and Kilo Code MCP settings, including workspace files. The Library view collects skills, agents, commands, prompts, plugins and hooks folders plus AGENTS.md, CLAUDE.md and GEMINI.md. Both views have their own landing page and palette commands.                                                                                                                                                                                                                                                                                                        |
| Discovery       | Favorites are stored as a local UI preference and appear above the tool groups. The sidebar filter matches tool names, file labels and paths. Workspace entries use the same rows as built-in tools. Files carry a discovery state: available, missing, unreadable or unsupported (a link, a folder or a file above 5 MB), with distinct row markers.                                                                                                                                                                                                                                                                        |
| Validation      | Lezer parse errors appear as inline diagnostics and gutter markers for JSON, JSONC, YAML, JavaScript, TypeScript, Python and Markdown. Bundled key catalogs suggest root keys while editing MCP, Claude Code, Gemini CLI, OpenCode and VS Code JSON files, including MCP server keys inside `mcpServers`. Deprecated settings such as Claude Code `includeCoAuthoredBy` and the old VS Code terminal shell keys appear as warnings. The inspector counts problems and warnings separately and lists source, scope, disk state, revision and stored snapshots. JSON and JSONC pre-save validation remains the save authority. |
| Editing         | The inspector adds reveal, reload and history actions. The editor toolbar keeps its existing actions, now wrapping when the editor pane is narrow so the file path stays visible.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Conflict saving | A save with a stale revision opens a three-column dialog with the loaded version, the user's edits and the current disk file. The user can reload the disk version or save their own. Saving their version snapshots the disk content first, then replaces the file with a fresh revision check. The shared renderer also compares the disk content with the loaded content before calling write, so the same dialog protects the Electron build, whose write command has no revision check.                                                                                                                                 |
| History         | Snapshots can be named and pinned. Pinned snapshots are excluded from automatic pruning. The per-file retention is configurable from 1 to 100 snapshots with a default of 20. Renaming a managed file moves its encrypted history to the new path. Restore still shows the diff before writing.                                                                                                                                                                                                                                                                                                                              |

### Command and permission surface

The Tauri app now exposes 38 commands. The ten additions are `add_workspace`, `remove_workspace`, `set_history_limit`, `search_files`, `set_snapshot_meta`, `get_schema`, `check_config`, `save_draft`, `list_drafts` and `delete_draft`. The `app` capability keeps `core:default` and adds one permission for each new command. Path validation still runs before every filesystem, history or shell operation.

### Data boundary

- The Tauri app keeps settings, workspaces, the encrypted history key, encrypted snapshots, encrypted drafts and logs in its own app-data folder and never opens `%APPDATA%\maestro`.
- Workspace paths are stored in Tauri settings. Registering a workspace does not add its root as a browsable folder, so arbitrary project files are not exposed to the editor. Only the known project config files that already exist and are not links become editable entries.
- Snapshot display names and pin flags live in an unencrypted `_meta.json` file inside each per-file history folder. Snapshot contents remain encrypted. Do not use display names for secrets.
- Drafts are encrypted with the same machine-bound key as snapshots and stored one file per source path under `drafts/`. The draft payload records the revision it was edited from, so a restart can flag a file that changed in the meantime. Drafts for paths that are no longer registered stay on disk encrypted and are ignored by recovery. The Electron build keeps drafts in memory only.

### Deliberate differences and follow-ups

- The Electron build reports no workspace, content search, snapshot metadata, retention, schema advice or draft recovery capability. The shared renderer hides those controls instead of calling missing commands. Tabs, the palette's file and command modes, the inspector, favorites, conflict dialog, available and missing discovery states, MCP and Library views and inline diagnostics work in both builds. The Electron registry does not report unreadable or unsupported states, so those markers appear in the Tauri build only.
- Workspace discovery lists existing project files only. Missing project configs are not offered as empty templates.
- Duplicate workspace paths are rejected, including a path already registered as a custom entry. Nested workspaces are allowed. A workspace root must be an existing folder, and project config files that are links are skipped during discovery.
- Schema advice covers bundled top-level key catalogs for the five named JSON families plus a small settled deprecation set. It is not a full JSON Schema validator, does not validate value types and does not flag unknown keys.
- Draft recovery only restores paths that are still registered. Draft files for unregistered paths are left untouched and have no user-facing cleanup screen yet.
- MCP and Library are curated navigation views over detected entries. Creating, testing or applying shared MCP servers remains the separate MCP manager follow-up.
- Unreadable detection opens each registered file during discovery, so a path whose metadata succeeds but whose read is denied is still classified. Links, folders and files above 5 MB are reported as unsupported.
- The stale `prototype:*` scripts were removed. The `app:*` scripts are the only Tauri entry points; the retired Phase 1 files stay excluded from builds.

### Verification

- 91 Rust tests pass: 89 core tests (59 unit tests plus 8 detection, 15 file, 5 search and 2 workflow integration tests) and 2 legacy probe tests.
- Rust formatting, Clippy with warnings denied and the full workspace test suite pass with `--locked`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm build` pass.
- `node scripts/check-app.mjs parity` passes 32 checks against the release executable. The checks cover discovery, discovery states, stylesheet application, open, save with an encrypted backup, history encryption, invalid JSON rejection, backup restore, external change warning, Markdown preview, tab drafts, inline validation and inspector, deprecated setting warnings, schema suggestions, favorites, palette content search, three-way conflict resolution, snapshot naming and pinning, custom entry, workspace discovery, workspace filter, MCP navigation, library navigation, folder create, folder rename, folder delete to the Recycle Bin, settings persistence, theme switching, encrypted draft persistence, draft recovery across a restart, draft cleanup after save and no page errors.
- `node scripts/check-app.mjs tray` still passes the tray lifecycle: close hides the window with the draft intact, tray activation restores it and Quit exits with code 0.
- Evidence lives in ignored `out/phase4/`: `parity.json`, `tray.json`, `parity.png`, `draft-recovery.png`, `history.png`, `conflict.png`, `tray-reopened.png` and `tray-menu.png`.
- The parity driver uses a synthetic home, app data, local app data and data root. It never touches the real profile or Electron data. It sends one synthetic empty file to the Recycle Bin as part of the delete check.
- Not verified: a machine without WebView2, an installed NSIS build, and settings or history migration. Those remain Phase 5 work.

### Commands

```powershell
pnpm app:web
pnpm app:dev
pnpm app:build
pnpm app:dist
node scripts/check-app.mjs parity
node scripts/check-app.mjs tray
```

`pnpm app:build` must run before either desktop check. A direct `cargo build --release` embeds the development URL instead of the bundled frontend and is not a valid check binary.

### Phase 4 completion

The redesigned navigation, tabs, workspaces, validation and recovery workflows are delivered for the Tauri app. Schema key suggestions, deprecated-setting warnings, encrypted draft recovery across restarts, unreadable and unsupported discovery states, and MCP and Library navigation are now included. Phase 5 owns migration, the packaged beta and rollback before Electron is replaced.

## Phase 5 development record

Recorded on 2026-10-29. Phase 5 delivered Maestro 1 migration, the beta app identity and packaged builds. Electron remains the application shipped by the normal build commands.

### Identity and data roots

The Tauri app now uses the identifier `dev.jn-s3s.maestro` and the binary `maestro.exe`, both owned by Phase 5. Its data root is normally `%APPDATA%\dev.jn-s3s.maestro` on Windows. The Electron build keeps `%APPDATA%\maestro` unchanged. Phase 4 development data under `%APPDATA%\dev.jn-s3s.maestro.prototype` is not imported; only prototype builds used that folder.

### Migration

The Settings modal shows a Maestro 1 migration section when the Electron data root contains `settings.json` or `backups`. The import runs only when the user presses the button. It never writes, renames or deletes anything in the legacy root, so rollback is simply running Electron again.

| Area     | Behavior                                                                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings | The first import copies theme, close to tray and soft wrap, unions hidden tools, merges recent files and custom entries, and preserves Tauri-only workspaces and the history limit. Later imports do not reapply settings                                 |
| History  | Every registered file whose per-file backup folder exists in the legacy root is imported. Plain text snapshots pass through; `maestro-enc:v1` snapshots are decrypted with the Electron profile key from `Local State` and re-encrypted with the Rust key |
| Ordering | Snapshot names are preserved. Consecutive duplicate content is skipped, an existing name with different content becomes `imported-N-<name>`, and the configured retention limit runs after each file                                                      |
| Record   | `migration.json` in the Tauri data root records the time, source, counts and non-fatal warnings. Warnings list snapshot names and errors, never configuration contents                                                                                    |
| Retry    | Pressing the button again imports history that appeared later. Settings are only imported when no record exists yet                                                                                                                                       |

The profile key is read from `<legacy_root>\Local State` and unwrapped with DPAPI for the current Windows account. When the key is missing or unreadable, plain text snapshots still import and encrypted snapshots are skipped with warnings. A corrupt Electron settings file is reported and skipped. A snapshot that Electron is replacing at the exact moment it is read can be skipped; importing again picks it up.

Legacy backup folders whose names do not match a currently registered file, such as history for a removed custom entry, are counted as unmatched and left untouched. Tauri never writes the legacy root, so concurrent Electron use cannot be corrupted by the importer.

### Command and permission surface

The Tauri app now exposes 40 commands. The two additions are `legacy_status` and `import_legacy`. Both use the internally resolved Electron data root; no renderer-supplied path reaches the legacy filesystem. The `app` capability adds one permission for each command, and the Settings section is hidden in the Electron build through the `legacyImport` capability flag.

### Verification

- 108 core tests pass: 74 unit tests plus 8 detection, 15 file, 9 search and 2 workflow integration tests. The legacy probe's two decoder tests moved into `maestro-core`, and the probe binary now uses the same decoder as migration.
- Rust formatting, Clippy with warnings denied and the full workspace test suite pass with `--locked`.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm build` pass.
- `node scripts/check-app.mjs migration` passes 8 checks against the release executable. A bundled Electron fixture generates a synthetic Maestro 1 profile in a sandbox: settings, one plain text snapshot, one snapshot encrypted by Electron 44.2.0 safe storage, and an unmatched folder. The check imports from the Settings modal, verifies the merged settings, reads both snapshots back through the Tauri history API, checks the migration record, repeats the import to confirm deduplication, opens the imported custom entry and confirms the dark theme applies. It then hashes the whole legacy tree to prove it is byte-identical and runs Electron again to decode the encrypted snapshot, proving rollback.
- `node scripts/check-app.mjs parity` still passes 32 checks and `node scripts/check-app.mjs tray` still passes the tray lifecycle against the renamed release executable.
- `node scripts/check-prototype.mjs compat` still passes all ten Electron 44.2.0 backup samples through the relocated decoder.
- `pnpm app:build` produces `src-tauri/target/release/maestro.exe`. `pnpm app:dist` produces `src-tauri/target/release/bundle/nsis/Maestro_0.1.0_x64-setup.exe` at 210.84 MiB with the WebView2 offline runtime.
- Evidence lives in ignored `out/phase5/`: `parity.json`, `tray.json`, `migration.json` and `migration.png`.
- Not verified: installing the NSIS package on a clean Windows machine or one without WebView2, beta feedback, and selecting the Tauri app as the shipped release.

### Commands

```powershell
pnpm app:web
pnpm app:dev
pnpm app:build
pnpm app:dist
node scripts/check-app.mjs parity
node scripts/check-app.mjs tray
node scripts/check-app.mjs migration
node scripts/check-prototype.mjs compat
```

`pnpm app:build` must run before the desktop checks. The migration check also needs the Electron dependency installed, because it generates the synthetic Maestro 1 profile with the real safe storage implementation.

### Phase 5 completion

The migration, rollback proof, rename and beta packaging criteria are delivered. Maestro 1 settings and encrypted history can be imported through Settings without modifying the legacy data. Switching the release channel to the Tauri app and clean-machine installer verification remain release work rather than part of this phase record.
