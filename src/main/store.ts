import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeStorage } from "electron";
import type { AppSettings, CustomEntry, ThemeMode } from "../shared/types";

// Canonical Maestro data root. Keep in sync with the same expression in
// scripts/clear-data.mjs and scripts/dump-logs.mjs.
const BASE_DIR =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
export const DATA_ROOT = path.join(BASE_DIR, "maestro");
const SETTINGS_FILE = path.join(DATA_ROOT, "settings.json");
export const BACKUPS_ROOT = path.join(DATA_ROOT, "backups");
const LOGS_DIR = path.join(DATA_ROOT, "logs");

/**
 * Marker prefix identifying an encrypted backup blob, followed by base64
 * encoded safe storage ciphertext.
 */
export const BACKUP_ENC_PREFIX = "maestro-enc:v1:";

const THEMES: ThemeMode[] = ["system", "light", "dark"];

/**
 * The current settings schema version written to disk. Bump this and
 * add a migration step in {@link migrateSettings} when the shape of
 * `AppSettings` changes in a way that needs data preservation.
 */
export const SETTINGS_VERSION = 1;

const DEFAULT_SETTINGS: AppSettings = {
    version: SETTINGS_VERSION,
    theme: "system",
    closeToTray: false,
    softWrap: true,
    historyResetDone: false,
    perFileHistoryResetDone: false,
    secretBackupsEncrypted: false,
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
 * Files without a matching `version` are treated as defaults so any
 * shape mismatch from a future migration is recoverable by deleting
 * `settings.json`.
 *
 * @returns The complete settings object.
 */
export function loadSettings(): AppSettings {
    let obj: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(
            fs.readFileSync(SETTINGS_FILE, "utf8"),
        );
        obj = (parsed ?? {}) as Record<string, unknown>;
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
    const theme =
        typeof obj.theme === "string" &&
        (THEMES as string[]).includes(obj.theme)
            ? (obj.theme as ThemeMode)
            : "system";
    return {
        version: SETTINGS_VERSION,
        theme,
        closeToTray: obj.closeToTray === true,
        softWrap: obj.softWrap !== false,
        historyResetDone: obj.historyResetDone === true,
        perFileHistoryResetDone: obj.perFileHistoryResetDone === true,
        secretBackupsEncrypted: obj.secretBackupsEncrypted === true,
        hiddenTools: stringArray(obj.hiddenTools),
        recentFiles: stringArray(obj.recentFiles),
        custom: customEntries(obj.custom),
    };
}

/**
 * Writes settings to disk atomically through a temporary file.
 *
 * @param settings - The settings object to persist.
 */
export function saveSettings(settings: AppSettings): void {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
    fs.renameSync(tmp, SETTINGS_FILE);
}

/**
 * Appends a timestamped line to the rotating main log file. When the
 * file write itself fails (disk full, permissions, missing directory),
 * the same line is mirrored to stderr so the failure is not silent.
 *
 * @param scope - Short label for the error origin.
 * @param detail - Human-readable error description.
 */
export function logError(scope: string, detail: string): void {
    const line = `[${new Date().toISOString()}] ${scope}: ${detail}\n`;
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
        fs.appendFileSync(file, line, "utf8");
    } catch (err) {
        // Logging must never throw or recurse, but a silent failure
        // hides real operational issues, so surface both the original
        // detail and the secondary error to stderr.
        try {
            process.stderr.write(
                `logError fallback for ${scope}: ${detail}` +
                    (err instanceof Error ? ` (${err.message})` : "") +
                    "\n",
            );
        } catch {
            // give up
        }
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
 * Encrypts backup text into the versioned on-disk blob format using the
 * OS provided safe storage (DPAPI on Windows).
 *
 * @param text - The plaintext backup content.
 * @returns The marked blob to persist.
 */
export function encodeStoredBackup(text: string): string {
    return (
        BACKUP_ENC_PREFIX + safeStorage.encryptString(text).toString("base64")
    );
}

/**
 * Decodes stored backup text, decrypting marked blobs. Plaintext content
 * passes through unchanged so legacy backups stay readable.
 *
 * @param text - The raw stored backup text.
 * @returns The decrypted plaintext.
 * @throws When a marked blob cannot be decrypted on this machine.
 */
export function decodeStoredBackup(text: string): string {
    if (!text.startsWith(BACKUP_ENC_PREFIX)) return text;
    try {
        return safeStorage.decryptString(
            Buffer.from(text.slice(BACKUP_ENC_PREFIX.length), "base64"),
        );
    } catch {
        throw new Error("Backup cannot be decrypted on this machine");
    }
}

/**
 * Returns the file size, or null when the file cannot be stat'd.
 *
 * @param p - Absolute path to inspect.
 * @returns The size in bytes, or null.
 */
function stat(p: string): number | null {
    try {
        return fs.statSync(p).size;
    } catch {
        return null;
    }
}

/**
 * Reads a file as UTF-8 text, returning null on failure.
 *
 * @param p - Absolute path to read.
 * @returns The text content, or null.
 */
function readUtf8(p: string): string | null {
    try {
        return fs.readFileSync(p, "utf8");
    } catch {
        return null;
    }
}

/**
 * Reads stored backup text and decodes it, returning null when the file
 * cannot be read or decrypted.
 *
 * @param p - Absolute path of the stored backup.
 * @returns The decoded plaintext, or null.
 */
function readStoredText(p: string): string | null {
    try {
        return decodeStoredBackup(fs.readFileSync(p, "utf8"));
    } catch {
        return null;
    }
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
 * Snapshots a file into its backup directory before it is changed. Secret
 * files are stored encrypted through safe storage; when encryption is
 * unavailable the backup is skipped instead of writing plaintext secrets.
 *
 * @param filePath - Absolute path of the file to protect.
 * @param options - `secret` enables encryption, `fd` pins the source handle.
 * @returns The snapshot path when created, or null when skipped or unchanged.
 */
export function backupFile(
    filePath: string,
    options: { secret?: boolean; fd?: number | null } = {},
): string | null {
    const secret = options.secret === true;
    if (secret && !safeStorage.isEncryptionAvailable()) {
        logError(
            "backup-encrypt",
            `Encryption unavailable; skipped secret backup for ${filePath}`,
        );
        return null;
    }

    // Prefer the locked descriptor from the caller so a racing symlink swap
    // cannot redirect the snapshot at a different file.
    let currentSize: number | null = null;
    let current: string | null = null;
    if (typeof options.fd === "number") {
        try {
            const st = fs.fstatSync(options.fd);
            currentSize = st.size;
            current = fs.readFileSync(options.fd, "utf8");
        } catch {
            currentSize = null;
            current = null;
        }
    }
    if (currentSize === null) {
        currentSize = stat(filePath);
        if (currentSize === null) return null;
    }
    if (current === null) {
        current = readUtf8(filePath);
        if (current === null) return null;
    }

    const dir = backupDirForFile(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const all = fs.readdirSync(dir).sort();
    const latest = all[all.length - 1];
    if (latest) {
        const latestPath = path.join(dir, latest);
        if (secret) {
            // Encrypted blobs are non-deterministic, so dedup compares
            // decrypted content instead of file sizes.
            const prev = readStoredText(latestPath);
            if (prev !== null && prev === current) return null;
        } else {
            const prevSize = stat(latestPath);
            if (prevSize !== null && prevSize === currentSize) {
                const prev = readStoredText(latestPath);
                if (prev !== null && prev === current) return null;
            }
        }
    }

    const d = new Date();
    const pad2 = (n: number): string => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(
        d.getMinutes(),
    )}-${pad2(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, "0")}`;
    const dest = path.join(dir, `${stamp}_${path.basename(filePath)}`);
    if (secret) {
        fs.writeFileSync(dest, encodeStoredBackup(current), "utf8");
    } else {
        fs.writeFileSync(dest, current, "utf8");
    }
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
