import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import electron from "electron";
import { _electron, chromium } from "playwright-core";

const mode = process.argv[2];
assert(
    ["electron", "electron-packaged", "tauri", "tray", "compat"].includes(mode),
    "Usage: pnpm prototype:check electron|electron-packaged|tauri|tray|compat",
);
assert.equal(
    process.platform,
    "win32",
    "Phase 1 desktop checks require Windows",
);
const output = path.resolve("out/phase1");
await fs.mkdir(output, { recursive: true });
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "maestro-phase1-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
await Promise.all(
    [
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "CODEX_HOME",
        "QODER_CONFIG_DIR",
        "CLINE_DATA_DIR",
    ].map((key) => {
        env[key] = path.join(sandbox, key);
        return fs.mkdir(env[key], { recursive: true });
    }),
);
assert.equal(
    execFileSync(process.execPath, ["-p", 'require("node:os").homedir()'], {
        env,
        encoding: "utf8",
    }).trim(),
    env.USERPROFILE,
);

/* oxlint-disable no-await-in-loop -- WebView2 releases its profile lock asynchronously; removal must retry in order. */
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

async function run(executable, args, options = {}) {
    const child = spawn(executable, args, {
        env,
        stdio: "inherit",
        ...options,
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 0, `${path.basename(executable)} exited with ${code}`);
}

async function compatibility() {
    const entry = path.join(output, "legacy-fixtures.cjs");
    const fixtures = path.join(sandbox, "legacy-fixtures.json");
    env.MAESTRO_PROBE_USER_DATA = path.join(sandbox, "electron-probe");
    await fs.mkdir(env.MAESTRO_PROBE_USER_DATA);
    await build({
        entryPoints: ["scripts/legacy-fixtures.mjs"],
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron"],
        outfile: entry,
    });
    await run(electron, [entry, fixtures]);
    const state = JSON.parse(
        await fs.readFile(
            path.join(env.MAESTRO_PROBE_USER_DATA, "Local State"),
            "utf8",
        ),
    );
    const generated = JSON.parse(await fs.readFile(fixtures, "utf8"));
    assert.equal(
        typeof state.os_crypt?.encrypted_key,
        "string",
        "Synthetic Electron profile key is missing",
    );
    generated.encryptedKey = state.os_crypt.encrypted_key;
    await fs.writeFile(fixtures, JSON.stringify(generated));
    await run(
        "cargo",
        [
            "build",
            "--locked",
            "--manifest-path",
            "src-tauri/Cargo.toml",
            "--bin",
            "legacy-probe",
        ],
        { env: process.env },
    );
    const report = execFileSync(
        path.resolve("src-tauri/target/debug/legacy-probe.exe"),
        [fixtures],
        { env, encoding: "utf8" },
    );
    assert.equal(JSON.parse(report).success, true);
    await fs.writeFile(path.join(output, "legacy-compatibility.json"), report);
    console.log(report);
}

async function electronSample(config, executablePath, appArgs) {
    await fs.writeFile(config, '{"synthetic":true}\n');
    const started = performance.now();
    const app = await _electron.launch({
        executablePath,
        args: appArgs,
        env,
    });
    try {
        const page = await app.firstWindow();
        await page.getByText("Claude Code", { exact: true }).first().waitFor();
        const readyMs = performance.now() - started;
        const fixtureRow = page.getByTitle(config, { exact: true });
        if (!(await fixtureRow.isVisible())) {
            await page
                .getByText("Claude Code", { exact: true })
                .first()
                .click();
        }
        await fixtureRow.click();
        await page.locator(".cm-content").waitFor();
        await page.locator(".cm-content").click();
        await page.keyboard.press("Control+a");
        await page.keyboard.insertText('{"synthetic":true,"saved":true}');
        await page.keyboard.press("Control+s");
        await page.waitForFunction(
            async (target) =>
                (await globalThis.window.api.readFile(target)).content.includes(
                    '"saved":true',
                ),
            config,
        );
        const metrics = await app.evaluate(({ app: desktop }) => ({
            version: process.versions.electron,
            processes: desktop.getAppMetrics().map((entry) => ({
                type: entry.type,
                workingSetKiB: entry.memory.workingSetSize,
            })),
        }));
        await page.screenshot({ path: path.join(output, "electron.png") });
        return {
            readyMs: Math.round(readyMs),
            workingSetKiB: metrics.processes.reduce(
                (total, entry) => total + entry.workingSetKiB,
                0,
            ),
            ...metrics,
        };
    } finally {
        await app.close();
    }
}

async function electronBaseline() {
    const config = path.join(env.USERPROFILE, ".claude", "settings.json");
    await fs.mkdir(path.dirname(config), { recursive: true });
    const args = [
        path.resolve("out/main/index.js"),
        `--user-data-dir=${path.join(sandbox, "electron-user-data")}`,
    ];
    const runs = [
        await electronSample(config, electron, args),
        await electronSample(config, electron, args),
        await electronSample(config, electron, args),
    ];
    await fs.writeFile(
        path.join(output, "electron-baseline.json"),
        JSON.stringify(
            {
                measuredAt: new Date().toISOString(),
                platform: `${os.platform()} ${os.release()} ${os.arch()}`,
                node: process.version,
                build: "production renderer in unpackaged Electron",
                endpoint: "Claude Code navigation visible",
                runs,
            },
            null,
            2,
        ),
    );
    console.log(JSON.stringify(runs, null, 2));
}

async function electronPackagedBaseline() {
    const executable = path.resolve("release/phase1/win-unpacked/Maestro.exe");
    await fs.access(executable);
    const config = path.join(env.USERPROFILE, ".claude", "settings.json");
    await fs.mkdir(path.dirname(config), { recursive: true });
    const args = [
        `--user-data-dir=${path.join(sandbox, "packaged-user-data")}`,
    ];
    const runs = [
        await electronSample(config, executable, args),
        await electronSample(config, executable, args),
        await electronSample(config, executable, args),
    ];
    await fs.writeFile(
        path.join(output, "electron-packaged.json"),
        JSON.stringify(
            {
                measuredAt: new Date().toISOString(),
                platform: `${os.platform()} ${os.release()} ${os.arch()}`,
                node: process.version,
                build: "electron-builder win-unpacked package",
                endpoint: "Claude Code navigation visible",
                runs,
            },
            null,
            2,
        ),
    );
    console.log(JSON.stringify(runs, null, 2));
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

/* oxlint-disable no-await-in-loop -- Readiness probes wait for one child process and cannot run in parallel. */
async function connectWebview(child, port) {
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
        assert.equal(
            child.exitCode,
            null,
            "Prototype exited before WebView2 became ready",
        );
        let response;
        try {
            response = await fetch(`http://127.0.0.1:${port}/json/version`, {
                signal: AbortSignal.timeout(1000),
            });
        } catch (error) {
            if (performance.now() >= deadline) {
                throw error;
            }
        }
        if (response?.ok) {
            return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        }
        await delay(100);
    }
    throw new Error(
        "WebView2 debugging endpoint did not become ready within 30 seconds",
    );
}
/* oxlint-enable no-await-in-loop */

async function tauriSmoke() {
    const executable = path.resolve(
        "src-tauri/target/release/maestro-prototype.exe",
    );
    const port = 19220;
    // The debug port belongs only to this verification child, never the shipped configuration.
    try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        throw new Error(`Debugging port ${port} is already occupied`);
    } catch (error) {
        if (error.message !== "fetch failed") {
            throw error;
        }
    }
    const started = performance.now();
    const child = spawn(executable, [], {
        env: {
            ...process.env,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
            WEBVIEW2_USER_DATA_FOLDER: path.join(sandbox, "webview2"),
        },
        stdio: "inherit",
    });
    const exited = once(child, "exit");
    let browser;
    try {
        browser = await connectWebview(child, port);
        const context = browser.contexts()[0];
        const page = context.pages()[0] ?? (await context.waitForEvent("page"));
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.getByRole("status").filter({ hasText: "Ready." }).waitFor();
        const readyMs = Math.round(performance.now() - started);
        const edit = async (text) => {
            await page.locator(".cm-content").click();
            await page.keyboard.press("Control+a");
            await page.keyboard.insertText(text);
        };
        await edit('{"synthetic":"café","saved":true}\n');
        await page
            .getByRole("button", { name: "Save fixture", exact: true })
            .click();
        await page
            .getByRole("status")
            .filter({ hasText: "Saved to" })
            .waitFor();
        await page.getByRole("button", { name: "Reload", exact: true }).click();
        await page
            .getByRole("status")
            .filter({ hasText: "Reloaded" })
            .waitFor();
        assert(
            (await page.locator(".cm-content").innerText()).includes("café"),
        );
        await edit("not valid JSON");
        await page.keyboard.press("Control+s");
        await page
            .getByRole("alert")
            .filter({ hasText: "Invalid JSON" })
            .waitFor();
        assert.equal(
            await page.locator(".cm-content").innerText(),
            "not valid JSON",
        );
        await page.getByRole("button", { name: "Reload", exact: true }).click();
        await page
            .getByRole("button", { name: "Keep editing", exact: true })
            .click();
        assert.equal(
            await page.locator(".cm-content").innerText(),
            "not valid JSON",
        );
        await page.getByRole("button", { name: "Reload", exact: true }).click();
        await page
            .getByRole("button", { name: "Discard and reload", exact: true })
            .click();
        await page
            .getByRole("status")
            .filter({ hasText: "Reloaded" })
            .waitFor();
        assert(
            (await page.locator(".cm-content").innerText()).includes("café"),
        );
        await page.screenshot({ path: path.join(output, "tauri.png") });
        const memory = JSON.parse(
            execFileSync(
                "powershell.exe",
                [
                    "-NoProfile",
                    "-File",
                    path.resolve("scripts/measure-process.ps1"),
                    "-RootProcessId",
                    String(child.pid),
                ],
                { encoding: "utf8" },
            ),
        );
        await page
            .getByRole("button", { name: "Hide to tray", exact: true })
            .click();
        const hidden = JSON.parse(
            execFileSync(
                "powershell.exe",
                [
                    "-NoProfile",
                    "-File",
                    path.resolve("scripts/measure-process.ps1"),
                    "-RootProcessId",
                    String(child.pid),
                    "-AssertHidden",
                    "-WindowHandle",
                    String(memory.windowHandle),
                ],
                { encoding: "utf8" },
            ),
        );
        assert.equal(hidden.hidden, true);
        assert.deepEqual(errors, []);
        const report = {
            measuredAt: new Date().toISOString(),
            build: "release executable with CDP enabled by verification process",
            endpoint: "Rust fixture loaded",
            readyMs,
            executableBytes: (await fs.stat(executable)).size,
            memory,
            browser: await browser.version(),
            checks: [
                "edit",
                "save",
                "reload",
                "unicode",
                "invalid JSON retains draft",
                "cancel discard",
                "confirm discard",
                "hide to tray",
            ],
            pending: ["clean-machine WebView2 installation"],
        };
        await fs.writeFile(
            path.join(output, "tauri-smoke.json"),
            JSON.stringify(report, null, 2),
        );
        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (browser) {
            await browser.close();
        }
        if (child.exitCode === null) {
            child.kill();
        }
        await exited;
    }
}

async function traySmoke() {
    const executable = path.resolve(
        "src-tauri/target/release/maestro-prototype.exe",
    );
    const port = 19224;
    const profile = path.join(sandbox, "tray-webview2");
    const child = spawn(executable, [], {
        env: {
            ...process.env,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
            WEBVIEW2_USER_DATA_FOLDER: profile,
        },
        stdio: "inherit",
    });
    const exited = once(child, "exit");
    let browser;
    try {
        browser = await connectWebview(child, port);
        const context = browser.contexts()[0];
        const page = context.pages()[0] ?? (await context.waitForEvent("page"));
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.getByRole("status").filter({ hasText: "Ready." }).waitFor();
        const before = measureProcess(child.pid);
        assert(before.windowHandle > 0, "Prototype window handle is missing");
        const handle = before.windowHandle;
        await page.locator(".cm-content").click();
        await page.keyboard.press("Control+a");
        await page.keyboard.insertText('{"draft":"pending tray test"}');
        await page.getByText("Unsaved changes", { exact: true }).waitFor();
        const draft = '{"draft":"pending tray test"}';
        const closeButton = driveTray("CloseWindow", child.pid);
        const hidden = measureProcess(child.pid, [
            "-AssertHidden",
            "-WindowHandle",
            String(handle),
        ]);
        assert.equal(hidden.hidden, true);
        assert((await page.locator(".cm-content").innerText()).includes(draft));
        driveTray("Click", child.pid, ["-WindowHandle", String(handle)]);
        const reopened = measureProcess(child.pid, [
            "-AssertVisible",
            "-WindowHandle",
            String(handle),
        ]);
        assert.equal(reopened.visible, true);
        assert((await page.locator(".cm-content").innerText()).includes(draft));
        await page.screenshot({
            path: path.join(output, "tray-reopened-draft.png"),
        });
        driveTray("CloseWindow", child.pid);
        measureProcess(child.pid, [
            "-AssertHidden",
            "-WindowHandle",
            String(handle),
        ]);
        const menuOpen = driveTray("Open", child.pid, [
            "-WindowHandle",
            String(handle),
        ]);
        const menuReopened = measureProcess(child.pid, [
            "-AssertVisible",
            "-WindowHandle",
            String(handle),
        ]);
        assert.equal(menuReopened.visible, true);
        assert((await page.locator(".cm-content").innerText()).includes(draft));
        driveTray("Quit", child.pid, [
            "-ScreenshotPath",
            path.join(output, "tray-menu.png"),
        ]);
        const [code] = await Promise.race([
            exited,
            delay(15000).then(() => {
                throw new Error("Tray Quit did not exit within 15 seconds");
            }),
        ]);
        assert.equal(code, 0, "Tray Quit exited with a failure code");
        assert.deepEqual(errors, []);
        const report = {
            measuredAt: new Date().toISOString(),
            build: "release executable with CDP enabled by verification process",
            checks: [
                "native close button hides window",
                "draft survives hide",
                "tray left click reopens window",
                "draft survives reopen",
                "tray menu Open reopens window",
                "tray menu Quit exits with code 0",
            ],
            closeMethod: closeButton.method,
            menuMethod: menuOpen.method,
            memory: before,
        };
        await fs.writeFile(
            path.join(output, "tray-smoke.json"),
            JSON.stringify(report, null, 2),
        );
        console.log(JSON.stringify(report, null, 2));
    } finally {
        if (browser && child.exitCode === null) {
            await browser.close();
        }
        if (child.exitCode === null) {
            child.kill();
        }
        await exited;
    }
}

try {
    if (mode === "compat") {
        await compatibility();
    } else if (mode === "electron") {
        await electronBaseline();
    } else if (mode === "electron-packaged") {
        await electronPackagedBaseline();
    } else if (mode === "tray") {
        await traySmoke();
    } else {
        await tauriSmoke();
    }
    console.log(`Phase 1 ${mode} check completed. Evidence: ${output}`);
} catch (error) {
    console.error(`Phase 1 ${mode} check failed:`, error);
    process.exitCode = 1;
} finally {
    if (process.exitCode) {
        // Keep the synthetic sandbox for inspecting failed runs without ever touching legacy user data.
        console.log(`Synthetic sandbox kept for diagnosis: ${sandbox}`);
    } else if (await removeSandbox(sandbox)) {
        console.log(`Removed synthetic sandbox: ${sandbox}`);
    } else {
        console.log(
            `WebView2 still holds the profile; remove later: ${sandbox}`,
        );
    }
}
