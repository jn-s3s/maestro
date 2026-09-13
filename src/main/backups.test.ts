import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { Volume } from "memfs";
import { createFsFromVolume } from "memfs";

const originalEnv = { ...process.env };

// Create mock filesystem
const mockVol = new Volume();
const mockFs = createFsFromVolume(mockVol);

// Mock node:fs properly with default export
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal();
    return Object.assign({}, actual, {
        default: mockFs,
        ...mockFs,
        promises: mockFs.promises,
    });
});

vi.mock("node:os", async (importOriginal) => {
    const actual = await importOriginal();
    const osMock = Object.assign({}, actual, {
        homedir: () => "/mock/home",
    });
    // The default export must be mocked too, otherwise
    // `import os from "node:os"` resolves the real module.
    return Object.assign(osMock, { default: osMock });
});

vi.mock("electron", () => ({
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text: string) => Buffer.from(text),
        decryptString: (buffer: Buffer) => buffer.toString(),
    },
}));

// The real `./store` module is used (only `node:fs`, `node:os` and
// `electron` are mocked) so backup-dir hashing and the
// `maestro-enc:v1:` encode/decode path cannot drift from production.

function setupDirs() {
    mockVol.mkdirSync("/mock/home", { recursive: true });
    mockVol.mkdirSync("/mock/home/AppData/Roaming", { recursive: true });
    mockVol.mkdirSync("/mock/home/AppData/Roaming/maestro", {
        recursive: true,
    });
    mockVol.mkdirSync("/mock/home/AppData/Roaming/maestro/backups", {
        recursive: true,
    });
}

setupDirs();

beforeEach(() => {
    vi.resetModules();
    mockVol.reset();
    setupDirs();

    process.env = { ...originalEnv };
    process.env.APPDATA = "/mock/home/AppData/Roaming";
    process.env.LOCALAPPDATA = "/mock/home/AppData/Local";
    process.env.USERPROFILE = "/mock/home";
    process.env.HOME = "/mock/home";
});

afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
});

describe("backups module", () => {
    let mod: typeof import("./backups");
    let storeMod: typeof import("./store");

    beforeEach(async () => {
        mod = await import("./backups");
        storeMod = await import("./store");
    });

    it("listBackupsForFile returns empty array for non-existent file", () => {
        const entries = mod.listBackupsForFile("/mock/home/config.json");
        expect(entries).toEqual([]);
    });

    it("listBackupsForFile returns backup entries when they exist", () => {
        // Use the exact path that backupDirForFile would generate
        const filePath = "/mock/home/config.json";
        const backupDir = storeMod.backupDirForFile(filePath);
        mockVol.mkdirSync(backupDir, { recursive: true });
        mockFs.writeFileSync(
            path.join(backupDir, "2024-01-15_10-30-00-000_config.json"),
            "test content",
        );

        const entries = mod.listBackupsForFile(filePath);
        expect(entries.length).toBe(1);
        expect(entries[0].file).toBe("2024-01-15_10-30-00-000_config.json");
        expect(entries[0].size).toBeGreaterThan(0);
    });

    it("readBackupFile reads existing backup", () => {
        const filePath = "/mock/home/config.json";
        const backupDir = storeMod.backupDirForFile(filePath);
        mockVol.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(
            backupDir,
            "2024-01-15_10-30-00-000_config.json",
        );
        mockFs.writeFileSync(backupPath, "test backup content");

        const content = mod.readBackupFile(backupPath);
        expect(content).toBe("test backup content");
    });

    it("deleteBackupFile deletes existing backup", () => {
        const filePath = "/mock/home/config.json";
        const backupDir = storeMod.backupDirForFile(filePath);
        mockVol.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(
            backupDir,
            "2024-01-15_10-30-00-000_config.json",
        );
        mockFs.writeFileSync(backupPath, "test");

        expect(() => mod.deleteBackupFile(backupPath)).not.toThrow();
        expect(mockFs.existsSync(backupPath)).toBe(false);
    });

    it("deleteBackupFile ignores already-missing files", () => {
        const backupPath = path.join(
            storeMod.BACKUPS_ROOT,
            "config-abc123",
            "missing.txt",
        );
        expect(() => mod.deleteBackupFile(backupPath)).not.toThrow();
    });

    it("clearBackupsForFile removes backup directory", () => {
        const filePath = "/mock/home/config.json";
        const backupDir = storeMod.backupDirForFile(filePath);
        mockVol.mkdirSync(backupDir, { recursive: true });
        mockFs.writeFileSync(path.join(backupDir, "backup1.txt"), "test");

        mod.clearBackupsForFile(filePath);
        expect(mockFs.existsSync(backupDir)).toBe(false);
    });

    it("clearBackupsForFolder recursively clears backups", () => {
        const folder = "/mock/home/some/folder";
        mockVol.mkdirSync(folder, { recursive: true });
        // Build the file paths the same way clearBackupsForFolder does
        // (path.join), so the hashed backup dirs match. On Windows join
        // emits backslash separators, which changes the dir hash.
        const file1 = path.join(folder, "file1.json");
        const file2 = path.join(folder, "file2.json");
        mockFs.writeFileSync(file1, "{}");
        mockFs.writeFileSync(file2, "{}");

        const dir1 = storeMod.backupDirForFile(file1);
        const dir2 = storeMod.backupDirForFile(file2);
        mockVol.mkdirSync(dir1, { recursive: true });
        mockVol.mkdirSync(dir2, { recursive: true });
        mockFs.writeFileSync(path.join(dir1, "backup.txt"), "test");
        mockFs.writeFileSync(path.join(dir2, "backup.txt"), "test");

        expect(mockFs.existsSync(dir1)).toBe(true);
        expect(mockFs.existsSync(dir2)).toBe(true);

        mod.clearBackupsForFolder(folder);

        // Backup directories for files in the folder should be removed
        expect(mockFs.existsSync(dir1)).toBe(false);
        expect(mockFs.existsSync(dir2)).toBe(false);
    });

    it("encryptLegacySecretBackups converts plaintext backups", () => {
        const secretPath = "/mock/home/secret.txt";
        const backupDir = storeMod.backupDirForFile(secretPath);
        mockVol.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(backupDir, "backup.txt");
        mockFs.writeFileSync(backupPath, "plaintext secret");

        const converted = mod.encryptLegacySecretBackups([secretPath]);
        expect(converted).toBeGreaterThanOrEqual(1);

        // The file content should now be encrypted (starts with the prefix)
        const content = mockFs.readFileSync(backupPath, "utf8") as string;
        expect(content.startsWith(storeMod.BACKUP_ENC_PREFIX)).toBe(true);
    });

    it("assertBackupPath validates paths within backup root", () => {
        expect(() =>
            mod.assertBackupPath(
                path.join(storeMod.BACKUPS_ROOT, "file-abc", "backup.txt"),
            ),
        ).not.toThrow();
        expect(() =>
            mod.assertBackupPath(
                path.join(
                    storeMod.BACKUPS_ROOT,
                    "..",
                    "..",
                    "..",
                    "..",
                    "etc",
                    "passwd",
                ),
            ),
        ).toThrow("Invalid backup path");
        expect(() => mod.assertBackupPath("")).toThrow("Invalid backup path");
        expect(() => mod.assertBackupPath("../outside.txt")).toThrow(
            "Invalid backup path",
        );
    });
});
