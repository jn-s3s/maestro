import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
    AppSettings,
    DirEntry,
    Tool,
    ToolFile,
    ToolFolder,
} from "../shared/types";
import { langFromPath } from "../shared/types";

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");

function makeFile(
    id: string,
    label: string,
    filePath: string,
    extra?: Partial<ToolFile>,
): ToolFile {
    return {
        id,
        label,
        path: filePath,
        exists: fs.existsSync(filePath),
        lang: langFromPath(filePath),
        ...extra,
    };
}

function makeFolder(id: string, label: string, folderPath: string): ToolFolder {
    return { id, label, path: folderPath, exists: fs.existsSync(folderPath) };
}

/**
 * Resolves symlinks so containment checks compare real paths, not lexical ones.
 * Falls back to the normalized input when realpath is unavailable.
 */
function canonicalPath(p: string): string {
    try {
        return fs.realpathSync(p);
    } catch {
        return path.normalize(p);
    }
}

const RELOAD_NOTE =
    "Reload the editor window after saving for changes to take effect.";

/**
 * Builds the registry of known AI tool configs and extension folders.
 *
 * Synthesises a "Root folder" entry from each tool's `rootPath` and prepends
 * it to the tool's `folders` array. Tools without `rootPath` are left unchanged.
 *
 * @param settings - Settings that carry the custom entries to include.
 * @returns The complete list of detected tools.
 */
export function detectTools(settings: AppSettings): Tool[] {
    const tools: Tool[] = [];

    const opencodeDir = path.join(HOME, ".config", "opencode");
    tools.push({
        id: "opencode",
        name: "OpenCode",
        group: "cli",
        subtitle: "~\\.config\\opencode",
        rootPath: opencodeDir,
        files: [
            makeFile(
                "opencode/opencode.json",
                "opencode.json",
                path.join(opencodeDir, "opencode.json"),
            ),
            makeFile(
                "opencode/opencode.jsonc",
                "opencode.jsonc",
                path.join(opencodeDir, "opencode.jsonc"),
                {
                    note: "OpenCode prefers opencode.jsonc over opencode.json when both exist.",
                },
            ),
        ],
        folders: [
            makeFolder(
                "opencode/folder-command",
                "Commands",
                path.join(opencodeDir, "command"),
            ),
            makeFolder(
                "opencode/folder-agents",
                "Agents",
                path.join(opencodeDir, "agents"),
            ),
            makeFolder(
                "opencode/folder-plugin",
                "Plugins",
                path.join(opencodeDir, "plugin"),
            ),
        ],
    });

    tools.push({
        id: "aider",
        name: "Aider",
        group: "cli",
        subtitle: "~",
        files: [
            makeFile(
                "aider/.aider.conf.yml",
                ".aider.conf.yml",
                path.join(HOME, ".aider.conf.yml"),
            ),
            makeFile("aider/.env", ".env", path.join(HOME, ".env"), {
                secret: true,
                note: "Aider reads API keys from %USERPROFILE%\\.env (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY).",
            }),
        ],
    });

    const claudeDir = path.join(HOME, ".claude");
    tools.push({
        id: "claude-code",
        name: "Claude Code",
        group: "cli",
        subtitle: "~\\.claude",
        rootPath: claudeDir,
        files: [
            makeFile(
                "claude-code/settings.json",
                "settings.json",
                path.join(claudeDir, "settings.json"),
            ),
            makeFile(
                "claude-code/.claude.json",
                ".claude.json",
                path.join(HOME, ".claude.json"),
                {
                    secret: true,
                    note: "Contains account/session state and OAuth tokens.",
                },
            ),
        ],
        folders: [
            makeFolder(
                "claude-code/folder-commands",
                "Commands",
                path.join(claudeDir, "commands"),
            ),
            makeFolder(
                "claude-code/folder-agents",
                "Agents",
                path.join(claudeDir, "agents"),
            ),
            makeFolder(
                "claude-code/folder-skills",
                "Skills",
                path.join(claudeDir, "skills"),
            ),
        ],
    });

    tools.push({
        id: "gemini-cli",
        name: "Gemini CLI",
        group: "cli",
        subtitle: "~\\.gemini",
        rootPath: path.join(HOME, ".gemini"),
        files: [
            makeFile(
                "gemini-cli/settings.json",
                "settings.json",
                path.join(HOME, ".gemini", "settings.json"),
            ),
            makeFile(
                "gemini-cli/GEMINI.md",
                "GEMINI.md",
                path.join(HOME, ".gemini", "GEMINI.md"),
            ),
        ],
        folders: [
            makeFolder(
                "gemini-cli/folder-commands",
                "Commands",
                path.join(HOME, ".gemini", "commands"),
            ),
        ],
    });

    tools.push({
        id: "codex",
        name: "Codex CLI",
        group: "cli",
        subtitle: "~\\.codex",
        rootPath: path.join(HOME, ".codex"),
        files: [
            makeFile(
                "codex/config.toml",
                "config.toml",
                path.join(HOME, ".codex", "config.toml"),
            ),
            makeFile(
                "codex/auth.json",
                "auth.json",
                path.join(HOME, ".codex", "auth.json"),
                {
                    secret: true,
                    note: "Contains auth tokens.",
                },
            ),
        ],
        folders: [
            makeFolder(
                "codex/folder-prompts",
                "Prompts",
                path.join(HOME, ".codex", "prompts"),
            ),
        ],
    });

    tools.push({
        id: "continue",
        name: "Continue",
        group: "ext",
        subtitle: "~\\.continue",
        rootPath: path.join(HOME, ".continue"),
        files: [
            makeFile(
                "continue/config.yaml",
                "config.yaml",
                path.join(HOME, ".continue", "config.yaml"),
            ),
            makeFile(
                "continue/config.json",
                "config.json (legacy)",
                path.join(HOME, ".continue", "config.json"),
            ),
        ],
    });

    const flavors = [
        { id: "code", name: "VS Code", dirName: "Code" },
        {
            id: "insiders",
            name: "VS Code Insiders",
            dirName: "Code - Insiders",
        },
        { id: "vscodium", name: "VSCodium", dirName: "VSCodium" },
    ].filter((f) => fs.existsSync(path.join(APPDATA, f.dirName, "User")));

    for (const f of flavors) {
        const userDir = path.join(APPDATA, f.dirName, "User");
        tools.push({
            id: `vscode-${f.id}`,
            name: f.name,
            group: "editor",
            subtitle: `%APPDATA%\\${f.dirName}\\User`,
            rootPath: userDir,
            files: [
                makeFile(
                    `vscode-${f.id}/settings.json`,
                    "settings.json",
                    path.join(userDir, "settings.json"),
                ),
            ],
        });
    }

    const extensions = [
        {
            id: "cline",
            name: "Cline",
            folder: "saoudrizwan.claude-dev",
            file: "settings/cline_mcp_settings.json",
        },
        {
            id: "roo-code",
            name: "Roo Code",
            folder: "RooVeterinaryInc.roo-cline",
            file: "settings/mcp_settings.json",
        },
        {
            id: "kilo-code",
            name: "Kilo Code",
            folder: "kilocode.kilo-code",
            file: "settings/mcp_settings.json",
        },
    ];

    for (const f of flavors) {
        const globalStorage = path.join(
            APPDATA,
            f.dirName,
            "User",
            "globalStorage",
        );
        for (const e of extensions) {
            const extDir = path.join(globalStorage, e.folder);
            if (!fs.existsSync(extDir)) continue;
            const fp = path.join(extDir, ...e.file.split("/"));
            tools.push({
                id: `${e.id}-${f.id}`,
                name: e.name,
                group: "ext",
                subtitle: `${f.name} · ${e.folder}`,
                rootPath: extDir,
                files: [
                    makeFile(
                        `${e.id}-${f.id}/${path.basename(e.file)}`,
                        path.basename(e.file),
                        fp,
                        {
                            note: RELOAD_NOTE,
                        },
                    ),
                ],
            });
        }
    }

    for (const c of settings.custom) {
        let isDir = false;
        try {
            isDir = fs.statSync(c.path).isDirectory();
        } catch {
            // Missing or unreadable path; treat it as a file below.
        }
        if (isDir) {
            tools.push({
                id: c.id,
                name: c.name,
                group: "custom",
                subtitle: c.path,
                files: [],
                folders: [makeFolder(`${c.id}/folder`, "Files", c.path)],
            });
        } else {
            tools.push({
                id: c.id,
                name: c.name,
                group: "custom",
                subtitle: c.path,
                files: [
                    makeFile(
                        `${c.id}/file`,
                        path.basename(c.path) || c.path,
                        c.path,
                    ),
                ],
            });
        }
    }

    for (const t of tools) {
        if (!t.rootPath) continue;
        const rootFolder: ToolFolder = makeFolder(
            `${t.id}/folder-root`,
            "Root folder",
            t.rootPath,
        );
        t.folders = [rootFolder, ...(t.folders ?? [])];
    }

    return tools;
}

/**
 * Collects every registered config file path, normalized for lookups.
 *
 * @param tools - The detected tool list.
 * @returns A set of normalized lowercased paths.
 */
export function registeredPaths(tools: Tool[]): Set<string> {
    const out = new Set<string>();
    for (const t of tools) {
        for (const f of t.files) {
            out.add(path.normalize(canonicalPath(f.path)).toLowerCase());
        }
    }
    return out;
}

/**
 * Finds the registered tool folder that contains a given path.
 *
 * @param tools - The detected tool list.
 * @param filePath - Absolute path to look up.
 * @returns The containing folder when found.
 */
export function findContainingFolder(
    tools: Tool[],
    filePath: string,
): ToolFolder | undefined {
    const norm = path.normalize(canonicalPath(filePath)).toLowerCase();
    for (const t of tools) {
        for (const fo of t.folders ?? []) {
            const root = path.normalize(canonicalPath(fo.path)).toLowerCase();
            if (
                (norm + path.sep).startsWith(
                    root.endsWith(path.sep) ? root : root + path.sep,
                )
            ) {
                return fo;
            }
        }
    }
    return undefined;
}

/**
 * Collects every registered folder root, normalized for lookups.
 *
 * @param tools - The detected tool list.
 * @returns A set of normalized lowercased folder roots.
 */
export function registeredFolderRoots(tools: Tool[]): Set<string> {
    const out = new Set<string>();
    for (const t of tools) {
        for (const fo of t.folders ?? []) {
            out.add(path.normalize(canonicalPath(fo.path)).toLowerCase());
        }
    }
    return out;
}

/**
 * Lists the direct children of a folder, skipping hidden and symlink entries.
 *
 * @param root - Absolute folder path to scan.
 * @returns The directory entries with folders first, then alphabetical order.
 */
export function listDir(root: string): DirEntry[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const out: DirEntry[] = [];
    for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        if (e.isSymbolicLink()) continue;
        const full = path.join(root, e.name);
        const rel = path.relative(root, full);
        try {
            const st = fs.statSync(full);
            out.push({
                name: e.name,
                path: full,
                rel,
                isDir: e.isDirectory(),
                mtime: st.mtimeMs,
                size: st.size,
            });
        } catch {
            // Skip entries that cannot be stat'd (e.g. broken symlinks).
        }
    }
    out.sort((a, b) =>
        a.isDir === b.isDir ? a.rel.localeCompare(b.rel) : a.isDir ? -1 : 1,
    );
    return out;
}

/**
 * Removes line and block comments from a JSONC string.
 *
 * @param src - The raw JSONC source.
 * @returns The source with comments removed, strings preserved.
 */
export function stripJsonComments(src: string): string {
    let out = "";
    let i = 0;
    let inStr = false;
    let inLine = false;
    let inBlock = false;
    while (i < src.length) {
        const ch = src[i];
        const next = src[i + 1];
        if (inLine) {
            if (ch === "\n") {
                inLine = false;
                out += ch;
            }
            i++;
            continue;
        }
        if (inBlock) {
            if (ch === "*" && next === "/") {
                inBlock = false;
                i += 2;
            } else {
                i++;
            }
            continue;
        }
        if (inStr) {
            out += ch;
            if (ch === "\\") {
                out += next ?? "";
                i += 2;
                continue;
            }
            if (ch === '"') inStr = false;
            i++;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === "/" && next === "/") {
            inLine = true;
            i += 2;
            continue;
        }
        if (ch === "/" && next === "*") {
            inBlock = true;
            i += 2;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

/**
 * Removes trailing commas that precede a closing brace or bracket.
 *
 * @param src - The raw source text.
 * @returns The source with trailing commas removed.
 */
export function stripTrailingCommas(src: string): string {
    let out = "";
    let i = 0;
    let inStr = false;
    while (i < src.length) {
        const ch = src[i];
        if (inStr) {
            out += ch;
            if (ch === "\\") {
                out += src[i + 1] ?? "";
                i += 2;
                continue;
            }
            if (ch === '"') inStr = false;
            i++;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === ",") {
            let j = i + 1;
            while (j < src.length && /\s/.test(src[j])) j++;
            if (src[j] === "}" || src[j] === "]") {
                i++;
                continue;
            }
        }
        out += ch;
        i++;
    }
    return out;
}
