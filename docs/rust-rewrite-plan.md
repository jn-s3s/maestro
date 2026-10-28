# Maestro 2 Rust rewrite plan

Status: Phase 1 development in progress. The framework recommendation and feature priorities remain subject to prototype verification.

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

Recorded on 2026-10-28. Phase 1 remains open until the clean-machine distribution checks below pass. Electron remains the application shipped by the normal build commands.

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

- `src-tauri/` is the desktop shell and fixture backend. `src/prototype/` is its React frontend, using CodeMirror and the existing editor theme without the Electron bridge.
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
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
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

A self-review covered the command surface, capabilities, CSP, path handling and the Rust probe during this session. It tightened the oversized fixture read so it checks bytes before UTF-8 conversion and added a DPAPI null-buffer guard. It also added retrying cleanup for WebView2 profile locks. That review is not a substitute for the independent code and security reviewer passes.

Remaining Phase 1 checks:

- Run the portable exe on a clean Windows machine that has WebView2 and confirm coexistence with Electron. This host cannot provide a clean machine: Hyper-V management requires administrator rights and Windows Sandbox is unavailable.
- Optionally, run the NSIS installer on a clean Windows machine without WebView2, then check launch, uninstallation and coexistence with Electron. The installer was built but not executed.
- Obtain the independent code and security reviewer passes required for IPC and filesystem changes. No independent reviewer was available in this environment.

Phases 2 through 5 have not started. Tool adapters, real-file writes, watchers, encrypted Rust history, migration and the redesigned workspace remain outside this prototype.
