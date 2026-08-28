import fs from "node:fs";
import path from "node:path";
import { BACKUPS_ROOT, backupDirForFile, logError } from "./store";
import type { BackupEntry } from "../shared/types";

const MAX_BACKUP_READ_BYTES = 5 * 1024 * 1024;

/**
 * Validates and canonicalizes a renderer-supplied backup path.
 *
 * @param raw - The unvalidated value received over the IPC channel.
 * @returns The canonical path rooted inside the backup directory.
 * @throws When the path is invalid or escapes the backup root.
 */
export function assertBackupPath(raw: unknown): string {
    if (typeof raw !== "string" || raw.trim().length === 0)
        throw new Error("Invalid backup path");
    const trimmed = raw.trim();
    const resolved = path.resolve(trimmed);
    const rel = path.relative(BACKUPS_ROOT, resolved);
    if (
        rel === "" ||
        rel === ".." ||
        rel.startsWith(`..${path.sep}`) ||
        path.isAbsolute(rel)
    )
        throw new Error("Invalid backup path");

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
        if (parent === probe) throw new Error("Invalid backup path");
        probe = parent;
        walked = true;
    }
    let realProbe: string;
    try {
        realProbe = fs.realpathSync(probe);
        const st = fs.statSync(probe);
        if (walked ? !st.isDirectory() : !st.isFile())
            throw new Error("Invalid backup path");
    } catch {
        throw new Error("Invalid backup path");
    }
    const realRel = path.relative(realRoot, realProbe);
    if (
        realRel === ".." ||
        realRel.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRel)
    )
        throw new Error("Invalid backup path");

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
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .flatMap((name) => {
            const fp = path.join(dir, name);
            try {
                const st = fs.statSync(fp);
                return st.isFile()
                    ? [
                          {
                              file: name,
                              path: fp,
                              mtime: st.mtimeMs,
                              size: st.size,
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
        .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Reads a single backup file, capped at an acceptable display size.
 *
 * @param raw - The unvalidated backup path from the IPC channel.
 * @returns The backup content as UTF-8 text.
 * @throws When the backup is missing or exceeds the read limit.
 */
export function readBackupFile(raw: unknown): string {
    const p = assertBackupPath(raw);
    try {
        if (fs.statSync(p).size > MAX_BACKUP_READ_BYTES)
            throw new Error("Backup file is larger than 5 MB");
        return fs.readFileSync(p, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT")
            throw new Error("Backup file does not exist", { cause: err });
        throw err;
    }
}

/**
 * Deletes a single backup file, ignoring already-missing files.
 *
 * @param raw - The unvalidated backup path from the IPC channel.
 * @throws When an actual filesystem error occurs during deletion.
 */
export function deleteBackupFile(raw: unknown): void {
    const p = assertBackupPath(raw);
    try {
        fs.unlinkSync(p);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
    for (const e of entries) {
        if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
        const full = path.join(folderPath, e.name);
        if (e.isDirectory()) {
            clearBackupsForFolder(full);
        } else {
            clearBackupsForFile(full);
        }
    }
}
