// The renderer runs in a browser context, where `import prettier from "prettier"`
// resolves to `prettier/standalone` (per the package's `browser` export). The
// standalone bundle intentionally ships without parsers, so each parser must be
// imported as an explicit plugin and supplied via the `plugins` option.
import * as prettier from "prettier/standalone";
import * as babelPlugin from "prettier/plugins/babel";
import * as estreePlugin from "prettier/plugins/estree";
import * as yamlPlugin from "prettier/plugins/yaml";
import * as markdownPlugin from "prettier/plugins/markdown";
import type { FileLang } from "../../../shared/types";
import { prepareJsoncForFormat } from "../../../shared/jsonc";
import { LANG_LABELS } from "./format";

export type FormatResult =
    { ok: true; content: string } | { ok: false; error: string };

const JSON_PLUGINS = [babelPlugin, estreePlugin];
const YAML_PLUGINS = [yamlPlugin];
const MARKDOWN_PLUGINS = [markdownPlugin];

/**
 * Formats document content for the given language with prettier, or with
 * @iarna/toml for TOML. JSONC formatting is supported only for files
 * without comments; files with comments are rejected to prevent silent
 * data loss, because the JSONC path strips comments and trailing commas
 * before formatting. Never throws; failures are returned as
 * `{ ok: false, error }`.
 *
 * @param content - The raw editor content to format.
 * @param lang - The file language to format as.
 * @returns The formatted content, or a specific error message.
 */
export async function formatDocument(
    content: string,
    lang: FileLang,
): Promise<FormatResult> {
    try {
        switch (lang) {
            case "json":
                return {
                    ok: true,
                    content: await prettier.format(content, {
                        parser: "json",
                        plugins: JSON_PLUGINS,
                        tabWidth: 2,
                    }),
                };
            case "jsonc": {
                // JSONC has no prettier parser, so comments and trailing
                // commas are stripped first and the cleaned source is
                // formatted as plain JSON. This discards comments by design,
                // so reject files that actually contain comments rather than
                // silently destroying them.
                const hasLineComment = /(^|[^:])\/\//m.test(content);
                const hasBlockComment = /\/\*/.test(content);
                if (hasLineComment || hasBlockComment) {
                    return {
                        ok: false,
                        error: "JSONC formatting would remove comments. Remove them manually or convert to plain JSON before formatting.",
                    };
                }
                const clean = prepareJsoncForFormat(content);
                return {
                    ok: true,
                    content: await prettier.format(clean, {
                        parser: "json",
                        plugins: JSON_PLUGINS,
                        tabWidth: 2,
                    }),
                };
            }
            case "yaml":
                return {
                    ok: true,
                    content: await prettier.format(content, {
                        parser: "yaml",
                        plugins: YAML_PLUGINS,
                        tabWidth: 2,
                    }),
                };
            case "markdown":
                return {
                    ok: true,
                    content: await prettier.format(content, {
                        parser: "markdown",
                        plugins: MARKDOWN_PLUGINS,
                        proseWrap: "preserve",
                    }),
                };
            case "toml": {
                const toml = await import("@iarna/toml");
                const parsed = toml.parse(content);
                return { ok: true, content: toml.stringify(parsed) };
            }
            default:
                return {
                    ok: false,
                    error: "Formatting not supported for this file type",
                };
        }
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            error: `Cannot format ${LANG_LABELS[lang]}: ${detail}`,
        };
    }
}
