import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
    Api,
    AppSettings,
    BackupEntry,
    OpResult,
    ReadResult,
    Tool,
    WriteResult,
    ToolGroup,
} from "../shared/types";

describe("IPC API contract - type verification", () => {
    // A compile-time check mock: if the Api interface changes, TypeScript
    // fails to compile this object that must satisfy every member.
    const api: Api = {
        listTools: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        reveal: vi.fn(),
        openFile: vi.fn(),
        openExternal: vi.fn(),
        getSettings: vi.fn(),
        setHidden: vi.fn(),
        setTheme: vi.fn(),
        setCloseToTray: vi.fn(),
        setSoftWrap: vi.fn(),
        addCustom: vi.fn(),
        removeCustom: vi.fn(),
        pushRecent: vi.fn(),
        listBackups: vi.fn(),
        readBackup: vi.fn(),
        deleteBackup: vi.fn(),
        clearBackups: vi.fn(),
        watchFile: vi.fn(),
        watchFolder: vi.fn(),
        fileStat: vi.fn(),
        listFolder: vi.fn(),
        createFileIn: vi.fn(),
        createFolderIn: vi.fn(),
        deleteFile: vi.fn(),
        deleteFolder: vi.fn(),
        renameFile: vi.fn(),
        renameFolder: vi.fn(),
        onFileChanged: vi.fn(),
        onThemeChanged: vi.fn(),
        onOpenFile: vi.fn(),
    };

    it("Api interface defines all required methods", () => {
        // If this compiles, the interface matches the real Api type
        expect(api).toBeDefined();
    });

    it("Api mock stays in sync with the Api interface", () => {
        // Exhaustive at compile time: adding a method to `Api` without
        // updating this map fails typecheck via `Record<keyof Api, true>`.
        const exhaustive: Record<keyof Api, true> = {
            listTools: true,
            readFile: true,
            writeFile: true,
            reveal: true,
            openFile: true,
            openExternal: true,
            getSettings: true,
            setHidden: true,
            setTheme: true,
            setCloseToTray: true,
            setSoftWrap: true,
            addCustom: true,
            removeCustom: true,
            pushRecent: true,
            listBackups: true,
            readBackup: true,
            deleteBackup: true,
            clearBackups: true,
            watchFile: true,
            watchFolder: true,
            fileStat: true,
            listFolder: true,
            createFileIn: true,
            createFolderIn: true,
            deleteFile: true,
            deleteFolder: true,
            renameFile: true,
            renameFolder: true,
            onFileChanged: true,
            onThemeChanged: true,
            onOpenFile: true,
        };

        expect(Object.keys(exhaustive).sort()).toEqual(Object.keys(api).sort());
        for (const name of Object.keys(api) as (keyof Api)[]) {
            expect(typeof api[name]).toBe("function");
        }
    });

    it("Api interface matches every method exposed in preload", () => {
        // Parse the method keys directly from the preload source so a new
        // channel added to `src/preload/index.ts` cannot silently diverge
        // from the shared Api interface tested here. Only lines inside the
        // `const api: Api = { ... };` literal are considered, and balanced
        // braces guard against helper functions with similar indentation.
        const here = path.dirname(fileURLToPath(import.meta.url));
        const source = fs.readFileSync(
            path.resolve(here, "..", "preload", "index.ts"),
            "utf8",
        );
        const start = source.indexOf("const api: Api");
        expect(start).toBeGreaterThanOrEqual(0);
        const literalStart = source.indexOf("{", start);
        let depth = 0;
        let literalEnd = -1;
        for (let i = literalStart; i < source.length; i += 1) {
            if (source[i] === "{") {
                depth += 1;
            } else if (source[i] === "}") {
                depth -= 1;
                if (depth === 0) {
                    literalEnd = i;
                    break;
                }
            }
        }
        expect(literalEnd).toBeGreaterThan(literalStart);
        const literal = source.slice(literalStart, literalEnd);
        const exposed = new Set(
            [...literal.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]),
        );
        const apiKeys = new Set(Object.keys(api));

        for (const name of exposed) {
            expect(
                apiKeys.has(name),
                `preload exposes "${name}" missing from the Api contract`,
            ).toBe(true);
        }
        for (const name of apiKeys) {
            expect(
                exposed.has(name),
                `Api contract lists "${name}" missing from preload`,
            ).toBe(true);
        }
    });

    it("WriteResult has correct discriminated union shape", () => {
        const success: WriteResult = {
            ok: true,
            created: true,
            backupPath: "/path",
        };
        const failure: WriteResult = { ok: false, error: "Failed" };

        expect(success.ok).toBe(true);
        expect(failure.ok).toBe(false);
    });

    it("OpResult has correct shape", () => {
        const success: OpResult = { ok: true };
        const failure: OpResult = { ok: false, error: "Failed" };

        expect(success.ok).toBe(true);
        expect(failure.ok).toBe(false);
        expect(failure.error).toBeDefined();
    });

    it("ReadResult has correct shape", () => {
        const result: ReadResult = {
            exists: true,
            content: "test",
            size: 4,
            mtime: Date.now(),
        };

        expect(result.exists).toBe(true);
        expect(result.content).toBe("test");
    });

    it("BackupEntry has correct shape", () => {
        const entry: BackupEntry = {
            file: "backup.txt",
            path: "/path/backup.txt",
            mtime: Date.now(),
            size: 100,
        };

        expect(entry.file).toBe("backup.txt");
    });

    it("Tool interface has correct structure", () => {
        const group: ToolGroup = "cli";
        const tool: Tool = {
            id: "test",
            name: "Test",
            group,
            files: [],
        };

        expect(tool.id).toBe("test");
    });

    it("AppSettings has correct structure", () => {
        const settings: AppSettings = {
            version: 1,
            theme: "dark",
            closeToTray: false,
            softWrap: true,
            historyResetDone: false,
            perFileHistoryResetDone: false,
            secretBackupsEncrypted: false,
            hiddenTools: [],
            recentFiles: [],
            custom: [],
        };

        expect(settings.theme).toBe("dark");
    });
});

describe("assertBackupPath - malformed input handling", () => {
    it("rejects non-string, empty and escaping inputs", async () => {
        const { assertBackupPath } = await import("./backups");

        expect(() => assertBackupPath(undefined)).toThrow(
            "Invalid backup path",
        );
        expect(() => assertBackupPath(42)).toThrow("Invalid backup path");
        expect(() => assertBackupPath("   ")).toThrow("Invalid backup path");
        expect(() => assertBackupPath("../outside.txt")).toThrow(
            "Invalid backup path",
        );
    });
});
