import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Volume } from "memfs";
import { createFsFromVolume } from "memfs";

const originalEnv = { ...process.env };

// Create mock filesystem
const mockVol = new Volume();
const mockFs = createFsFromVolume(mockVol);

// Mock node:fs with factory function that properly handles default export
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

describe("store module - utility functions", () => {
    let mod: typeof import("./store");

    beforeEach(async () => {
        mod = await import("./store");
    });

    it("pushRecent adds file to front and removes duplicates", () => {
        const list = ["/a", "/b", "/c"];
        const result = mod.pushRecent(list, "/b");
        expect(result).toEqual(["/b", "/a", "/c"]);
    });

    it("pushRecent caps at 5 entries", () => {
        const list = ["/a", "/b", "/c", "/d", "/e"];
        const result = mod.pushRecent(list, "/f");
        expect(result).toEqual(["/f", "/a", "/b", "/c", "/d"]);
        expect(result.length).toBe(5);
    });

    it("encodeStoredBackup encrypts text with prefix", () => {
        const result = mod.encodeStoredBackup("test content");
        expect(result).toMatch(/^maestro-enc:v1:/);
        expect(result.length).toBeGreaterThan("maestro-enc:v1:".length);
    });

    it("decodeStoredBackup decrypts encrypted text", () => {
        const encrypted = mod.encodeStoredBackup("secret");
        const decrypted = mod.decodeStoredBackup(encrypted);
        expect(decrypted).toBe("secret");
    });

    it("decodeStoredBackup passes through plaintext", () => {
        const result = mod.decodeStoredBackup("plaintext");
        expect(result).toBe("plaintext");
    });

    it("backupDirForFile returns consistent hash-based path", () => {
        const dir1 = mod.backupDirForFile("/home/user/config.json");
        const dir2 = mod.backupDirForFile("/home/user/config.json");
        expect(dir1).toBe(dir2);
        // Check that it ends with the filename-hash pattern (path-agnostic)
        expect(dir1).toMatch(/config\.json-[a-f0-9]{12}$/);
    });

    it("backupDirForFile differs for different files", () => {
        const dir1 = mod.backupDirForFile("/home/user/config.json");
        const dir2 = mod.backupDirForFile("/home/user/other.json");
        expect(dir1).not.toBe(dir2);
    });

    it("logError is callable", () => {
        expect(typeof mod.logError).toBe("function");
        expect(() => mod.logError("test", "message")).not.toThrow();
    });
});

describe("store module - settings persistence", () => {
    let mod: typeof import("./store");

    beforeEach(async () => {
        mod = await import("./store");
    });

    it("loadSettings and saveSettings are callable", () => {
        expect(typeof mod.loadSettings).toBe("function");
        expect(typeof mod.saveSettings).toBe("function");

        const defaults = mod.loadSettings();
        expect(defaults.theme).toBe("system");
        expect(defaults.version).toBe(1);
    });

    it("saveSettings and loadSettings round-trip theme value", () => {
        const defaults = mod.loadSettings();
        defaults.theme = "dark";
        mod.saveSettings(defaults);

        const loaded = mod.loadSettings();
        expect(loaded.theme).toBe("dark");
    });

    it("saveSettings writes valid JSON to disk", () => {
        const settings = mod.loadSettings();
        settings.theme = "light";
        settings.closeToTray = true;
        mod.saveSettings(settings);

        // Verify the file was actually written
        const stored = mockFs.readFileSync(
            "/mock/home/AppData/Roaming/maestro/settings.json",
            "utf8",
        ) as string;
        const parsed = JSON.parse(stored);
        expect(parsed.theme).toBe("light");
        expect(parsed.closeToTray).toBe(true);
    });

    it("loadSettings returns defaults when file is missing", () => {
        // Ensure no settings file exists
        expect(
            mockFs.existsSync(
                "/mock/home/AppData/Roaming/maestro/settings.json",
            ),
        ).toBe(false);

        const settings = mod.loadSettings();
        expect(settings.theme).toBe("system");
        expect(settings.version).toBe(1);
        expect(settings.softWrap).toBe(true);
    });

    it("loadSettings handles malformed JSON gracefully", () => {
        const settingsPath = "/mock/home/AppData/Roaming/maestro/settings.json";
        mockFs.writeFileSync(settingsPath, "{ invalid json }");

        const settings = mod.loadSettings();
        expect(settings.theme).toBe("system");
        expect(settings.version).toBe(1);
    });

    it("pushRecent normalizes paths case-insensitively", () => {
        // The real pushRecent uses path.normalize and toLowerCase
        // Test that duplicates are caught regardless of case
        const result = mod.pushRecent(
            ["/Path/To/File.txt"],
            "/path/to/file.txt",
        );
        expect(result).toHaveLength(1);
        expect(result[0]).toBe("/path/to/file.txt");
    });
});
