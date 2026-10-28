import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const mode = process.argv[2] ?? "parity";
assert(["parity", "tray"].includes(mode), "Usage: pnpm app:check parity|tray");
assert.equal(process.platform, "win32", "Desktop checks require Windows");

const output = path.resolve("out/phase3");
await fs.mkdir(output, { recursive: true });
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-phase3-"));
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
const original = '{\n  "model": "opus",\n  "theme": "dark"\n}\n';
const saved = '{"model":"sonnet","saved":true,"label":"café"}\n';

await Promise.all(
    [
        home,
        appdata,
        localappdata,
        dataRoot,
        webview,
        commandsDir,
        customDir,
    ].map((directory) => fs.mkdir(directory, { recursive: true })),
);
await fs.mkdir(path.dirname(settingsPath), { recursive: true });
await fs.mkdir(path.dirname(geminiPath), { recursive: true });
await fs.writeFile(settingsPath, original);
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
        "@(Get-Process -Name 'maestro-prototype' -ErrorAction SilentlyContinue).Count",
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
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            await fs.rm(target, { recursive: true, force: true });
            return true;
        } catch (error) {
            if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) {
                throw error;
            }
            await delay(300);
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
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText(text);
}

async function editorText(page) {
    return page.locator(".cm-content").innerText();
}

async function openFile(page, filePath, toolName) {
    const row = page.getByTitle(filePath, { exact: true });
    if (!(await row.isVisible())) {
        await page.getByText(toolName, { exact: true }).first().click();
    }
    await row.click();
    // The toolbar shows the loaded path, so this waits for the async read even
    // when a previous document kept the editor mounted.
    await page.locator("main").getByTitle(filePath, { exact: true }).waitFor();
    await page.locator(".cm-content").waitFor();
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

async function parityCheck() {
    const executable = path.resolve(
        "src-tauri/target/release/maestro-prototype.exe",
    );
    const instance = await launch(executable, 19230);
    const { page, pageErrors } = instance;
    const checks = [];
    try {
        await page
            .getByText("Claude Code", { exact: true })
            .first()
            .waitFor({ timeout: 20000 });
        checks.push("discovery");

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

        await page.getByTitle("Settings", { exact: true }).click();
        await page
            .getByPlaceholder("Display name (e.g. Cursor MCP)")
            .fill("Check Custom");
        await page
            .getByPlaceholder("C:\\Users\\you\\.some-tool\\config.json")
            .fill(customPath);
        await page.getByRole("button", { name: "Add config file" }).click();
        await page.getByRole("button", { name: "Done" }).click();
        await page.getByText("Check Custom", { exact: true }).first().waitFor();
        await openFile(page, customPath, "Check Custom");
        assert((await editorText(page)).includes('"custom"'));
        checks.push("custom entry");

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
        await page.getByTitle(settingsPath, { exact: true }).click();
        await page.locator(".cm-content").waitFor();
        await page.screenshot({ path: path.join(output, "parity.png") });
        assert.deepEqual(pageErrors, []);
        checks.push("no page errors");

        const report = {
            measuredAt: new Date().toISOString(),
            mode,
            executable,
            endpoint: "Claude Code navigation visible",
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
    const executable = path.resolve(
        "src-tauri/target/release/maestro-prototype.exe",
    );
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
    } else {
        await parityCheck();
    }
    console.log(`Phase 3 ${mode} check completed. Evidence: ${output}`);
} catch (error) {
    console.error(`Phase 3 ${mode} check failed:`, error);
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
