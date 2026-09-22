import type { FileLang } from "../../../shared/types";
import { langFromPath } from "../../../shared/types";

/**
 * Formats a byte count into a compact human-readable string.
 *
 * @param bytes - The byte count to format.
 * @returns The formatted size label.
 */
export function fmtBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 B";
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Formats a timestamp as a localized medium date and short time.
 *
 * @param ms - The epoch milliseconds to format.
 * @returns The formatted date, or empty when the value is unset.
 */
export function fmtTime(ms: number): string {
    if (!ms) {
        return "";
    }
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
    javascript: "JavaScript",
    typescript: "TypeScript",
    python: "Python",
    shell: "Shell",
    text: "Plain text",
};

export { langFromPath };
