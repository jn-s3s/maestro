#!/usr/bin/env node
// Dumps the Maestro main-process log files and the backup tree to stdout.
//
// Usage:
//   node scripts/dump-logs.mjs
//
// Logs and backups live under %APPDATA%\maestro (logs\main.log, logs\main.log.old
// and the backups\ folder). The script reads them in their default location and
// prints the log lines together with each backup file's name, size and mtime.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_DIR = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const MAESTRO_ROOT = path.join(BASE_DIR, "maestro");
const LOGS_DIR = path.join(MAESTRO_ROOT, "logs");
const BACKUPS_DIR = path.join(MAESTRO_ROOT, "backups");

/** Prints a short section heading line. */
function heading(text) {
    console.log(`\n=== ${text} ===`);
}

/** Lists the contents of a directory, or reports when it cannot be read. */
function listDir(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        console.log(`  (unavailable: ${err instanceof Error ? err.message : err})`);
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        let st;
        try {
            st = fs.statSync(full);
        } catch (err) {
            console.log(`  ${entry.name}  (cannot stat: ${err instanceof Error ? err.message : err})`);
            continue;
        }
        if (entry.isDirectory()) {
            console.log(`  [dir] ${entry.name}/`);
            listDir(full);
        } else if (entry.isFile()) {
            const mtime = new Date(st.mtimeMs).toISOString();
            console.log(`  ${entry.name}  (${st.size} B, ${mtime})`);
        }
    }
}

/** Prints the rotation-aware log stream, newest part first. */
function dumpLog(name) {
    const file = path.join(LOGS_DIR, name);
    if (!fs.existsSync(file)) {
        console.log(`  (no ${name} yet)`);
        return;
    }
    console.log(`  (${file})`);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) console.log(`  ${line}`);
}

heading(`Maestro root (${MAESTRO_ROOT})`);
console.log(`  settings: ${path.join(MAESTRO_ROOT, "settings.json")}`);

heading("Log (main.log.old, rotated history)");
dumpLog("main.log.old");

heading("Log (main.log, current)");
dumpLog("main.log");

heading("Backups");
listDir(BACKUPS_DIR);