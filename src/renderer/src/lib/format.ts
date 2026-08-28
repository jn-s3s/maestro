import type { FileLang } from "../../../shared/types";
import { langFromPath } from "../../../shared/types";

/**
 * Formats a byte count into a compact human-readable string.
 *
 * @param n - The byte count to format.
 * @returns The formatted size label.
 */
export function fmtBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Formats a timestamp as a localized medium date and short time.
 *
 * @param ms - The epoch milliseconds to format.
 * @returns The formatted date, or empty when the value is unset.
 */
export function fmtTime(ms: number): string {
    if (!ms) return "";
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(ms));
}

export const LANG_LABELS: Record<FileLang, string> = {
    json: "JSON",
    jsonc: "JSONC",
    yaml: "YAML",
    toml: "TOML",
    markdown: "Markdown",
    dotenv: "Dotenv",
    text: "Plain text",
};

export { langFromPath };
