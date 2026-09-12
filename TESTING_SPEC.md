# Maestro Test Implementation Specification

This document is a technical blueprint for an AI agent to implement a full-scale testing suite for Maestro (Electron 44 / React 19 / TypeScript strict mode). It covers infrastructure, architectural strategy, and specific test cases.

---

## 1. Testing Architecture Overview

Maestro operates across two separate processes. Testing must be decoupled accordingly.

| Layer | Scope | Tooling | Purpose |
| :--- | :--- | :--- | :--- |
| **Unit (Main)** | `src/main/*.ts` | **Vitest** | Logic, filesystem manipulation, registry detection. |
| **Unit (Renderer)** | `src/renderer/**/*` | **Vitest + React Testing Library** | UI components, state management, layout. |
| **Integration** | `src/preload/` <-> `src/main/` | **Vitest** | IPC handler communication and API contract validation. |
| **E2E (System)** | Full App Lifecycle | **Playwright** | "User journeys" (e.g., detecting a file -> editing -> backing up). |

Because this is a public repository, high test coverage is critical for contributor confidence and preventing regressions in core filesystem operations.

---

## 2. Infrastructure Setup (Phase 1)

The implementing agent MUST execute these steps to prepare the environment.

### 2.1 Dependency Installation

```powershell
pnpm add -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @playwright/test
```

### 2.2 Configuration Requirements

- **Vitest Config**: Create `vitest.config.ts` that supports both `node` environment (for `src/main`) and `jsdom` environment (for `src/renderer`).
- **TypeScript Config**: Update `tsconfig.json` to include `vitest/globals` and `jest-dom` types to avoid type errors in test files.
- **Package Scripts**: Add to `package.json`:
  - `"test": "vitest run"`
  - `"test:watch": "vitest"`
  - `"test:e2e": "playwright test"`

---

## 3. Detailed Test Suite Specification (Phase 2)

### 3.1 Main Process Logic (`src/main/`)

**Goal**: Ensure filesystem operations are atomic, safe, and accurate.

#### A. Registry Detection (`registry.ts`)
- **Scenario: Valid Tool Detection**
  - Input: Mock filesystem where `.aider.conf.yml` exists in `%USERPROFILE%`.
  - Expectation: `registry.detectTools()` returns an entry for Aider with the correct absolute path.
- **Scenario: Missing Configs**
  - Input: Empty filesystem.
  - Expectation: Return an empty array without throwing errors.
- **Scenario: Permission Denied**
  - Input: Mock a folder with restricted access (Windows equivalent).
  - Expectation: Gracefully catch the error and log it; do not crash the app.

#### B. Backup & Restore (`backups.ts`)
- **Scenario: Successful Backup**
  - Action: Trigger backup of `config.json`.
  - Expectation: A new file exists in `%APPDATA%\maestro\backups` with an identical checksum to the original.
- **Scenario: Restore from Backup**
  - Action: Modify `config.json` -> Restore from previous backup.
  - Expectation: `config.json` content matches the backup exactly.
- **Scenario: Restore Non-existent Backup**
  - Action: Request restore of a deleted backup ID.
  - Expectation: Return `{ success: false, error: "Backup not found" }`.

#### C. Store Management (`store.ts`)
- **Scenario: Persistence Loop**
  - Action: Set `theme: "dark"` -> Restart app -> Read `theme`.
  - Expectation: Value remains `"dark"`.

### 3.2 IPC & Preload Bridge (`src/preload/` & `src/shared/types.ts`)

**Goal**: Ensure the contract between frontend and backend is never broken.

- **Scenario: API Type Integrity**
  - Test: Verify that every function exposed in `src/preload/index.ts` matches the `Api` interface in `src/shared/types.ts`.
- **Scenario: IPC Payload Handling**
  - Test: Send a malformed JSON payload to a main process handler.
  - Expectation: The main process returns a structured error `{ success: false, error: ... }` instead of hanging.

### 3.3 Renderer UI (`src/renderer/`)

**Goal**: Ensure the UI is responsive and handles data correctly.

- **Component: `EditorPane`**
  - Test: Pass a JSON string -> Verify CodeMirror initializes with JSON mode.
  - Test: Simulate user typing -> Verify the internal state updates before the "Save" call.
- **Component: `PreviewPane`**
  - Test: Pass a YAML string -> Verify the rendered preview is readable and correctly formatted.

---

## 4. End-to-End (E2E) Journeys (Phase 3)

Using Playwright, the agent should automate the following "Golden Paths":

1. **The "First Run" Experience**
   - Launch App -> Wait for tool detection -> Verify at least one detected tool is visible in the sidebar.
2. **The "Edit & Save" Cycle**
   - Select a tool -> Change a value in the editor -> Click "Save" -> Verify the actual file on disk has changed.
3. **The "Safety Net" Flow**
   - Click "Backup" -> Corrupt the original file -> Click "Restore" -> Verify the file is recovered.

---

## 5. Implementation Guidelines for the AI Agent

### Critical Constraints
1. **No Real Filesystem Mutation**: For unit tests, use `memfs` or Vitest mocks to simulate the filesystem. NEVER write to the actual `%APPDATA%` folder during unit tests.
2. **Strict Typing**: All test files must be `.test.ts` or `.test.tsx`. Do not use `any`.
3. **Clean-up**: Every test involving a temporary file must have an `afterEach` block to delete said file.

### Definition of Done (DoD)
- [ ] `pnpm test` passes with 0 failures.
- [ ] `pnpm typecheck` passes including test files.
- [ ] `pnpm lint` passes.
- [ ] Core logic coverage (Registry, Backups) is > 80%.
- [ ] All E2E "Golden Paths" are green.
