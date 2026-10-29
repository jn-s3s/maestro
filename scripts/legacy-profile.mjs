import fs from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import {
    BACKUPS_ROOT,
    DATA_ROOT,
    backupDirForFile,
    decodeStoredBackup,
    encodeStoredBackup,
} from "../src/main/store.ts";

const [mode, fixturePath, configJson] = process.argv.slice(2);

app.setPath("userData", DATA_ROOT);

/**
 * Writes UTF-8 text, creating parent folders.
 *
 * @param {string} file - Absolute target path.
 * @param {string} text - Content to write.
 */
function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
}

void app
    .whenReady()
    .then(() => {
        if (mode === "verify") {
            const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
            const stored = fs.readFileSync(fixture.encryptedPath, "utf8");
            const decoded = decodeStoredBackup(stored);
            if (decoded !== fixture.encryptedContent) {
                throw new Error(
                    "Electron can no longer decode the synthetic legacy snapshot",
                );
            }
            console.log(
                JSON.stringify({
                    success: true,
                    decodedLength: decoded.length,
                }),
            );
            app.quit();
            return;
        }
        if (mode !== "seed") {
            throw new Error(`Unknown fixture mode: ${mode}`);
        }
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error("Windows safeStorage encryption is unavailable");
        }
        const config = JSON.parse(configJson);
        const backups = backupDirForFile(config.settingsPath);
        const plainName = "2026-10-20_10-00-00-000_settings.json";
        const encryptedName = "2026-10-21_10-00-00-000_settings.json";
        const plainContent = '{"legacy":"plain","note":"café"}\n';
        const encryptedContent = '{"legacy":"encrypted","key":"synthetic"}\n';
        const plainPath = path.join(backups, plainName);
        const encryptedPath = path.join(backups, encryptedName);
        write(plainPath, plainContent);
        write(encryptedPath, encodeStoredBackup(encryptedContent));
        write(
            path.join(
                BACKUPS_ROOT,
                "orphan.json-0123456789ab",
                "2026-10-19_10-00-00-000_orphan.json",
            ),
            "orphan history\n",
        );
        write(
            path.join(DATA_ROOT, "settings.json"),
            JSON.stringify(
                {
                    version: 1,
                    theme: "dark",
                    closeToTray: true,
                    softWrap: false,
                    historyResetDone: true,
                    perFileHistoryResetDone: true,
                    secretBackupsEncrypted: true,
                    hiddenTools: ["aider"],
                    recentFiles: [config.settingsPath],
                    custom: [
                        {
                            id: "custom-legacy-1",
                            name: "Legacy Custom",
                            path: config.customPath,
                        },
                    ],
                },
                null,
                2,
            ),
        );
        write(
            fixturePath,
            JSON.stringify({
                dataRoot: DATA_ROOT,
                backupsRoot: BACKUPS_ROOT,
                plainPath,
                plainContent,
                encryptedPath,
                encryptedContent,
            }),
        );
        app.quit();
    })
    .catch((error) => {
        console.error("Generate synthetic Maestro 1 profile:", error);
        app.exit(1);
    });
