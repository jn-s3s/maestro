import {
    app,
    shell,
    BrowserWindow,
    ipcMain,
    Tray,
    Menu,
    nativeImage,
    nativeTheme,
} from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    detectTools,
    findContainingFolder,
    listDir,
    registeredFolderRoots,
    registeredPaths,
    stripJsonComments,
    stripTrailingCommas,
} from "./registry";
import {
    BACKUPS_ROOT,
    backupDirForFile,
    backupFile,
    loadSettings,
    logError,
    pushRecent,
    saveSettings,
} from "./store";
import {
    clearBackupsForFile,
    clearBackupsForFolder,
    deleteBackupFile,
    listBackupsForFile,
    readBackupFile,
} from "./backups";
import type {
    AppSettings,
    BackupEntry,
    OpResult,
    ReadResult,
    Tool,
    WriteResult,
} from "../shared/types";
import { langFromPath } from "../shared/types";

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    let mainWindow: BrowserWindow | null = null;
    let tray: Tray | null = null;
    let quitting = false;

    /**
     * Resolves the absolute path of a bundled resource, dev or packaged.
     *
     * @param name - File name under `resources/`.
     * @returns The resolved filesystem path.
     */
    function resourcePath(name: string): string {
        return app.isPackaged
            ? path.join(process.resourcesPath, "resources", name)
            : path.join(app.getAppPath(), "resources", name);
    }

    /**
     * Returns the title bar overlay options for the resolved theme.
     *
     * @param dark - Whether the host UI is in dark mode.
     */
    function overlayColors(dark: boolean): Electron.TitleBarOverlayOptions {
        return dark
            ? { color: "#09090b", symbolColor: "#d4d4d8", height: 36 }
            : { color: "#fafafa", symbolColor: "#52525b", height: 36 };
    }

    /**
     * Refreshes the main window title bar overlay from the current theme.
     * Swallows and logs platform errors.
     */
    function applyOverlay(): void {
        try {
            mainWindow?.setTitleBarOverlay(
                overlayColors(nativeTheme.shouldUseDarkColors),
            );
        } catch (err) {
            logError(
                "titlebar-overlay",
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    /**
     * Pushes the current theme to every open renderer window.
     */
    function broadcastTheme(): void {
        for (const w of BrowserWindow.getAllWindows()) {
            w.webContents.send(
                "theme:changed",
                nativeTheme.shouldUseDarkColors,
            );
        }
    }

    nativeTheme.on("updated", () => {
        applyOverlay();
        broadcastTheme();
    });

    /**
     * Brings the main window to the foreground, creating it if needed.
     */
    function showMainWindow(): void {
        if (!mainWindow) {
            createWindow();
            return;
        }
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
    }

    /**
     * Constructs the main BrowserWindow and loads the renderer entry.
     */
    function createWindow(): void {
        const dark = nativeTheme.shouldUseDarkColors;
        mainWindow = new BrowserWindow({
            width: 1280,
            height: 860,
            minWidth: 1000,
            minHeight: 640,
            show: false,
            autoHideMenuBar: true,
            backgroundColor: dark ? "#09090b" : "#fafafa",
            titleBarStyle: "hidden",
            titleBarOverlay: overlayColors(dark),
            title: "Maestro",
            icon: nativeImage.createFromPath(resourcePath("icon.png")),
            webPreferences: {
                preload: path.join(__dirname, "../preload/index.js"),
                spellcheck: false,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });

        mainWindow.on("ready-to-show", () => {
            mainWindow?.show();
        });

        mainWindow.on("closed", () => {
            mainWindow = null;
        });

        mainWindow.on("close", (e) => {
            if (!quitting && loadSettings().closeToTray) {
                e.preventDefault();
                mainWindow?.hide();
            }
        });

        const themeParam = dark ? "dark" : "light";
        const devUrl = process.env.ELECTRON_RENDERER_URL;
        if (devUrl) {
            void mainWindow.loadURL(`${devUrl}?theme=${themeParam}`);
        } else {
            void mainWindow.loadFile(
                path.join(__dirname, "../renderer/index.html"),
                {
                    query: { theme: themeParam },
                },
            );
        }
    }

    let toolsCache: Tool[] | null = null;

    /**
     * Returns the detected tool list, computing it on first use.
     */
    function getTools(): Tool[] {
        if (!toolsCache) {
            toolsCache = detectTools(loadSettings());
        }
        return toolsCache;
    }

    /**
     * Clears the cached tool list so the next call recomputes.
     */
    function invalidateTools(): void {
        toolsCache = null;
    }

    /**
     * Saves settings and invalidates the tool cache.
     *
     * @param settings - The settings to persist.
     */
    function persist(settings: AppSettings): AppSettings {
        saveSettings(settings);
        invalidateTools();
        return settings;
    }

    /**
     * Assembles the tray context menu, including up to five recent files.
     * Stale recent entries (paths that no longer resolve inside a
     * registered region) are pruned and persisted before rendering.
     */
    function buildTrayMenu(): Menu {
        const settings = loadSettings();
        const validRecents: string[] = [];
        const recents: Electron.MenuItemConstructorOptions[] = [];
        for (const p of settings.recentFiles.slice(0, 5)) {
            try {
                const canonical = assertRegistered(p);
                validRecents.push(canonical);
                recents.push({
                    label: path.basename(canonical) || canonical,
                    click: (): void => {
                        showMainWindow();
                        mainWindow?.webContents.send("fs:open", canonical);
                    },
                });
            } catch (err) {
                logError(
                    "tray-recent-prune",
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
        if (validRecents.length !== settings.recentFiles.length) {
            const next = { ...settings, recentFiles: validRecents };
            try {
                saveSettings(next);
            } catch (err) {
                logError(
                    "tray-recent-persist",
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
        const template: Electron.MenuItemConstructorOptions[] = [
            { label: "Open Maestro", click: () => showMainWindow() },
            ...(recents.length > 0
                ? [
                      {
                          label: "Recent files",
                          submenu: recents,
                      } satisfies Electron.MenuItemConstructorOptions,
                  ]
                : []),
            { type: "separator" },
            {
                label: "Quit",
                click: () => {
                    quitting = true;
                    app.quit();
                },
            },
        ];
        return Menu.buildFromTemplate(template);
    }

    /**
     * Creates the system tray icon, tooltip and menu. Logs on failure.
     */
    function createTray(): void {
        try {
            const img = nativeImage.createFromPath(resourcePath("tray.png"));
            const hi = resourcePath("tray-2x.png");
            if (fs.existsSync(hi)) {
                img.addRepresentation({
                    scaleFactor: 2.0,
                    buffer: fs.readFileSync(hi),
                });
            }
            tray = new Tray(img);
            tray.setToolTip("Maestro");
            tray.on("click", () => {
                showMainWindow();
            });
            tray.on("right-click", () => {
                tray?.popUpContextMenu(buildTrayMenu());
            });
        } catch (err) {
            logError("tray", err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * Returns a normalized, lower-cased path key for set lookups.
     * Lowercasing relies on Windows case-insensitive filesystems.
     */
    function normalizeKey(p: string): string {
        return path.normalize(p).toLowerCase();
    }

    /**
     * Checks if a JSON-like string has excessive nesting depth.
     * Counts opening brackets to estimate nesting level.
     *
     * @param content - The string content to check.
     * @returns true if nesting appears excessive.
     */
    function hasExcessiveNesting(content: string): boolean {
        let depth = 0;
        let maxDepth = 0;
        for (let i = 0; i < content.length; i += 1) {
            const ch = content[i];
            if (ch === "{" || ch === "[") {
                depth += 1;
                if (depth > maxDepth) {
                    maxDepth = depth;
                }
            } else if (ch === "}" || ch === "]") {
                depth = Math.max(0, depth - 1);
            }
        }
        return maxDepth > 10000;
    }

    let watcher: fs.FSWatcher | null = null;
    let watchDir: string | null = null;
    let watchBase = "";
    let watchIsDir = false;
    const notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

    /**
     * Tears down the active filesystem watcher and pending notifications.
     */
    function stopWatch(): void {
        for (const timer of notifyTimers.values()) {
            clearTimeout(timer);
        }
        notifyTimers.clear();
        if (watcher) {
            try {
                watcher.close();
            } catch (err) {
                logError(
                    "watch-close",
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
        watcher = null;
        watchDir = null;
        watchBase = "";
        watchIsDir = false;
    }

    /**
     * Coalesces rapid change events for one path into a single
     * `fs:changed` notification, debounced at 250ms.
     */
    function scheduleNotify(fullPath: string): void {
        const key = normalizeKey(fullPath);
        const existing = notifyTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            notifyTimers.delete(key);
            for (const w of BrowserWindow.getAllWindows()) {
                w.webContents.send("fs:changed", fullPath);
            }
        }, 250);
        notifyTimers.set(key, timer);
    }

    /**
     * Starts watching a file or folder, reusing the current watcher when
     * the target root has not changed.
     */
    function startWatch(target: string, dirMode = false): void {
        const dir = dirMode ? path.normalize(target) : path.dirname(target);
        const base = dirMode ? "" : path.basename(target).toLowerCase();
        if (
            watcher &&
            normalizeKey(watchDir ?? "") === normalizeKey(dir) &&
            watchIsDir === dirMode
        ) {
            watchBase = base;
            return;
        }
        stopWatch();
        try {
            watcher = fs.watch(
                dir,
                { persistent: false, recursive: dirMode },
                (_event, filename) => {
                    if (dirMode) {
                        scheduleNotify(target);
                        return;
                    }
                    const fname = filename ? filename.toLowerCase() : null;
                    // Keep in sync with the ".tmp-" prefix used by the atomic write in file:write.
                    if (
                        !fname ||
                        fname === watchBase ||
                        fname.startsWith(watchBase + ".tmp-")
                    ) {
                        scheduleNotify(target);
                    }
                },
            );
            watcher.on("error", (err) => {
                logError(
                    "watch-error",
                    err instanceof Error ? err.message : String(err),
                );
                stopWatch();
            });
            watchDir = dir;
            watchBase = base;
            watchIsDir = dirMode;
        } catch (err) {
            watcher = null;
            watchDir = null;
            logError("watch", err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * Registers an IPC handler that logs and rethrows any error.
     *
     * @param channel - The IPC channel name.
     * @param fn - The async handler implementation.
     */
    function safe(channel: string, fn: (...args: unknown[]) => unknown): void {
        ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
            try {
                return await fn(...args);
            } catch (err) {
                logError(
                    channel,
                    err instanceof Error
                        ? (err.stack ?? err.message)
                        : String(err),
                );
                throw err instanceof Error ? err : new Error(String(err));
            }
        });
    }

    /**
     * Returns true when the given real path is a registered root, sits
     * inside a registered folder, or matches a registered file exactly.
     *
     * @param tools - The detected tool list.
     * @param real - A realpath-resolved absolute path.
     */
    function isWithinRegistered(tools: Tool[], real: string): boolean {
        const key = normalizeKey(real);
        if (registeredPaths(tools).has(key)) {
            return true;
        }
        if (registeredFolderRoots(tools).has(key)) {
            return true;
        }
        if (findContainingFolder(tools, real) !== undefined) {
            return true;
        }
        return false;
    }

    /**
     * Resolves symlinks via the nearest existing ancestor so a symlink
     * planted under a registered root cannot point outside it. When the
     * trailing components do not yet exist, the existing ancestor must
     * itself be inside the registered region before the result is trusted.
     *
     * @param raw - The unvalidated path from the IPC channel.
     * @returns The canonicalized path.
     * @throws When the path is invalid or cannot be resolved.
     */
    function canonicalize(raw: unknown): string {
        if (typeof raw !== "string" || raw.trim().length === 0) {
            throw new Error("Invalid path");
        }
        const resolved = path.resolve(raw.trim());
        let probe = resolved;
        let walked = false;
        while (!fs.existsSync(probe)) {
            const parent = path.dirname(probe);
            if (parent === probe) {
                throw new Error("Invalid path");
            }
            probe = parent;
            walked = true;
        }
        let realProbe: string;
        try {
            realProbe = fs.realpathSync(probe);
        } catch {
            throw new Error("Invalid path");
        }
        if (walked && !isWithinRegistered(getTools(), realProbe)) {
            throw new Error("Path is not a registered config file");
        }
        const reconstructed = path.join(realProbe, path.relative(probe, resolved));
        if (!isWithinRegistered(getTools(), reconstructed)) {
            throw new Error("Path is not a registered config file");
        }
        return reconstructed;
    }

    /**
     * Validates that a path is a registered config file.
     *
     * @param raw - The unvalidated path from the IPC channel.
     * @returns The canonical path.
     * @throws When the path is not a registered file.
     */
    function assertRegistered(raw: unknown): string {
        const p = canonicalize(raw);
        const exact = registeredPaths(getTools()).has(normalizeKey(p));
        const inFolder = findContainingFolder(getTools(), p) !== undefined;
        if (!exact && !inFolder) {
            throw new Error("Path is not a registered config file");
        }
        return p;
    }

    /**
     * Validates that a path sits inside a registered folder.
     *
     * @param raw - The unvalidated path from the IPC channel.
     * @returns The canonical path.
     * @throws When the path is outside any registered folder.
     */
    function assertInsideFolder(raw: unknown): string {
        const p = canonicalize(raw);
        const key = normalizeKey(p);
        if (
            !registeredFolderRoots(getTools()).has(key) &&
            findContainingFolder(getTools(), p) === undefined
        ) {
            throw new Error("Folder is not registered");
        }
        if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
            throw new Error("Path is not a folder");
        }
        return p;
    }

    /**
     * Validates that a path is revealable (registered file or folder).
     *
     * @param raw - The unvalidated path from the IPC channel.
     * @returns The canonical path.
     * @throws When the path is not a registered file or folder.
     */
    function assertRevealPath(raw: unknown): string {
        const p = canonicalize(raw);
        const key = normalizeKey(p);
        const tools = getTools();
        const registered =
            registeredPaths(tools).has(key) ||
            registeredFolderRoots(tools).has(key) ||
            findContainingFolder(tools, p) !== undefined;
        if (!registered) {
            throw new Error("Path is not a registered config file");
        }
        return p;
    }

    /**
     * Registers every IPC channel that the renderer can invoke.
     */
    function registerIpc(): void {
        safe("tools:list", (): { tools: Tool[] } => ({
            tools: getTools(),
        }));

        safe("file:read", (rawPath: unknown): ReadResult => {
            const filePath = assertRegistered(rawPath);
            if (!fs.existsSync(filePath)) {
                return { exists: false, content: "", size: 0, mtime: 0 };
            }
            const st = fs.statSync(filePath);
            if (st.isDirectory()) {
                throw new Error("Path is a folder, not a file");
            }
            if (st.size > 5 * 1024 * 1024) {
                throw new Error(
                    "File is larger than 5 MB. Open it externally instead.",
                );
            }
            return {
                exists: true,
                content: fs.readFileSync(filePath, "utf8"),
                size: st.size,
                mtime: st.mtimeMs,
            };
        });

        safe(
            "file:write",
            (rawPath: unknown, content: unknown): WriteResult => {
                const filePath = assertRegistered(rawPath);
                if (typeof content !== "string") {
                    return { ok: false, error: "Invalid content" };
                }
                if (hasExcessiveNesting(content)) {
                    return { ok: false, error: "Content has excessive nesting" };
                }
                const lang = langFromPath(filePath);
                if (lang === "json") {
                    try {
                        JSON.parse(content);
                    } catch {
                        return {
                            ok: false,
                            error: "Invalid JSON. Fix syntax before saving",
                        };
                    }
                } else if (lang === "jsonc") {
                    try {
                        JSON.parse(
                            stripTrailingCommas(stripJsonComments(content)),
                        );
                    } catch {
                        return {
                            ok: false,
                            error: "Invalid JSONC. Fix syntax before saving",
                        };
                    }
                }
                const created = !fs.existsSync(filePath);
                let skipBackup = created;
                if (!created) {
                    try {
                        skipBackup = fs.statSync(filePath).size === 0;
                    } catch (err) {
                        logError(
                            "file:write-stat",
                            err instanceof Error ? err.message : String(err),
                        );
                        skipBackup = false;
                    }
                }
                let backupPath: string | null = null;
                if (!skipBackup) {
                    try {
                        backupPath = backupFile(filePath);
                    } catch (err) {
                        logError(
                            "file:write-backup",
                            err instanceof Error ? err.message : String(err),
                        );
                    }
                }
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                const tmp = `${filePath}.tmp-${Date.now()}`;
                try {
                    fs.writeFileSync(tmp, content, "utf8");
                    fs.renameSync(tmp, filePath);
                } finally {
                    try {
                        if (fs.existsSync(tmp)) {
                            fs.unlinkSync(tmp);
                        }
                    } catch (err) {
                        logError(
                            "file:write-cleanup",
                            err instanceof Error ? err.message : String(err),
                        );
                    }
                }
                return { ok: true, created, backupPath };
            },
        );

        safe("shell:reveal", (rawPath: unknown): void => {
            const p = assertRevealPath(rawPath);
            if (fs.existsSync(p)) {
                shell.showItemInFolder(p);
            } else {
                void shell.openPath(path.dirname(p));
            }
        });

        safe("shell:open", async (rawPath: unknown): Promise<OpResult> => {
            const p = assertRegistered(rawPath);
            if (!fs.existsSync(p)) {
                return { ok: false, error: "File does not exist yet" };
            }
            const err = await shell.openPath(p);
            return err ? { ok: false, error: err } : { ok: true };
        });

        safe("settings:get", (): AppSettings => loadSettings());

        safe("settings:hidden", (ids: unknown): AppSettings => {
            const settings = loadSettings();
            settings.hiddenTools = Array.isArray(ids)
                ? ids.filter((x): x is string => typeof x === "string")
                : [];
            return persist(settings);
        });

        safe("settings:theme", (mode: unknown): AppSettings => {
            const settings = loadSettings();
            if (mode === "system" || mode === "light" || mode === "dark") {
                settings.theme = mode;
                nativeTheme.themeSource = mode;
                return persist(settings);
            }
            return settings;
        });

        safe("settings:closeToTray", (value: unknown): AppSettings => {
            const settings = loadSettings();
            settings.closeToTray = value === true;
            return persist(settings);
        });

        safe("custom:add", (name: unknown, rawPath: unknown): OpResult => {
            if (typeof name !== "string" || name.trim().length === 0) {
                return { ok: false, error: "Name is required" };
            }
            if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
                return { ok: false, error: "Path is required" };
            }
            const trimmedName = name.trim();
            if (trimmedName.length > 80) {
                return { ok: false, error: "Name must be 80 characters or fewer" };
            }
            for (let i = 0; i < trimmedName.length; i += 1) {
                const code = trimmedName.charCodeAt(i);
                if (code < 0x20 || code === 0x7f) {
                    return {
                        ok: false,
                        error: "Name cannot contain control characters",
                    };
                }
            }
            const p = path.normalize(rawPath.trim());
            if (!path.isAbsolute(p)) {
                return {
                    ok: false,
                    error: "Path must be absolute (e.g. C:\\Users\\...)",
                };
            }
            const settings = loadSettings();
            const duplicateOfCustom = settings.custom.some(
                (c) => normalizeKey(c.path) === normalizeKey(p),
            );
            const duplicateOfTool = registeredPaths(getTools()).has(
                normalizeKey(canonicalize(p)),
            );
            if (duplicateOfCustom || duplicateOfTool) {
                return { ok: false, error: "This path is already registered" };
            }
            try {
                fs.accessSync(p, fs.constants.R_OK);
            } catch {
                logError(
                    "custom:add-access",
                    `Path is not yet readable: ${p}`,
                );
            }
            settings.custom.push({
                id: `custom-${randomUUID()}`,
                name: trimmedName,
                path: p,
            });
            persist(settings);
            return { ok: true };
        });

        safe("custom:remove", (id: unknown): AppSettings => {
            const settings = loadSettings();
            if (typeof id === "string") {
                settings.custom = settings.custom.filter((c) => c.id !== id);
                settings.hiddenTools = settings.hiddenTools.filter(
                    (h) => h !== id,
                );
                persist(settings);
            }
            return loadSettings();
        });

        safe("recent:push", (rawPath: unknown): void => {
            const p = assertRegistered(rawPath);
            const settings = loadSettings();
            settings.recentFiles = pushRecent(settings.recentFiles, p);
            saveSettings(settings);
        });

        safe("backups:list", (rawPath: unknown): { entries: BackupEntry[] } => {
            return { entries: listBackupsForFile(assertRegistered(rawPath)) };
        });

        safe("backups:read", (rawPath: unknown): { content: string } => {
            const filePath = assertRegistered(rawPath);
            return { content: readBackupFile(filePath) };
        });

        safe("backups:delete", (rawPath: unknown): OpResult => {
            const filePath = assertRegistered(rawPath);
            deleteBackupFile(filePath);
            return { ok: true };
        });

        safe("backups:clear", (rawPath: unknown): OpResult => {
            clearBackupsForFile(assertRegistered(rawPath));
            return { ok: true };
        });

        safe("watch:file", (rawPath: unknown): void => {
            startWatch(assertRegistered(rawPath), false);
        });

        safe("watch:folder", (rawFolder: unknown): void => {
            startWatch(assertInsideFolder(rawFolder), true);
        });

        safe(
            "file:stat",
            (rawPath: unknown): { size: number; mtime: number } | null => {
                const p = assertRegistered(rawPath);
                if (!fs.existsSync(p)) {
                    return null;
                }
                const st = fs.statSync(p);
                return { size: st.size, mtime: st.mtimeMs };
            },
        );

        safe(
            "folder:list",
            (
                rawFolder: unknown,
            ): {
                entries: ReturnType<typeof listDir>;
                exists: boolean;
            } => {
                const root = assertInsideFolder(rawFolder);
                const exists = fs.existsSync(root);
                return {
                    entries: exists ? listDir(root) : [],
                    exists,
                };
            },
        );

        safe(
            "folder:create-file",
            (rawFolder: unknown, name: unknown): OpResult => {
                const root = assertInsideFolder(rawFolder);
                const trimmed = typeof name === "string" ? name.trim() : "";
                const reserved =
                    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
                if (
                    !trimmed ||
                    !/^[^\p{Control}\\/:*?"<>|]+$/u.test(trimmed) ||
                    trimmed === "." ||
                    trimmed === ".." ||
                    trimmed.startsWith(".") ||
                    trimmed.endsWith(".") ||
                    trimmed.endsWith(" ") ||
                    reserved.test(trimmed)
                ) {
                    return { ok: false, error: "Invalid file name" };
                }
                const target = path.join(root, trimmed);
                fs.mkdirSync(root, { recursive: true });
                if (fs.existsSync(target)) {
                    return {
                        ok: false,
                        error: "A file with this name already exists",
                    };
                }
                fs.writeFileSync(target, "", "utf8");
                invalidateTools();
                return { ok: true };
            },
        );

        safe("folder:delete", (rawFolder: unknown): OpResult => {
            const p = canonicalize(rawFolder);
            const key = normalizeKey(p);
            const tools = getTools();
            const inside =
                registeredFolderRoots(tools).has(key) ||
                findContainingFolder(tools, p) !== undefined;
            if (!inside) {
                return { ok: false, error: "Folder is not registered" };
            }
            if (registeredFolderRoots(tools).has(key)) {
                return {
                    ok: false,
                    error: "The root folder cannot be deleted here",
                };
            }
            if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
                return { ok: false, error: "Folder does not exist" };
            }
            const trackedBefore = registeredPaths(tools);
            for (const tracked of trackedBefore) {
                const rel = path.relative(p, tracked);
                if (
                    rel === "" ||
                    (!rel.startsWith("..") && !path.isAbsolute(rel))
                ) {
                    return {
                        ok: false,
                        error: "Folder contains tracked config files",
                    };
                }
            }
            const toolsFresh = getTools();
            const trackedAfter = registeredPaths(toolsFresh);
            for (const tracked of trackedAfter) {
                const rel = path.relative(p, tracked);
                if (
                    rel === "" ||
                    (!rel.startsWith("..") && !path.isAbsolute(rel))
                ) {
                    return {
                        ok: false,
                        error: "Folder contains tracked config files",
                    };
                }
            }
            fs.rmSync(p, { recursive: true, force: true });
            try {
                clearBackupsForFolder(p);
            } catch (err) {
                logError(
                    "folder:delete-backup-cleanup",
                    err instanceof Error ? err.message : String(err),
                );
            }
            invalidateTools();
            return { ok: true };
        });

        safe("file:delete", (rawPath: unknown): OpResult => {
            const p = assertRegistered(rawPath);
            if (!fs.existsSync(p)) {
                return { ok: false, error: "File does not exist" };
            }
            if (fs.statSync(p).isDirectory()) {
                return { ok: false, error: "Cannot delete a directory" };
            }
            if (registeredPaths(getTools()).has(normalizeKey(p))) {
                return {
                    ok: false,
                    error: "Root config files cannot be deleted here",
                };
            }
            fs.unlinkSync(p);
            try {
                fs.rmSync(backupDirForFile(p), {
                    recursive: true,
                    force: true,
                });
            } catch (err) {
                logError(
                    "file:delete-backup-cleanup",
                    err instanceof Error ? err.message : String(err),
                );
            }
            invalidateTools();
            return { ok: true };
        });
    }

    void app
        .whenReady()
        .then(() => {
            const settings = loadSettings();
            let settingsDirty = false;
            const resetBackups = (): void => {
                try {
                    fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
                } catch (err) {
                    logError(
                        "backup-reset",
                        err instanceof Error ? err.message : String(err),
                    );
                }
            };
            if (!settings.historyResetDone) {
                resetBackups();
                settings.historyResetDone = true;
                settingsDirty = true;
            }
            if (!settings.perFileHistoryResetDone) {
                resetBackups();
                settings.perFileHistoryResetDone = true;
                settingsDirty = true;
            }
            if (settingsDirty) {
                saveSettings(settings);
            }
            nativeTheme.themeSource = settings.theme;
            registerIpc();
            createWindow();
            createTray();
            app.on("activate", () => {
                if (BrowserWindow.getAllWindows().length === 0) {
                    createWindow();
                }
            });
        })
        .catch((err) => {
            logError(
                "startup",
                err instanceof Error ? err.message : String(err),
            );
        });

    app.on("second-instance", () => {
        showMainWindow();
    });

    app.on("before-quit", () => {
        quitting = true;
        stopWatch();
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") {
            app.quit();
        }
    });
}
