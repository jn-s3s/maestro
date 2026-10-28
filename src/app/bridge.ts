import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
    Api,
    AppSettings,
    BackupEntry,
    DirEntry,
    FileStat,
    OpResult,
    ThemeMode,
    Tool,
} from "../shared/types";

const RUNTIME_MISSING =
    "The desktop runtime is required. Start Maestro with pnpm app:dev.";

interface TauriRead {
    exists: boolean;
    content: string;
    size: number;
    mtime: number;
    revision: string | null;
}

interface TauriWrite {
    created: boolean;
    revision: string;
    backupPath: string | null;
}

interface TauriBackups {
    entries: BackupEntry[];
}

interface TauriFolder {
    entries: DirEntry[];
    exists: boolean;
}

let themeMode: ThemeMode = "system";
const themeListeners = new Set<(dark: boolean) => void>();
const darkPreference = window.matchMedia("(prefers-color-scheme: dark)");

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function effectiveDark(): boolean {
    return (
        themeMode === "dark" ||
        (themeMode === "system" && darkPreference.matches)
    );
}

function publishTheme(): void {
    const dark = effectiveDark();
    for (const listener of themeListeners) {
        listener(dark);
    }
}

/**
 * Subscribes a renderer callback to a Tauri event.
 *
 * @param event - The event name emitted by the backend.
 * @param callback - The payload handler.
 * @returns A teardown function that stops listening.
 */
function subscribe<T>(
    event: string,
    callback: (payload: T) => void,
): () => void {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<T>(event, (message) => callback(message.payload))
        .then((teardown) => {
            if (disposed) {
                teardown();
            } else {
                unlisten = teardown;
            }
        })
        .catch((error: unknown) => {
            console.error(`Listen for ${event}: ${errorText(error)}`);
        });
    return () => {
        disposed = true;
        unlisten?.();
        unlisten = null;
    };
}

function createApi(): Api {
    return {
        listTools: () => invoke<{ tools: Tool[] }>("list_tools"),
        readFile: (path) => invoke<TauriRead>("read_file", { path }),
        writeFile: async (path, content, expectedRevision) => {
            try {
                let expected = expectedRevision;
                if (expected === undefined) {
                    const current = await invoke<TauriRead>("read_file", {
                        path,
                    });
                    expected = current.exists ? current.revision : null;
                }
                const result = await invoke<TauriWrite>("write_file", {
                    path,
                    content,
                    expectedRevision: expected ?? null,
                });
                return {
                    ok: true,
                    created: result.created,
                    backupPath: result.backupPath,
                    revision: result.revision,
                };
            } catch (error) {
                return { ok: false, error: errorText(error) };
            }
        },
        reveal: (path) => invoke<void>("reveal_path", { path }),
        openFile: async (path) => {
            try {
                return await invoke<OpResult>("open_file", { path });
            } catch (error) {
                return { ok: false, error: errorText(error) };
            }
        },
        openExternal: async (url) => {
            try {
                await invoke<void>("open_external", { url });
            } catch (error) {
                console.warn(`Open ${url}: ${errorText(error)}`);
            }
        },
        getSettings: () => invoke<AppSettings>("get_settings"),
        setHidden: (toolIds) => invoke<AppSettings>("set_hidden", { toolIds }),
        setTheme: async (mode) => {
            const settings = await invoke<AppSettings>("set_theme", { mode });
            themeMode = settings.theme;
            publishTheme();
            return settings;
        },
        setCloseToTray: (value) =>
            invoke<AppSettings>("set_close_to_tray", { value }),
        setSoftWrap: (value) => invoke<AppSettings>("set_soft_wrap", { value }),
        addCustom: async (name, path) => {
            try {
                return await invoke<OpResult>("add_custom", { name, path });
            } catch (error) {
                return { ok: false, error: errorText(error) };
            }
        },
        removeCustom: (id) => invoke<AppSettings>("remove_custom", { id }),
        pushRecent: (path) => invoke<void>("push_recent", { path }),
        listBackups: (filePath) =>
            invoke<TauriBackups>("list_backups", { filePath }),
        readBackup: async (backupPath) => ({
            content: await invoke<string>("read_backup", { backupPath }),
        }),
        deleteBackup: (backupPath) =>
            invoke<OpResult>("delete_backup", { backupPath }),
        clearBackups: (filePath) =>
            invoke<OpResult>("clear_backups", { filePath }),
        watchFile: (path) => invoke<void>("watch_file", { path }),
        watchFolder: (folderPath) =>
            invoke<void>("watch_folder", { folderPath }),
        fileStat: (path) => invoke<FileStat | null>("file_stat", { path }),
        onFileChanged: (callback) => subscribe<string>("fs-changed", callback),
        onThemeChanged: (callback) => {
            themeListeners.add(callback);
            return () => {
                themeListeners.delete(callback);
            };
        },
        onOpenFile: (callback) => subscribe<string>("fs-open", callback),
        listFolder: (folderPath) =>
            invoke<TauriFolder>("list_folder", { folderPath }),
        createFileIn: (folderPath, name) =>
            invoke<OpResult>("create_file_in", { folderPath, name }),
        createFolderIn: (folderPath, name) =>
            invoke<OpResult>("create_folder_in", { folderPath, name }),
        deleteFile: (path) => invoke<OpResult>("delete_file", { path }),
        deleteFolder: (folderPath) =>
            invoke<OpResult>("delete_folder", { folderPath }),
        renameFile: (path, newName) =>
            invoke<OpResult>("rename_file", { path, newName }),
        renameFolder: (folderPath, newName) =>
            invoke<OpResult>("rename_folder", { folderPath, newName }),
    };
}

/**
 * Installs the Tauri-backed `window.api` bridge and resolves the initial
 * colour scheme from the persisted theme setting.
 *
 * @returns Whether the window should start in dark mode.
 * @throws When the page is not running inside the Tauri desktop shell.
 */
export async function installTauriBridge(): Promise<boolean> {
    if (!isTauri()) {
        throw new Error(RUNTIME_MISSING);
    }
    document.documentElement.classList.add("tauri-app");
    const settings = await invoke<AppSettings>("get_settings");
    themeMode = settings.theme;
    darkPreference.addEventListener("change", () => {
        if (themeMode === "system") {
            publishTheme();
        }
    });
    window.api = createApi();
    return effectiveDark();
}
