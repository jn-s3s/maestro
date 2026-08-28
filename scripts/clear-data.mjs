#!/usr/bin/env node
// Clears Maestro's stored backups and log files for a fresh development start.
//
// Usage:
//   node scripts/clear-data.mjs          # prints what it would remove, keeps files
//   node scripts/clear-data.mjs --yes    # actually deletes backups and logs
//
// Backups and logs live under %APPDATA%\maestro (the backups\ and logs\
// folders). This script removes both so repeat testing starts from a clean
// slate. It never touches settings.json. Requires an explicit --yes flag so
// it can never run by accident.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keep in sync with the same expression in src/main/store.ts.
const BASE_DIR = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const MAESTRO_ROOT = path.join(BASE_DIR, "maestro");
const TARGETS = [
    path.join(MAESTRO_ROOT, "backups"),
    path.join(MAESTRO_ROOT, "logs"),
];

/** Returns a short size summary for a directory tree. */
function summarize(dir) {
    if (!fs.existsSync(dir)) return null;
    let bytes = 0;
    let files = 0;
    // Best-effort walk that never throws on unreadable entries.
    const walk = (d) => {
        let entries;
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                try {
                    const st = fs.statSync(full);
                    bytes += st.size;
                    files += 1;
                } catch {
                    // Skip entries that cannot be stat'd.
                }
            }
        }
    };
    walk(dir);
    return { bytes, files };
}

const wantsDelete = process.argv.includes("--yes");

console.log(`Maestro data root: ${MAESTRO_ROOT}`);
if (!fs.existsSync(MAESTRO_ROOT)) {
    console.log("  (nothing to clean - the folder does not exist yet)");
    process.exit(0);
}

for (const target of TARGETS) {
    const info = summarize(target);
    if (!info) {
        console.log(`- ${target} ... nothing to clean`);
        continue;
    }
    console.log(
        `- ${target}: ${info.files} file(s), ${info.bytes} bytes total`,
    );
    if (wantsDelete) {
        fs.rmSync(target, { recursive: true, force: true });
        console.log("    deleted");
    } else {
        console.log("    kept (pass --yes to delete)");
    }
}

if (!process.argv.includes("--yes")) {
    console.log("\nDry run. Re-run with --yes to actually delete the data above.");
}