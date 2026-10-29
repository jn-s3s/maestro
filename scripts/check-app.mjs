import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import electron from "electron";
import { build } from "esbuild";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const mode = process.argv[2] ?? "parity";
assert(
    ["parity", "tray", "migration"].includes(mode),
    "Usage: pnpm app:check parity|tray|migration",
);
assert.equal(process.platform, "win32", "Desktop checks require Windows");

const output = path.resolve("out/phase5");
await fs.mkdir(output, { recursive: true });
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-phase5-"));
const home = path.join(sandbox, "home");
const appdata = path.join(sandbox, "appdata");
const localappdata = path.join(sandbox, "localappdata");
const dataRoot = path.join(sandbox, "data");
const webview = path.join(sandbox, "webview2");
const settingsPath = path.join(home, ".claude", "settings.json");
const commandsDir = path.join(home, ".claude", "commands");
const geminiPath = path.join(home, ".gemini", "GEMINI.md");
const customDir = path.join(sandbox, "custom");
const customPath = path.join(customDir, "tool.json");
const workspaceDir = path.join(sandbox, "workspace");
const workspaceSettingsPath = path.join(
    workspaceDir,
    ".claude",
    "settings.json",
);
const workspaceMcpPath = path.join(workspaceDir, ".mcp.json");
const workspaceAgentsPath = path.join(workspaceDir, "AGENTS.md");
const original = '{\n  "model": "opus",\n  "theme": "dark"\n}\n';
const saved = '{"model":"sonnet","saved":true,"label":"café"}\n';
const workspaceContent = '{"workspace":"local"}\n';
const draftContent = '{"recovered":"recovered-draft"}\n';

await Promise.all(
    [
        home,
        appdata,
        localappdata,
        dataRoot,
        webview,
        commandsDir,
        customDir,
        path.dirname(workspaceSettingsPath),
        path.join(home, ".aider.conf.yml"),
    ].map((directory) => fs.mkdir(directory, { recursive: true })),
);
await fs.mkdir(path.dirname(settingsPath), { recursive: true });
await fs.mkdir(path.dirname(geminiPath), { recursive: true });
await fs.writeFile(settingsPath, original);
await fs.writeFile(workspaceSettingsPath, workspaceContent);
await fs.writeFile(
    workspaceMcpPath,
    '{"mcpServers":{"demo":{"command":"node","args":["server.js"]}}}\n',
);
await fs.writeFile(workspaceAgentsPath, "# Workspace instructions\n");
await fs.writeFile(geminiPath, "# Gemini notes\n\nHello from **Maestro**.\n");
await fs.writeFile(
    path.join(home, ".gemini", "settings.json"),
    '{"theme":"Default"}\n',
);
await fs.writeFile(customPath, '{"custom":true}\n');

const env = { ...process.env };
for (const key of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "CODEX_HOME",
    "QODER_CONFIG_DIR",
    "CLINE_DATA_DIR",
    "ELECTRON_RUN_AS_NODE",
    "ELECTRON_RENDERER_URL",
]) {
    delete env[key];
}
Object.assign(env, {
    MAESTRO_DATA_ROOT: dataRoot,
    MAESTRO_HOME: home,
    MAESTRO_APPDATA: appdata,
    MAESTRO_LOCALAPPDATA: localappdata,
    WEBVIEW2_USER_DATA_FOLDER: webview,
});

const others = execFileSync(
    "powershell.exe",
    [
        "-NoProfile",
        "-Command",
        "@(Get-Process -Name 'maestro' -ErrorAction SilentlyContinue).Count",
    ],
    { encoding: "utf8" },
).trim();
assert.equal(
    others,
    "0",
    "Close other Maestro windows before running this check",
);

/* oxlint-disable no-await-in-loop -- WebView2 releases its profile lock asynchronously. */
async function removeSandbox(target) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            await fs.rm(target, { recursive: true, force: true });
            return true;
        } catch (error) {
            if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) {
                throw error;
            }
            await delay(500);
        }
    }
    return false;
}
/* oxlint-enable no-await-in-loop */

async function assertPortFree(port) {
    try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        throw new Error(`Debugging port ${port} is already occupied`);
    } catch (error) {
        if (error.message !== "fetch failed") {
            throw error;
        }
    }
}

/* oxlint-disable no-await-in-loop -- Readiness probes wait for one child process. */
async function connectWebview(child, port) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        assert.equal(
            child.exitCode,
            null,
            "Maestro exited before WebView2 was ready",
        );
        let response;
        try {
            response = await fetch(`http://127.0.0.1:${port}/json/version`, {
                signal: AbortSignal.timeout(1000),
            });
        } catch (error) {
            if (Date.now() >= deadline) {
                throw error;
            }
        }
        if (response?.ok) {
            return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        }
        await delay(100);
    }
    throw new Error("WebView2 debugging endpoint did not become ready");
}
/* oxlint-enable no-await-in-loop */

async function launch(executable, port) {
    await assertPortFree(port);
    const child = spawn(executable, [], {
        env: {
            ...env,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
        },
        stdio: "inherit",
    });
    const exited = once(child, "exit");
    try {
        const browser = await connectWebview(child, port);
        const context = browser.contexts()[0];
        const page = context.pages()[0] ?? (await context.waitForEvent("page"));
        const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        return { child, exited, browser, page, pageErrors };
    } catch (error) {
        await terminateProcessTree(child, exited);
        throw error;
    }
}

async function terminateProcessTree(child, exited) {
    if (child.exitCode === null && child.pid) {
        try {
            execFileSync(
                "taskkill.exe",
                ["/PID", String(child.pid), "/T", "/F"],
                {
                    stdio: "ignore",
                },
            );
        } catch {
            if (child.exitCode === null) {
                child.kill();
            }
        }
    }
    if (child.exitCode === null) {
        await exited;
    }
}

async function close(instance) {
    if (instance.browser) {
        await instance.browser.close();
    }
    await terminateProcessTree(instance.child, instance.exited);
}

async function setEditor(page, text) {
    await page.locator("[data-editor-pane] .cm-content").click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText(text);
}

async function editorText(page) {
    return page.locator("[data-editor-pane] .cm-content").innerText();
}

async function openFile(page, filePath, toolName) {
    const row = page
        .locator("aside")
        .getByTitle(filePath, { exact: true })
        .last();
    if (!(await row.isVisible())) {
        await page.getByText(toolName, { exact: true }).first().click();
    }
    await row.click();
    // The toolbar shows the loaded path, so this waits for the async read even
    // when a previous document kept the editor mounted.
    await page
        .locator("[data-editor-pane]")
        .getByTitle(filePath, { exact: true })
        .waitFor();
    await page.locator("[data-editor-pane] .cm-content").waitFor();
}

async function waitForDisk(page, filePath, expected) {
    await page.waitForFunction(
        async ({ target, content }) => {
            const result = await globalThis.window.api.readFile(target);
            return result.content === content;
        },
        { target: filePath, content: expected },
        { timeout: 10000 },
    );
}

async function readSettingsFile() {
    return JSON.parse(
        await fs.readFile(path.join(dataRoot, "settings.json"), "utf8"),
    );
}

/* oxlint-disable no-await-in-loop -- Settings writes settle on disk before the next toggle. */
async function waitForSetting(key, value) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            const settings = await readSettingsFile();
            if (settings[key] === value) {
                return;
            }
        } catch {
            // The file may be mid-replacement.
        }
        await delay(100);
    }
    throw new Error(`settings.json never reported ${key}=${String(value)}`);
}
/* oxlint-enable no-await-in-loop */

/* oxlint-disable no-await-in-loop -- Snapshot folders are read one at a time. */
async function findSnapshotMeta(backupRoot, expectedName) {
    for (const dir of await fs.readdir(backupRoot)) {
        try {
            const meta = JSON.parse(
                await fs.readFile(
                    path.join(backupRoot, dir, "_meta.json"),
                    "utf8",
                ),
            );
            if (
                Object.values(meta.entries ?? {}).some(
                    (entry) =>
                        entry.name === expectedName && entry.pinned === true,
                )
            ) {
                return true;
            }
        } catch {
            // Directories without metadata are expected.
        }
    }
    return false;
}

async function waitForSnapshotMeta(backupRoot, expectedName) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (await findSnapshotMeta(backupRoot, expectedName)) {
            return;
        }
        await delay(100);
    }
    throw new Error(`snapshot metadata never stored ${expectedName}`);
}
/* oxlint-enable no-await-in-loop */

/* oxlint-disable no-await-in-loop -- Draft files settle on disk before the next check. */
async function listDraftFiles() {
    try {
        return await fs.readdir(path.join(dataRoot, "drafts"));
    } catch {
        return [];
    }
}

async function waitForDraftFiles() {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const files = await listDraftFiles();
        if (files.length > 0) {
            return files;
        }
        await delay(100);
    }
    throw new Error("no encrypted draft file was written");
}

async function waitForDraftsCleared() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if ((await listDraftFiles()).length === 0) {
            return;
        }
        await delay(100);
    }
    throw new Error("draft files were not removed after saving");
}
/* oxlint-enable no-await-in-loop */

/* oxlint-disable no-await-in-loop -- Tree hashing reads entries one at a time. */
async function hashTree(root) {
    const lines = [];
    async function walk(directory, relative) {
        for (const entry of await fs.readdir(directory, {
            withFileTypes: true,
        })) {
            const full = path.join(directory, entry.name);
            const key = path.join(relative, entry.name);
            if (entry.isDirectory()) {
                lines.push(`d:${key}`);
                await walk(full, key);
            } else if (entry.isFile()) {
                const digest = crypto
                    .createHash("sha256")
                    .update(await fs.readFile(full))
                    .digest("hex");
                lines.push(`f:${key}:${digest}`);
            }
        }
    }
    await walk(root, "");
    lines.sort();
    return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}
/* oxlint-enable no-await-in-loop */

/* oxlint-disable no-await-in-loop -- The fixture generates and verifies one profile at a time. */
async function runElectronFixture(entry, args) {
    const child = spawn(electron, [entry, ...args], {
        env: { ...env, APPDATA: appdata },
        stdio: "inherit",
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, `Electron fixture exited with ${code}`);
}

async function prepareLegacyProfile() {
    const entry = path.join(output, "legacy-profile.cjs");
    const fixturePath = path.join(sandbox, "legacy-profile.json");
    await build({
        entryPoints: ["scripts/legacy-profile.mjs"],
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron"],
        outfile: entry,
    });
    await runElectronFixture(entry, [
        "seed",
        fixturePath,
        JSON.stringify({ settingsPath, customPath }),
    ]);
    return {
        entry,
        fixturePath,
        fixture: JSON.parse(await fs.readFile(fixturePath, "utf8")),
    };
}
/* oxlint-enable no-await-in-loop */

async function migrationCheck() {
    const executable = path.resolve("src-tauri/target/release/maestro.exe");
    await fs.writeFile(settingsPath, original);
    await fs.writeFile(customPath, '{"custom":true}\n');
    const prepared = await prepareLegacyProfile();
    const legacyRoot = path.join(appdata, "maestro");
    const legacyBefore = await hashTree(legacyRoot);

    const instance = await launch(executable, 19232);
    const { page } = instance;
    const pageErrors = instance.pageErrors;
    const checks = [];
    try {
        await page
            .getByText("Claude Code", { exact: true })
            .first()
            .waitFor({ timeout: 20000 });
        const statusBefore = await page.evaluate(() =>
            globalThis.window.api.legacyStatus(),
        );
        assert.equal(statusBefore.available, true);
        assert.equal(statusBefore.alreadyImported, false);

        await page.getByTitle("Settings", { exact: true }).click();
        await page.getByText("Maestro 1 migration", { exact: true }).waitFor();
        checks.push("migration status");

        await page
            .getByRole("button", { name: "Import settings and history" })
            .click();
        await page
            .getByText(/^Imported /)
            .first()
            .waitFor({ timeout: 15000 });
        await waitForSetting("theme", "dark");
        await waitForSetting("closeToTray", true);
        await waitForSetting("softWrap", false);
        const importedSettings = await readSettingsFile();
        assert(importedSettings.hiddenTools.includes("aider"));
        assert(
            importedSettings.custom.some(
                (entry) => entry.name === "Legacy Custom",
            ),
        );
        await page.waitForFunction(() =>
            globalThis.document.documentElement.classList.contains("dark"),
        );
        checks.push("settings import");

        const backups = await page.evaluate(
            async (target) =>
                (await globalThis.window.api.listBackups(target)).entries,
            settingsPath,
        );
        assert.equal(backups.length, 2, "two imported snapshots");
        const contents = await page.evaluate(
            async (paths) =>
                Promise.all(
                    paths.map(
                        async (backupPath) =>
                            (await globalThis.window.api.readBackup(backupPath))
                                .content,
                    ),
                ),
            backups.map((entry) => entry.path),
        );
        assert(contents.includes(prepared.fixture.plainContent));
        assert(contents.includes(prepared.fixture.encryptedContent));
        checks.push("encrypted history import");

        const record = JSON.parse(
            await fs.readFile(path.join(dataRoot, "migration.json"), "utf8"),
        );
        assert.equal(record.settingsImported, true);
        assert.equal(record.snapshotsImported, 2);
        assert.equal(record.filesMatched, 1);
        assert.equal(record.unmatchedFolders, 1);
        checks.push("migration record");

        const statusAfter = await page.evaluate(() =>
            globalThis.window.api.legacyStatus(),
        );
        assert.equal(statusAfter.alreadyImported, true);
        await page
            .getByRole("button", { name: "Import new Maestro 1 history" })
            .click();
        await page.getByText("No new Maestro 1 data to import").waitFor();
        const secondRecord = JSON.parse(
            await fs.readFile(path.join(dataRoot, "migration.json"), "utf8"),
        );
        assert.equal(secondRecord.snapshotsImported, 0);
        assert.equal(secondRecord.snapshotsExisting, 2);
        checks.push("idempotent import");

        await page.getByRole("button", { name: "Done" }).click();
        await page
            .getByText("Legacy Custom", { exact: true })
            .first()
            .waitFor();
        await openFile(page, customPath, "Legacy Custom");
        assert((await editorText(page)).includes('"custom"'));
        checks.push("imported custom entry");

        await page.screenshot({ path: path.join(output, "migration.png") });
        assert.equal(
            await hashTree(legacyRoot),
            legacyBefore,
            "Maestro 1 data must stay untouched",
        );
        await runElectronFixture(prepared.entry, [
            "verify",
            prepared.fixturePath,
        ]);
        checks.push("rollback keeps Maestro 1 readable");
        assert.deepEqual(pageErrors, []);
        checks.push("no page errors");

        const report = {
            measuredAt: new Date().toISOString(),
            mode,
            executable,
            endpoint: "settings and encrypted history migration from Maestro 1",
            checks,
        };
        await fs.writeFile(
            path.join(output, "migration.json"),
            JSON.stringify(report, null, 2),
        );
        console.log(JSON.stringify(report, null, 2));
    } finally {
        await close(instance);
    }
}

async function parityCheck() {
    const executable = path.resolve("src-tauri/target/release/maestro.exe");
    let instance = await launch(executable, 19230);
    let page = instance.page;
    const pageErrors = instance.pageErrors;
    const checks = [];
    try {
        await page
            .getByText("Claude Code", { exact: true })
            .first()
            .waitFor({ timeout: 20000 });
        checks.push("discovery");

        const unsupportedRow = page
            .locator('aside [data-file-state="unsupported"]')
            .filter({ hasText: ".aider.conf.yml" });
        await unsupportedRow.waitFor();
        assert.equal(await unsupportedRow.count(), 1);
        await page
            .locator('aside [data-file-state="available"]')
            .first()
            .waitFor();
        checks.push("discovery states");

        const styling = await page.evaluate(() => ({
            headerDisplay: globalThis.getComputedStyle(
                globalThis.document.querySelector("header"),
            ).display,
            asideWidth: Number.parseFloat(
                globalThis.getComputedStyle(
                    globalThis.document.querySelector("aside"),
                ).width,
            ),
            stylesheets: globalThis.document.styleSheets.length,
        }));
        assert.equal(styling.headerDisplay, "flex");
        assert(styling.asideWidth > 200, "sidebar width comes from Tailwind");
        assert(styling.stylesheets > 0, "the stylesheet must load");
        checks.push("stylesheet applied");

        await openFile(page, settingsPath, "Claude Code");
        assert((await editorText(page)).includes('"model": "opus"'));
        checks.push("open");

        await setEditor(page, saved);
        await page.keyboard.press("Control+s");
        await page
            .getByText(/^Saved/)
            .first()
            .waitFor();
        await waitForDisk(page, settingsPath, saved);
        assert.equal(await fs.readFile(settingsPath, "utf8"), saved);
        checks.push("save with encrypted backup");

        const backupRoot = path.join(dataRoot, "backups");
        const backupDirs = await fs.readdir(backupRoot);
        assert.equal(backupDirs.length, 1, "one history folder");
        const backupFiles = await fs.readdir(
            path.join(backupRoot, backupDirs[0]),
        );
        assert(backupFiles.length >= 1, "one history snapshot");
        assert(
            !(
                await fs.readFile(
                    path.join(backupRoot, backupDirs[0], backupFiles[0]),
                    "utf8",
                )
            ).includes("opus"),
            "snapshots must be encrypted at rest",
        );
        checks.push("history encryption");

        await setEditor(page, '{"broken":');
        await page.keyboard.press("Control+s");
        await page
            .getByText(/Invalid JSON/)
            .first()
            .waitFor();
        assert.equal(await fs.readFile(settingsPath, "utf8"), saved);
        assert.equal(await editorText(page), '{"broken":');
        checks.push("invalid JSON rejected");

        await page.getByTitle("Reload from disk").click();
        await page.waitForFunction(
            (content) =>
                globalThis.document
                    .querySelector(".cm-content")
                    ?.textContent?.includes(content) ?? false,
            "sonnet",
        );

        await page.getByTitle("Backup history").click();
        await page.locator(".fixed .w-72 button").first().click();
        await page.screenshot({ path: path.join(output, "history.png") });
        await page
            .getByRole("button", { name: "Restore", exact: true })
            .click();
        await page.getByText("Restored from backup").waitFor();
        await waitForDisk(page, settingsPath, original);
        await page.waitForFunction(
            (content) =>
                globalThis.document
                    .querySelector(".cm-content")
                    ?.textContent?.includes(content) ?? false,
            "opus",
        );
        checks.push("backup restore");

        await delay(1500);
        await setEditor(page, '{"dirty":true}');
        await fs.writeFile(settingsPath, '{"external":true}\n');
        await page
            .getByText(/File changed on disk/)
            .waitFor({ timeout: 10000 });
        await page.getByRole("button", { name: "Load latest" }).click();
        await page.waitForFunction(
            () =>
                globalThis.document
                    .querySelector(".cm-content")
                    ?.textContent?.includes("external") ?? false,
        );
        checks.push("external change warning");

        await openFile(page, geminiPath, "Gemini CLI");
        await page.locator(".markdown-preview h1").waitFor();
        assert.equal(
            await page.locator(".markdown-preview h1").innerText(),
            "Gemini notes",
        );
        checks.push("markdown preview");

        assert.equal(
            await page
                .getByRole("tablist", { name: "Open configuration files" })
                .getByRole("tab")
                .count(),
            2,
        );
        await page.getByRole("tab", { name: "settings.json" }).click();
        await page.waitForFunction(
            () =>
                globalThis.document
                    .querySelector("[data-editor-pane] .cm-content")
                    ?.textContent?.includes("external") ?? false,
        );
        await setEditor(page, '{"tabdraft":true}');
        await page.getByRole("tab", { name: "GEMINI.md" }).click();
        await page.locator(".markdown-preview h1").waitFor();
        await page.getByRole("tab", { name: "settings.json" }).click();
        assert((await editorText(page)).includes("tabdraft"));
        checks.push("tabs preserve drafts");

        await page.getByTitle("Toggle inspector").click();
        await page.getByText("Inspector", { exact: true }).waitFor();
        await page
            .getByText("No validation problems", { exact: true })
            .waitFor();
        await setEditor(page, '{"broken":');
        await page.getByText(/^\d+ syntax problems?$/).waitFor();
        checks.push("inline validation and inspector");

        await setEditor(page, '{"includeCoAuthoredBy": false}');
        await page
            .getByText("1 warning", { exact: true })
            .waitFor({ timeout: 10000 });
        assert((await page.locator(".cm-lint-marker-warning").count()) > 0);
        checks.push("deprecated setting warning");

        await setEditor(page, "{\n  \n}");
        await page.keyboard.press("ArrowUp");
        await page.keyboard.press("Control+Space");
        await page
            .locator(".cm-tooltip-autocomplete")
            .getByText("permissions", { exact: true })
            .first()
            .waitFor({ timeout: 10000 });
        await page.keyboard.press("Escape");
        checks.push("schema suggestions");

        await page.getByTitle("Reload from disk").click();
        await page.waitForFunction(
            () =>
                globalThis.document
                    .querySelector("[data-editor-pane] .cm-content")
                    ?.textContent?.includes("external") ?? false,
        );
        await page.getByTitle("Toggle inspector").click();

        await page.getByTitle("Add to favorites").click();
        await page
            .locator("aside")
            .getByText("Favorites", { exact: true })
            .waitFor();
        checks.push("favorites");

        await page.keyboard.press("Control+p");
        const paletteInput = page.getByPlaceholder(
            "Search files and content, or run a command",
        );
        await paletteInput.waitFor();
        await paletteInput.fill("external");
        await page.getByText("Content matches", { exact: true }).waitFor();
        await page
            .getByRole("option", { name: /settings\.json · line/ })
            .first()
            .click();
        await page.waitForFunction(
            () =>
                globalThis.document
                    .querySelector("[data-editor-pane] .cm-content")
                    ?.textContent?.includes("external") ?? false,
        );
        assert.equal(await paletteInput.count(), 0);
        checks.push("command palette content search");

        await setEditor(page, '{"mine":true}');
        await delay(300);
        await fs.writeFile(settingsPath, '{"disk":true}\n');
        await page
            .getByText(/File changed on disk/)
            .first()
            .waitFor({ timeout: 10000 });
        await page.keyboard.press("Control+s");
        await page
            .getByRole("heading", { name: "File changed on disk" })
            .waitFor();
        await page.getByText("Your edits", { exact: true }).waitFor();
        await page.getByText("On disk", { exact: true }).waitFor();
        await page.screenshot({ path: path.join(output, "conflict.png") });
        await page.getByRole("button", { name: "Save my version" }).click();
        await page.getByText("Saved my version").waitFor();
        await waitForDisk(page, settingsPath, '{"mine":true}');
        checks.push("three-way conflict resolution");

        await page.getByTitle("Backup history").click();
        await page.locator(".fixed .w-72 button").first().click();
        const snapshotName = page.getByPlaceholder("Name this snapshot");
        await snapshotName.fill("Before conflict");
        await snapshotName.press("Tab");
        await page.getByText("Before conflict").first().waitFor();
        await page.getByTitle("Pin snapshot").click();
        await waitForSnapshotMeta(backupRoot, "Before conflict");
        await page.getByTitle("Close backup history").click();
        checks.push("snapshot naming and pinning");

        await page.getByTitle("Settings", { exact: true }).click();
        await page
            .getByPlaceholder("Display name (e.g. Cursor MCP)")
            .fill("Check Custom");
        await page
            .getByPlaceholder("C:\\Users\\you\\.some-tool\\config.json")
            .fill(customPath);
        await page.getByRole("button", { name: "Add config file" }).click();
        await page
            .getByPlaceholder("Workspace name (e.g. Maestro)")
            .fill("Check Workspace");
        await page
            .getByPlaceholder("C:\\Projects\\your-project")
            .fill(workspaceDir);
        await page.getByRole("button", { name: "Add workspace" }).click();
        await page.getByRole("button", { name: "Done" }).click();
        await page.getByText("Check Custom", { exact: true }).first().waitFor();
        await page
            .locator("aside")
            .getByText("Check Workspace", { exact: true })
            .first()
            .waitFor();
        await openFile(page, customPath, "Check Custom");
        assert((await editorText(page)).includes('"custom"'));
        checks.push("custom entry");

        await openFile(page, workspaceSettingsPath, "Check Workspace");
        assert((await editorText(page)).includes('"workspace"'));
        checks.push("workspace discovery");

        const workspaceSelector = page.getByTitle(
            "Filter configurations by workspace",
        );
        await workspaceSelector.selectOption({ label: "Check Workspace" });
        await page
            .locator("aside")
            .getByTitle(settingsPath, { exact: true })
            .waitFor({ state: "detached" });
        await page
            .locator("aside")
            .getByTitle(workspaceSettingsPath, { exact: true })
            .waitFor();
        await workspaceSelector.selectOption({ label: "All configurations" });
        await page
            .locator("aside")
            .getByTitle(settingsPath, { exact: true })
            .last()
            .waitFor();
        checks.push("workspace filter");

        await page.getByRole("tab", { name: "MCP" }).click();
        await openFile(page, workspaceMcpPath, "Check Workspace");
        assert((await editorText(page)).includes('"mcpServers"'));
        checks.push("MCP navigation");

        await page.getByRole("tab", { name: "Library" }).click();
        await page
            .locator("aside")
            .getByText("AGENTS.md", { exact: true })
            .first()
            .waitFor();
        await page
            .locator("aside")
            .getByText("commands", { exact: true })
            .first()
            .waitFor();
        checks.push("library navigation");
        await page.getByRole("tab", { name: "Configs" }).click();

        await page.getByTitle(commandsDir, { exact: true }).click();
        await page.getByPlaceholder("my-file.md").fill("parity-check.md");
        await page.getByPlaceholder("my-file.md").press("Enter");
        const createdPath = path.join(commandsDir, "parity-check.md");
        await page.getByTitle(createdPath, { exact: true }).waitFor();
        assert((await fs.stat(createdPath)).isFile());
        checks.push("folder create");

        await page
            .getByTitle(createdPath, { exact: true })
            .click({ button: "right" });
        await page
            .getByRole("menuitem", { name: "Rename" })
            .dispatchEvent("click");
        const renameInput = page.locator("ul input");
        await renameInput.fill("parity-renamed.md");
        await renameInput.press("Enter");
        const renamedPath = path.join(commandsDir, "parity-renamed.md");
        await page.getByTitle(renamedPath, { exact: true }).waitFor();
        checks.push("folder rename");

        const renamedRow = page
            .locator("li")
            .filter({ has: page.getByTitle(renamedPath, { exact: true }) });
        await renamedRow.hover();
        await renamedRow.getByTitle("Delete file").click();
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        await page.getByText("Deleted parity-renamed.md").waitFor();
        await page
            .getByTitle(renamedPath, { exact: true })
            .waitFor({ state: "detached" });
        checks.push("folder delete to recycle bin");

        await page.getByTitle("Settings", { exact: true }).click();
        const softWrap = page.locator('label:has-text("Soft wrap") input');
        await softWrap.click();
        await waitForSetting("softWrap", false);
        await softWrap.click();
        await waitForSetting("softWrap", true);
        const historyLimit = page.locator(
            'label:has-text("Snapshots per file") input',
        );
        await historyLimit.fill("5");
        await historyLimit.press("Tab");
        await waitForSetting("historyLimit", 5);
        const persisted = await readSettingsFile();
        assert(
            persisted.workspaces?.some(
                (workspace) => workspace.name === "Check Workspace",
            ),
            "workspace registration must persist",
        );
        await page.getByRole("button", { name: "Done" }).click();
        checks.push("settings persistence");

        await page.getByTitle("Light theme").click();
        await page.waitForFunction(
            () =>
                !globalThis.document.documentElement.classList.contains("dark"),
        );
        await page.getByTitle("System theme").click();
        checks.push("theme switching");

        await fs.writeFile(settingsPath, '{"external":true}\n');
        await openFile(page, settingsPath, "Claude Code");
        await page.waitForFunction(
            () =>
                globalThis.document
                    .querySelector("[data-editor-pane] .cm-content")
                    ?.textContent?.includes("external") ?? false,
        );
        await setEditor(page, draftContent);
        await delay(1200);
        const draftFiles = await waitForDraftFiles();
        assert.equal(draftFiles.length, 1, "one encrypted draft file");
        const storedDraft = await fs.readFile(
            path.join(dataRoot, "drafts", draftFiles[0]),
            "utf8",
        );
        assert(
            !storedDraft.includes("recovered-draft"),
            "draft contents must be encrypted at rest",
        );
        checks.push("encrypted draft persistence");

        await close(instance);
        await delay(500);
        instance = await launch(executable, 19231);
        pageErrors.push(...instance.pageErrors);
        instance.page.on("pageerror", (error) =>
            pageErrors.push(error.message),
        );
        page = instance.page;
        await page.waitForFunction(
            () =>
                globalThis.document
                    .querySelector("[data-editor-pane] .cm-content")
                    ?.textContent?.includes("recovered-draft") ?? false,
            undefined,
            { timeout: 30000 },
        );
        await page.screenshot({
            path: path.join(output, "draft-recovery.png"),
        });
        checks.push("draft recovery across restart");

        await page.keyboard.press("Control+s");
        await page
            .getByText(/^Saved/)
            .first()
            .waitFor();
        await waitForDraftsCleared();
        checks.push("draft cleared after save");

        await page.screenshot({ path: path.join(output, "parity.png") });
        assert.deepEqual(pageErrors, []);
        checks.push("no page errors");

        const report = {
            measuredAt: new Date().toISOString(),
            mode,
            executable,
            endpoint:
                "navigation, tabs, workspaces, validation and recovery flows",
            checks,
        };
        await fs.writeFile(
            path.join(output, "parity.json"),
            JSON.stringify(report, null, 2),
        );
        console.log(JSON.stringify(report, null, 2));
    } finally {
        await close(instance);
    }
}

function measureProcess(processId, options = []) {
    return JSON.parse(
        execFileSync(
            "powershell.exe",
            [
                "-NoProfile",
                "-File",
                path.resolve("scripts/measure-process.ps1"),
                "-RootProcessId",
                String(processId),
                ...options,
            ],
            { encoding: "utf8" },
        ),
    );
}

function driveTray(action, processId, options = []) {
    return JSON.parse(
        execFileSync(
            "powershell.exe",
            [
                "-NoProfile",
                "-File",
                path.resolve("scripts/drive-prototype-tray.ps1"),
                "-Action",
                action,
                "-RootProcessId",
                String(processId),
                ...options,
            ],
            { encoding: "utf8" },
        ),
    );
}

async function trayCheck() {
    const executable = path.resolve("src-tauri/target/release/maestro.exe");
    await fs.writeFile(
        path.join(dataRoot, "settings.json"),
        JSON.stringify(
            {
                version: 1,
                theme: "system",
                closeToTray: true,
                softWrap: true,
                hiddenTools: [],
                recentFiles: [],
                custom: [],
            },
            null,
            2,
        ),
    );
    const instance = await launch(executable, 19231);
    const { child, page, pageErrors } = instance;
    const checks = [];
    let exited = false;
    try {
        await page
            .getByText("Claude Code", { exact: true })
            .first()
            .waitFor({ timeout: 30000 });
        await openFile(page, settingsPath, "Claude Code");
        const draft = '{"draft":"pending tray test"}\n';
        await setEditor(page, draft);
        const before = measureProcess(child.pid);
        assert(before.windowHandle > 0, "window handle is missing");
        const handle = before.windowHandle;

        driveTray("CloseWindow", child.pid, ["-WindowHandle", String(handle)]);
        const hidden = measureProcess(child.pid, [
            "-AssertHidden",
            "-WindowHandle",
            String(handle),
        ]);
        assert.equal(hidden.hidden, true);
        assert((await editorText(page)).includes("pending tray test"));
        checks.push("close hides to tray with the draft intact");

        driveTray("Click", child.pid, ["-WindowHandle", String(handle)]);
        const reopened = measureProcess(child.pid, [
            "-AssertVisible",
            "-WindowHandle",
            String(handle),
        ]);
        assert.equal(reopened.visible, true);
        assert((await editorText(page)).includes("pending tray test"));
        await page.screenshot({
            path: path.join(output, "tray-reopened.png"),
        });
        checks.push("tray activation restores the draft");

        driveTray("Quit", child.pid, [
            "-ScreenshotPath",
            path.join(output, "tray-menu.png"),
        ]);
        const [code] = await Promise.race([
            instance.exited,
            delay(15000).then(() => {
                throw new Error("Tray Quit did not exit within 15 seconds");
            }),
        ]);
        exited = true;
        assert.equal(code, 0, "Tray Quit exited with a failure code");
        assert.deepEqual(pageErrors, []);
        checks.push("tray Quit exits with code 0");

        const report = {
            measuredAt: new Date().toISOString(),
            mode,
            executable,
            checks,
            memory: before,
        };
        await fs.writeFile(
            path.join(output, "tray.json"),
            JSON.stringify(report, null, 2),
        );
        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (instance.browser) {
            await instance.browser.close();
        }
        if (!exited && instance.child.exitCode === null) {
            await terminateProcessTree(instance.child, instance.exited);
        }
    }
}

try {
    if (mode === "tray") {
        await trayCheck();
    } else if (mode === "migration") {
        await migrationCheck();
    } else {
        await parityCheck();
    }
    console.log(`Phase 5 ${mode} check completed. Evidence: ${output}`);
} catch (error) {
    console.error(`Phase 5 ${mode} check failed:`, error);
    process.exitCode = 1;
} finally {
    if (process.exitCode) {
        console.log(`Synthetic sandbox kept for diagnosis: ${sandbox}`);
    } else if (await removeSandbox(sandbox)) {
        console.log(`Removed synthetic sandbox: ${sandbox}`);
    } else {
        console.log(
            `WebView2 still holds the profile; remove later: ${sandbox}`,
        );
    }
}
