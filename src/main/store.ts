import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppSettings, CustomEntry, ThemeMode } from "../shared/types";

const BASE_DIR =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const LEGACY_ROOT = path.join(BASE_DIR, "ai-config-manager");
const ROOT = path.join(BASE_DIR, "maestro");
const SETTINGS_FILE = path.join(ROOT, "settings.json");
export const BACKUPS_ROOT = path.join(ROOT, "backups");
const LOGS_DIR = path.join(ROOT, "logs");

/**
 * Moves the legacy settings folder into the current Maestro root when found.
 */
export function migrateLegacyRoot(): void {
    try {
        if (!fs.existsSync(ROOT) && fs.existsSync(LEGACY_ROOT)) {
            fs.mkdirSync(path.dirname(ROOT), { recursive: true });
            fs.renameSync(LEGACY_ROOT, ROOT);
        }
    } catch (err) {
        logError(
            "migrate-root",
            err instanceof Error ? err.message : String(err),
        );
    }
}

const THEMES: ThemeMode[] = ["system", "light", "dark"];

const DEFAULT_SETTINGS: AppSettings = {
    theme: "system",
    closeToTray: false,
    historyResetDone: false,
    perFileHistoryResetDone: false,
    hiddenTools: [],
    recentFiles: [],
    custom: [],
};

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((x): x is string => typeof x === "string")
        : [];
}

function customEntries(value: unknown): CustomEntry[] {
    return Array.isArray(value)
        ? value.filter(
              (x): x is CustomEntry =>
                  typeof x === "object" &&
                  x !== null &&
                  typeof (x as { id?: unknown }).id === "string" &&
                  typeof (x as { name?: unknown }).name === "string" &&
                  typeof (x as { path?: unknown }).path === "string",
          )
        : [];
}

/**
 * Loads the persisted app settings, with safe defaults for missing fields.
 *
 * @returns The complete settings object.
 */
export function loadSettings(): AppSettings {
    try {
        const parsed: unknown = JSON.parse(
            fs.readFileSync(SETTINGS_FILE, "utf8"),
        );
        const obj = (parsed ?? {}) as Record<string, unknown>;
        const theme =
            typeof obj.theme === "string" &&
            (THEMES as string[]).includes(obj.theme)
                ? (obj.theme as ThemeMode)
                : "system";
        return {
            theme,
            closeToTray: obj.closeToTray === true,
            historyResetDone: obj.historyResetDone === true,
            perFileHistoryResetDone: obj.perFileHistoryResetDone === true,
            hiddenTools: stringArray(obj.hiddenTools),
            recentFiles: stringArray(obj.recentFiles),
            custom: customEntries(obj.custom),
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

/**
 * Writes settings to disk atomically through a temporary file.
 *
 * @param settings - The settings object to persist.
 */
export function saveSettings(settings: AppSettings): void {
    fs.mkdirSync(ROOT, { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    fs.renameSync(tmp, SETTINGS_FILE);
}

/**
 * Appends a timestamped line to the rotating main log file.
 *
 * @param scope - Short label for the error origin.
 * @param detail - Human-readable error description.
 */
export function logError(scope: string, detail: string): void {
    try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
        const file = path.join(LOGS_DIR, "main.log");
        if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) {
            try {
                fs.unlinkSync(`${file}.old`);
            } catch {
                // ignore
            }
            try {
                fs.renameSync(file, `${file}.old`);
            } catch {
                // ignore
            }
        }
        fs.appendFileSync(
            file,
            `[${new Date().toISOString()}] ${scope}: ${detail}\n`,
            "utf8",
        );
    } catch {
        // Logging must never throw or recurse.
    }
}

/**
 * Promotes a path to the front of the recent-file list.
 *
 * @param list - The current recent-file list.
 * @param filePath - The path to promote.
 * @returns The updated list, capped at five entries.
 */
export function pushRecent(list: string[], filePath: string): string[] {
    const norm = (p: string): string => path.normalize(p).toLowerCase();
    return [filePath, ...list.filter((x) => norm(x) !== norm(filePath))].slice(
        0,
        5,
    );
}

/**
 * Computes a stable, hashed backup directory for a file.
 *
 * @param filePath - Absolute path of the source file.
 * @returns The backup directory inside the backups root.
 */
export function backupDirForFile(filePath: string): string {
    const norm = path.normalize(filePath).toLowerCase();
    const hash = crypto
        .createHash("sha1")
        .update(norm)
        .digest("hex")
        .slice(0, 12);
    const base =
        path
            .basename(filePath)
            .replace(/[^a-zA-Z0-9._-]+/g, "_")
            .slice(0, 40) || "file";
    return path.join(BACKUPS_ROOT, `${base}-${hash}`);
}

/**
 * Snapshots a file into its backup directory before it is changed.
 *
 * @param filePath - Absolute path of the file to protect.
 * @returns The snapshot path when created, or null when the content is unchanged.
 */
export function backupFile(filePath: string): string | null {
    if (!fs.existsSync(filePath)) return null;

    let current: string;
    try {
        current = fs.readFileSync(filePath, "utf8");
    } catch {
        return null;
    }

    const dir = backupDirForFile(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const all = fs.readdirSync(dir).sort();
    const latest = all[all.length - 1];
    if (latest) {
        try {
            const prev = fs.readFileSync(path.join(dir, latest), "utf8");
            if (prev === current) return null;
        } catch {
            // Ignore unreadable prior snapshot; treat as different content.
        }
    }

    const d = new Date();
    const pad2 = (n: number): string => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(
        d.getMinutes(),
    )}-${pad2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}`;
    const dest = path.join(dir, `${stamp}_${path.basename(filePath)}`);
    fs.copyFileSync(filePath, dest);
    pruneBackups(dir, 20);
    return dest;
}

function pruneBackups(dir: string, keep: number): void {
    try {
        const entries = fs.readdirSync(dir).sort();
        while (entries.length > keep) {
            const oldest = entries.shift();
            if (oldest) {
                try {
                    fs.unlinkSync(path.join(dir, oldest));
                } catch {
                    break;
                }
            }
        }
    } catch {
        // ignore
    }
}
