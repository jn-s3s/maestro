import fs from "node:fs";
import { app, safeStorage } from "electron";
import { encodeStoredBackup, decodeStoredBackup } from "../src/main/store.ts";

app.setPath("userData", process.env.MAESTRO_PROBE_USER_DATA);

void app
    .whenReady()
    .then(() => {
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error("Windows safeStorage encryption is unavailable");
        }
        const samples = [
            ["empty", ""],
            ["json", '{"synthetic":true}'],
            ["unicode", "café / 日本語 / \u{1D11E}"],
            ["line-endings", "first\r\nsecond\nthird\r\n"],
            ["nul", "left\0right"],
        ].map(([label, expected]) => {
            const stored = encodeStoredBackup(expected);
            if (decodeStoredBackup(stored) !== expected) {
                throw new Error(`Electron roundtrip failed for ${label}`);
            }
            return { label, stored, expected };
        });
        const tampered = Buffer.from(
            samples[1].stored.slice("maestro-enc:v1:".length),
            "base64",
        );
        tampered[tampered.length - 1] ^= 1;
        samples.push(
            {
                label: "tampered-tag",
                stored: `maestro-enc:v1:${tampered.toString("base64")}`,
                expected: null,
            },
            {
                label: "plaintext",
                stored: "synthetic legacy text",
                expected: "synthetic legacy text",
            },
            {
                label: "invalid-base64",
                stored: "maestro-enc:v1:!",
                expected: null,
            },
            {
                label: "invalid-prefix",
                stored: "maestro-enc:v1:eHl6",
                expected: null,
            },
            {
                label: "truncated-ciphertext",
                stored: "maestro-enc:v1:djEw",
                expected: null,
            },
        );
        fs.writeFileSync(
            process.argv[2],
            JSON.stringify({
                electronVersion: process.versions.electron,
                samples,
            }),
            { encoding: "utf8", flag: "wx" },
        );
        app.quit();
    })
    .catch((error) => {
        console.error("Generate synthetic backup fixtures:", error);
        app.exit(1);
    });
