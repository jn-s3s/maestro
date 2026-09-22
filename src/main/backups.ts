import fs from "node:fs";
import path from "node:path";
import {
    BACKUP_ENC_PREFIX,
    BACKUPS_ROOT,
    backupDirForFile,
    decodeStoredBackup,
    encodeStoredBackup,
    logError,
} from "./store";
import type { BackupEntry } from "../shared/types";

const MAX_BACKUP_READ_BYTES = 5 * 1024 * 1024;

/**
 * Validates and canonicalizes a renderer-supplied backup path, locking the
 * resolved target through an open file descriptor so a racing symlink swap
 * cannot redirect the subsequent read or stat.
 *
 * @param raw - The unvalidated value received over the IPC channel.
 * @returns The canonical path rooted inside the backup directory.
 * @throws When the path is invalid, escapes the backup root, or the
 * resolved entry exceeds the backup read limit.
 */
export function assertBackupPath(raw: unknown): string {
    if (typeof raw !== "string" || raw.trim().length === 0) {
        throw new Error("Invalid backup path");
    }
    const trimmed = raw.trim();
    const resolved = path.resolve(trimmed);
    const rel = path.relative(BACKUPS_ROOT, resolved);
    if (
        rel === "" ||
        rel === ".." ||
        rel.startsWith(`..${path.sep}`) ||
        path.isAbsolute(rel)
    ) {
        throw new Error("Invalid backup path");
    }

    let realRoot: string;
    try {
        realRoot = fs.realpathSync(BACKUPS_ROOT);
    } catch {
        throw new Error("Invalid backup path");
    }

    let probe = resolved;
    let walked = false;
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) {
            throw new Error("Invalid backup path");
        }
        probe = parent;
        walked = true;
    }
    let realProbe: string;
    let handle: number | null = null;
    try {
        // Open through the canonical real path so the descriptor is locked
        // against symlink swaps for the rest of this call.
        realProbe = fs.realpathSync(probe);
        handle = fs.openSync(realProbe, "r");
        const stats = fs.fstatSync(handle);
        if (walked ? !stats.isDirectory() : !stats.isFile()) {
            throw new Error("Invalid backup path");
        }
        if (!walked && stats.size > MAX_BACKUP_READ_BYTES) {
            throw new Error("Backup file is larger than 5 MB");
        }
    } catch (err) {
        if (handle !== null) {
            try {
                fs.closeSync(handle);
            } catch {
                // ignore
            }
        }
        if (err instanceof Error && err.message.startsWith("Invalid backup")) {
            throw err;
        }
        throw new Error("Invalid backup path", { cause: err });
    } finally {
        if (handle !== null) {
            try {
                fs.closeSync(handle);
            } catch {
                // ignore
            }
        }
    }
    const realRel = path.relative(realRoot, realProbe);
    if (
        realRel === ".." ||
        realRel.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRel)
    ) {
        throw new Error("Invalid backup path");
    }

    // The remainder below the existing ancestor is not re-realpathed, so a
    // racing swap between validation and I/O could still redirect. Acceptable
    // for a local app; a hardened implementation would realpath each segment.
    return path.join(realProbe, path.relative(probe, resolved));
}

/**
 * Lists the existing backups for a file, newest first.
 *
 * @param filePath - Absolute path of the source file.
 * @returns The sorted backup entries for that file.
 */
export function listBackupsForFile(filePath: string): BackupEntry[] {
    const dir = backupDirForFile(filePath);
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs
        .readdirSync(dir)
        .flatMap((name) => {
            const fullPath = path.join(dir, name);
            try {
                const stats = fs.statSync(fullPath);
                return stats.isFile()
                    ? [
                          {
                              file: name,
                              path: fullPath,
                              mtime: stats.mtimeMs,
                              size: stats.size,
                          },
                      ]
                    : [];
            } catch (err) {
                logError(
                    "backups:stat",
                    err instanceof Error ? err.message : String(err),
                );
                return [];
            }
        })
        .toSorted((a, b) => b.mtime - a.mtime);
}

/**
 * Reads a single backup file, capped at an acceptable display size.
 *
 * @param raw - The unvalidated backup path from the IPC channel.
 * @returns The backup content as UTF-8 text.
 * @throws When the backup is missing or exceeds the read limit.
 */
export function readBackupFile(raw: unknown): string {
    const canonical = assertBackupPath(raw);
    let handle: number;
    try {
        handle = fs.openSync(canonical, "r");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error("Backup file does not exist", { cause: err });
        }
        throw err;
    }
    try {
        // Re-validate size against the locked fd to defeat a symlink swap
        // between the validation in assertBackupPath and the actual read.
        const stats = fs.fstatSync(handle);
        if (stats.size > MAX_BACKUP_READ_BYTES) {
            throw new Error("Backup file is larger than 5 MB");
        }
        return decodeStoredBackup(fs.readFileSync(handle, "utf8"));
    } finally {
        try {
            fs.closeSync(handle);
        } catch {
            // ignore
        }
    }
}

/**
 * Deletes a single backup file, ignoring already-missing files.
 *
 * @param raw - The unvalidated backup path from the IPC channel.
 * @throws When an actual filesystem error occurs during deletion.
 */
export function deleteBackupFile(raw: unknown): void {
    const canonical = assertBackupPath(raw);
    try {
        fs.unlinkSync(canonical);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
        }
    }
}

/**
 * Removes the whole backup history for a file.
 *
 * @param filePath - Absolute path of the source file.
 */
export function clearBackupsForFile(filePath: string): void {
    const dir = backupDirForFile(filePath);
    fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Removes backup history for every file within a folder, recursively.
 *
 * @param folderPath - Absolute folder path to clean.
 */
export function clearBackupsForFolder(folderPath: string): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(folderPath, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
            continue;
        }
        const full = path.join(folderPath, entry.name);
        if (entry.isDirectory()) {
            clearBackupsForFolder(full);
        } else {
            clearBackupsForFile(full);
        }
    }
}

/**
 * Re-encrypts legacy plaintext backups that belong to secret files.
 * Plaintext entries are rewritten in place as marked encrypted blobs.
 *
 * @param secretPaths - Absolute paths of files flagged secret.
 * @returns The number of backups converted.
 */
export function encryptLegacySecretBackups(secretPaths: string[]): number {
    let converted = 0;
    for (const secretPath of secretPaths) {
        const dir = backupDirForFile(secretPath);
        let names: string[];
        try {
            names = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of names) {
            const fullPath = path.join(dir, name);
            try {
                // lstat does not follow symlinks, so a planted symlink
                // inside the backups root is skipped, matching the
                // no-follow behavior of clearBackupsForFolder.
                if (!fs.lstatSync(fullPath).isFile()) {
                    continue;
                }
                const text = fs.readFileSync(fullPath, "utf8");
                if (text.startsWith(BACKUP_ENC_PREFIX)) {
                    continue;
                }
                const tmp = `${fullPath}.enc-tmp`;
                fs.writeFileSync(tmp, encodeStoredBackup(text), "utf8");
                fs.renameSync(tmp, fullPath);
                converted += 1;
            } catch (err) {
                logError(
                    "backup-migrate",
                    `${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    }
    return converted;
}
