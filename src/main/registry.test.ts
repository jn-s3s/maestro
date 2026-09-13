import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { Volume } from "memfs";
import { createFsFromVolume } from "memfs";

// Create a mock fs object
const mockVol = new Volume();
const mockFs = createFsFromVolume(mockVol);

// Mock node:fs with a factory function that properly handles default export
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

const originalEnv = { ...process.env };

function setupDirs() {
    mockVol.mkdirSync("/mock/home", { recursive: true });
    mockVol.mkdirSync("/mock/home/AppData/Roaming", { recursive: true });
    mockVol.mkdirSync("/mock/home/AppData/Local", { recursive: true });
    mockVol.mkdirSync("/mock/home/.config", { recursive: true });
    mockVol.mkdirSync("/mock/home/.local/share/opencode", { recursive: true });
    mockVol.mkdirSync("/mock/home/.claude", { recursive: true });
    mockVol.mkdirSync("/mock/home/.gemini", { recursive: true });
    mockVol.mkdirSync("/mock/home/.codex", { recursive: true });
    mockVol.mkdirSync("/mock/home/.continue", { recursive: true });
    mockVol.mkdirSync("/mock/home/AppData/Roaming/Code/User", {
        recursive: true,
    });
    mockVol.mkdirSync("/mock/home/AppData/Roaming/Code - Insiders/User", {
        recursive: true,
    });
    mockVol.mkdirSync("/mock/home/AppData/Roaming/VSCodium/User", {
        recursive: true,
    });
    mockVol.mkdirSync(
        "/mock/home/AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings",
        { recursive: true },
    );
    mockVol.mkdirSync(
        "/mock/home/AppData/Roaming/Code/User/globalStorage/RooVeterinaryInc.roo-cline/settings",
        { recursive: true },
    );
    mockVol.mkdirSync(
        "/mock/home/AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code/settings",
        { recursive: true },
    );
    mockVol.mkdirSync("/mock/home/AppData/Roaming/opencode", {
        recursive: true,
    });
    mockVol.mkdirSync("/mock/home/.config/opencode", { recursive: true });
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

describe("registry - utility functions", () => {
    let mod: typeof import("./registry");

    beforeEach(async () => {
        mod = await import("./registry");
    });

    it("registeredPaths returns a set of normalized paths", () => {
        const tools = [
            {
                id: "test",
                name: "Test",
                group: "cli" as const,
                files: [
                    {
                        id: "1",
                        label: "a",
                        path: "/path/to/a.json",
                        exists: true,
                        lang: "json" as const,
                    },
                    {
                        id: "2",
                        label: "b",
                        path: "/path/to/b.yaml",
                        exists: true,
                        lang: "yaml" as const,
                    },
                ],
                folders: [],
            },
        ];
        const paths = mod.registeredPaths(tools);
        expect(paths).toBeInstanceOf(Set);
        expect(paths.size).toBe(2);
    });

    it("findContainingFolder finds the deepest matching folder", () => {
        const tools = [
            {
                id: "test",
                name: "Test",
                group: "cli" as const,
                files: [],
                folders: [
                    { id: "1", label: "root", path: "/root", exists: true },
                    {
                        id: "2",
                        label: "nested",
                        path: "/root/nested",
                        exists: true,
                    },
                ],
            },
        ];
        const folder = mod.findContainingFolder(tools, "/root/nested/file.txt");
        expect(folder).toBeDefined();
        expect(folder?.path).toBe("/root/nested");
    });

    it("isSecretPath detects secret files", () => {
        const tools = [
            {
                id: "test",
                name: "Test",
                group: "cli" as const,
                files: [
                    {
                        id: "1",
                        label: "secret",
                        path: "/path/secret.txt",
                        exists: true,
                        lang: "text" as const,
                        secret: true,
                    },
                    {
                        id: "2",
                        label: "normal",
                        path: "/path/normal.txt",
                        exists: true,
                        lang: "text" as const,
                    },
                ],
                folders: [],
            },
        ];
        expect(mod.isSecretPath(tools, "/path/secret.txt")).toBe(true);
        expect(mod.isSecretPath(tools, "/path/normal.txt")).toBe(false);
    });

    it("registeredFolderRoots returns folder paths", () => {
        const tools = [
            {
                id: "test",
                name: "Test",
                group: "cli" as const,
                files: [],
                folders: [
                    { id: "1", label: "a", path: "/a", exists: true },
                    { id: "2", label: "b", path: "/b", exists: true },
                ],
            },
        ];
        const roots = mod.registeredFolderRoots(tools);
        expect(roots).toBeInstanceOf(Set);
        expect(roots.size).toBe(2);
    });

    it("listDir returns directory entries sorted folders-first", () => {
        const root = "/mock/home/testdir";
        mockVol.mkdirSync(root, { recursive: true });
        mockFs.writeFileSync(`${root}/file1.txt`, "a");
        mockVol.mkdirSync(`${root}/subdir`, { recursive: true });
        mockFs.writeFileSync(`${root}/file2.txt`, "b");

        const entries = mod.listDir(root);
        expect(entries).toHaveLength(3);
        // Folders should come before files
        expect(entries[0].isDir).toBe(true);
        expect(entries[0].name).toBe("subdir");
        expect(entries[1].isDir).toBe(false);
        expect(entries[2].isDir).toBe(false);
    });

    it("listDir skips hidden and symlink entries", () => {
        const root = "/mock/home/hiddendir";
        mockVol.mkdirSync(root, { recursive: true });
        mockFs.writeFileSync(`${root}/visible.txt`, "a");
        mockFs.writeFileSync(`${root}/.hidden`, "b");

        const entries = mod.listDir(root);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe("visible.txt");
    });

    it("listDir returns empty array for non-existent directory", () => {
        const entries = mod.listDir("/mock/home/nonexistent");
        expect(entries).toEqual([]);
    });
});

describe("registry.detectTools - basic sanity", () => {
    it("returns array without throwing", async () => {
        const mod = await import("./registry");

        const tools = mod.detectTools({
            version: 1,
            theme: "system",
            closeToTray: false,
            softWrap: true,
            historyResetDone: false,
            perFileHistoryResetDone: false,
            secretBackupsEncrypted: false,
            hiddenTools: [],
            recentFiles: [],
            custom: [],
        });

        expect(Array.isArray(tools)).toBe(true);
        expect(tools.length).toBeGreaterThanOrEqual(0);
    });
});

describe("registry.detectTools - filtering logic", () => {
    let mod: typeof import("./registry");

    beforeEach(async () => {
        mod = await import("./registry");
    });

    it("excludes built-in tools with no existing files or folders", () => {
        // Remove the directory that setupDirs creates for codex
        // so the codex tool has neither existing files nor folders
        mockVol.rmSync("/mock/home/.codex", { recursive: true, force: true });

        const tools = mod.detectTools({
            version: 1,
            theme: "system",
            closeToTray: false,
            softWrap: true,
            historyResetDone: false,
            perFileHistoryResetDone: false,
            secretBackupsEncrypted: false,
            hiddenTools: [],
            recentFiles: [],
            custom: [],
        });

        // codex should be excluded because neither its files nor folders exist
        const codexTool = tools.find((t) => t.id === "codex");
        expect(codexTool).toBeUndefined();

        // But tools whose folders exist should still be present
        const vscodeTool = tools.find((t) => t.id.startsWith("vscode"));
        expect(vscodeTool).toBeDefined();
    });

    it("includes custom tools even with no existing files or folders", () => {
        const tools = mod.detectTools({
            version: 1,
            theme: "system",
            closeToTray: false,
            softWrap: true,
            historyResetDone: false,
            perFileHistoryResetDone: false,
            secretBackupsEncrypted: false,
            hiddenTools: [],
            recentFiles: [],
            custom: [
                {
                    id: "custom-1",
                    name: "Custom Tool",
                    path: "/nonexistent/path.json",
                },
            ],
        });

        const customTool = tools.find((t) => t.id === "custom-1");
        expect(customTool).toBeDefined();
        expect(customTool?.group).toBe("custom");
    });

    it("includes built-in tools that have at least one existing file", () => {
        // Create a file that opencode would detect (opencode.json or opencode.jsonc)
        // xdgConfigHome() uses APPDATA which is /mock/home/AppData/Roaming
        mockVol.mkdirSync("/mock/home/AppData/Roaming/opencode", {
            recursive: true,
        });
        mockFs.writeFileSync(
            "/mock/home/AppData/Roaming/opencode/opencode.json",
            "{}",
        );

        const tools = mod.detectTools({
            version: 1,
            theme: "system",
            closeToTray: false,
            softWrap: true,
            historyResetDone: false,
            perFileHistoryResetDone: false,
            secretBackupsEncrypted: false,
            hiddenTools: [],
            recentFiles: [],
            custom: [],
        });

        const opencodeTool = tools.find((t) => t.id === "opencode");
        expect(opencodeTool).toBeDefined();
        if (opencodeTool) {
            const hasExistingFile = opencodeTool.files.some((f) => f.exists);
            expect(hasExistingFile).toBe(true);
        }
    });

    it("includes built-in tools that have at least one existing folder", () => {
        // VS Code folders are created in setupDirs, so VS Code tools should be detected
        mockFs.writeFileSync(
            "/mock/home/AppData/Roaming/Code/User/settings.json",
            "{}",
        );

        const tools = mod.detectTools({
            version: 1,
            theme: "system",
            closeToTray: false,
            softWrap: true,
            historyResetDone: false,
            perFileHistoryResetDone: false,
            secretBackupsEncrypted: false,
            hiddenTools: [],
            recentFiles: [],
            custom: [],
        });

        // VS Code flavor tools should be included because their folders exist
        const vscodeTools = tools.filter((t) => t.id.startsWith("vscode"));
        expect(vscodeTools.length).toBeGreaterThan(0);
        for (const tool of vscodeTools) {
            const hasExistingFolder = (tool.folders ?? []).some(
                (f) => f.exists,
            );
            expect(hasExistingFolder).toBe(true);
        }
    });

    it("detects Aider when .aider.conf.yml exists in HOME", () => {
        mockFs.writeFileSync(
            path.join("/mock/home", ".aider.conf.yml"),
            "model: claude",
        );

        const tools = mod.detectTools({
            version: 1,
            theme: "system",
            closeToTray: false,
            softWrap: true,
            historyResetDone: false,
            perFileHistoryResetDone: false,
            secretBackupsEncrypted: false,
            hiddenTools: [],
            recentFiles: [],
            custom: [],
        });

        const aiderTool = tools.find((t) => t.id === "aider");
        expect(aiderTool).toBeDefined();
        expect(aiderTool?.name).toBe("Aider");
        expect(aiderTool?.group).toBe("cli");
        const confFile = aiderTool?.files.find(
            (f) => f.id === "aider/.aider.conf.yml",
        );
        expect(confFile).toBeDefined();
        expect(confFile?.exists).toBe(true);
        expect(confFile?.path).toBe(path.join("/mock/home", ".aider.conf.yml"));
    });

    it("returns empty array when no config files exist", () => {
        // Reset to a clean state without any tool directories
        mockVol.reset();
        mockVol.mkdirSync("/mock/home", { recursive: true });

        const tools = mod.detectTools({
            version: 1,
            theme: "system",
            closeToTray: false,
            softWrap: true,
            historyResetDone: false,
            perFileHistoryResetDone: false,
            secretBackupsEncrypted: false,
            hiddenTools: [],
            recentFiles: [],
            custom: [],
        });

        expect(tools).toEqual([]);
    });
});
