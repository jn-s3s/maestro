// The renderer runs in a browser context, where `import prettier from "prettier"`
// resolves to `prettier/standalone` (per the package's `browser` export). The
// standalone bundle intentionally ships without parsers, so each parser must be
// imported as an explicit plugin and supplied via the `plugins` option.
import * as prettier from "prettier/standalone";
import * as babelPlugin from "prettier/plugins/babel";
import * as estreePlugin from "prettier/plugins/estree";
import * as typescriptPlugin from "prettier/plugins/typescript";
import * as yamlPlugin from "prettier/plugins/yaml";
import * as markdownPlugin from "prettier/plugins/markdown";
import type { FileLang } from "../../../shared/types";
import { LANG_LABELS } from "./format";

export type FormatResult =
    { ok: true; content: string } | { ok: false; error: string };

// The babel plugin registers the json, jsonc and babel parsers; the estree
// plugin supplies the shared AST printer, and the typescript plugin the TS
// parser. All are needed by the switch below.
const BABEL_PLUGINS = [babelPlugin, estreePlugin, typescriptPlugin];
const YAML_PLUGINS = [yamlPlugin];
const MARKDOWN_PLUGINS = [markdownPlugin];

/**
 * Formats document content for the given language with prettier, or with
 * @iarna/toml for TOML. JSONC formatting uses Prettier's native "jsonc"
 * parser which preserves comments and trailing commas. Never throws;
 * failures are returned as `{ ok: false, error }`.
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
                        plugins: BABEL_PLUGINS,
                        tabWidth: 2,
                    }),
                };
            case "jsonc": {
                // JSONC is supported natively by Prettier via the "jsonc" parser,
                // which preserves comments and trailing commas.
                return {
                    ok: true,
                    content: await prettier.format(content, {
                        parser: "jsonc",
                        plugins: BABEL_PLUGINS,
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
            case "javascript":
                return {
                    ok: true,
                    content: await prettier.format(content, {
                        parser: "babel",
                        plugins: BABEL_PLUGINS,
                        tabWidth: 4,
                    }),
                };
            case "typescript":
                return {
                    ok: true,
                    content: await prettier.format(content, {
                        parser: "typescript",
                        plugins: BABEL_PLUGINS,
                        tabWidth: 4,
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
