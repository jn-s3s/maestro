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
const LOCALAPPDATA =
    process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

/**
 * Returns the first candidate path that exists, or undefined when none do.
 * `fs.existsSync` can throw on malformed Windows paths, so each probe is
 * guarded.
 */
function firstExisting(...candidates: string[]): string | undefined {
    return candidates.find((p) => {
        try {
            return fs.existsSync(p);
        } catch {
            return false;
        }
    });
}

/**
 * Resolves the XDG data home; the XDG_DATA_HOME env var wins, otherwise the
 * Windows canonical fallback is `%LOCALAPPDATA%`.
 */
function xdgDataHome(): string {
    return process.env.XDG_DATA_HOME || LOCALAPPDATA;
}

/**
 * Resolves the XDG config home; the XDG_CONFIG_HOME env var wins, otherwise
 * the Windows canonical fallback is `%APPDATA%`.
 */
function xdgConfigHome(): string {
    return process.env.XDG_CONFIG_HOME || APPDATA;
}

/**
 * Resolves OpenCode's data directory. Prefers the XDG data root, then the
 * `~/.local/share/opencode` location some builds use, and finally falls back
 * to the first candidate so the sidebar surfaces it with `exists: false`.
 */
function opencodeDataDir(): string {
    const candidates = [
        path.join(xdgDataHome(), "opencode"),
        path.join(HOME, ".local", "share", "opencode"),
    ];
    return firstExisting(...candidates) ?? candidates[0];
}

/**
 * Resolves Codex's home directory; a non-empty CODEX_HOME env var overrides
 * the whole `~/.codex` default. The env value is normalized so a trailing
 * separator cannot leak into the synthesised root folder's path.
 */
function codexHome(): string {
    const override = process.env.CODEX_HOME?.trim();
    if (override) {
        return path.normalize(override);
    }
    return path.join(HOME, ".codex");
}

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

function makeFolder(
    id: string,
    label: string,
    folderPath: string,
    extra?: Partial<ToolFolder>,
): ToolFolder {
    return {
        id,
        label,
        path: folderPath,
        exists: fs.existsSync(folderPath),
        ...extra,
    };
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
 * Synthesises a "Root folder" entry for each tool `roots` entry and prepends
 * them to the tool's `folders` array. Tools without `roots` are left unchanged.
 *
 * @param settings - Settings that carry the custom entries to include.
 * @returns The complete list of detected tools.
 */
export function detectTools(settings: AppSettings): Tool[] {
    const tools: Tool[] = [];

    const opencodeDir =
        firstExisting(
            path.join(xdgConfigHome(), "opencode"),
            path.join(HOME, ".config", "opencode"),
        ) ?? path.join(xdgConfigHome(), "opencode");
    const opencodeLocal = opencodeDataDir();
    tools.push({
        id: "opencode",
        name: "OpenCode",
        group: "cli",
        subtitle: "~\\.config\\opencode",
        roots: [
            { path: opencodeDir, section: "Config" },
            { path: opencodeLocal, section: "Data" },
        ],
        files: [
            makeFile(
                "opencode/opencode.json",
                "opencode.json",
                path.join(opencodeDir, "opencode.json"),
                { section: "Config" },
            ),
            makeFile(
                "opencode/opencode.jsonc",
                "opencode.jsonc",
                path.join(opencodeDir, "opencode.jsonc"),
                {
                    note: "OpenCode prefers opencode.jsonc over opencode.json when both exist.",
                    section: "Config",
                },
            ),
            makeFile(
                "opencode/auth.json",
                "auth.json",
                path.join(opencodeLocal, "auth.json"),
                {
                    secret: true,
                    note: "OAuth/session tokens.",
                    section: "Data",
                },
            ),
        ],
        folders: [
            makeFolder(
                "opencode/folder-command",
                "commands",
                path.join(opencodeDir, "command"),
                { section: "Config" },
            ),
            makeFolder(
                "opencode/folder-agents",
                "agents",
                path.join(opencodeDir, "agents"),
                { section: "Config" },
            ),
            makeFolder(
                "opencode/folder-plugins",
                "plugins",
                path.join(opencodeDir, "plugins"),
                { section: "Config" },
            ),
            makeFolder(
                "opencode/folder-storage",
                "storage",
                path.join(opencodeLocal, "storage"),
                { section: "Data" },
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
                { section: "Config" },
            ),
            makeFile("aider/.env", ".env", path.join(HOME, ".env"), {
                secret: true,
                note: "Aider reads API keys from %USERPROFILE%\\.env (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY).",
                section: "Config",
            }),
        ],
    });

    const claudeDir = path.join(HOME, ".claude");
    tools.push({
        id: "claude-code",
        name: "Claude Code",
        group: "cli",
        subtitle: "~\\.claude",
        roots: [{ path: claudeDir, section: "Config" }],
        files: [
            makeFile(
                "claude-code/settings.json",
                "settings.json",
                path.join(claudeDir, "settings.json"),
                { section: "Config" },
            ),
            makeFile(
                "claude-code/.claude.json",
                ".claude.json",
                path.join(HOME, ".claude.json"),
                {
                    secret: true,
                    note: "Contains account/session state and OAuth tokens.",
                    section: "Config",
                },
            ),
        ],
        folders: [
            makeFolder(
                "claude-code/folder-commands",
                "commands",
                path.join(claudeDir, "commands"),
                { section: "Config" },
            ),
            makeFolder(
                "claude-code/folder-agents",
                "agents",
                path.join(claudeDir, "agents"),
                { section: "Config" },
            ),
            makeFolder(
                "claude-code/folder-skills",
                "skills",
                path.join(claudeDir, "skills"),
                { section: "Config" },
            ),
        ],
    });

    tools.push({
        id: "gemini-cli",
        name: "Gemini CLI",
        group: "cli",
        subtitle: "~\\.gemini",
        roots: [{ path: path.join(HOME, ".gemini"), section: "Config" }],
        files: [
            makeFile(
                "gemini-cli/settings.json",
                "settings.json",
                path.join(HOME, ".gemini", "settings.json"),
                { section: "Config" },
            ),
            makeFile(
                "gemini-cli/GEMINI.md",
                "GEMINI.md",
                path.join(HOME, ".gemini", "GEMINI.md"),
                { section: "Config" },
            ),
            makeFile(
                "gemini-cli/.env",
                ".env",
                path.join(HOME, ".gemini", ".env"),
                {
                    secret: true,
                    section: "Config",
                },
            ),
        ],
        folders: [
            makeFolder(
                "gemini-cli/folder-commands",
                "commands",
                path.join(HOME, ".gemini", "commands"),
                { section: "Config" },
            ),
            makeFolder(
                "gemini-cli/folder-extensions",
                "extensions",
                path.join(HOME, ".gemini", "extensions"),
                { section: "Config" },
            ),
        ],
    });

    const codexRoot = codexHome();
    tools.push({
        id: "codex",
        name: "Codex CLI",
        group: "cli",
        subtitle: "~\\.codex",
        roots: [{ path: codexRoot, section: "Config" }],
        files: [
            makeFile(
                "codex/config.toml",
                "config.toml",
                path.join(codexRoot, "config.toml"),
                { section: "Config" },
            ),
            makeFile(
                "codex/auth.json",
                "auth.json",
                path.join(codexRoot, "auth.json"),
                {
                    secret: true,
                    note: "Contains auth tokens.",
                    section: "Config",
                },
            ),
            makeFile(
                "codex/.credentials.json",
                ".credentials.json",
                path.join(codexRoot, ".credentials.json"),
                {
                    secret: true,
                    section: "Config",
                },
            ),
        ],
        folders: [
            makeFolder(
                "codex/folder-prompts",
                "prompts",
                path.join(codexRoot, "prompts"),
                { section: "Config" },
            ),
            makeFolder(
                "codex/folder-skills",
                "skills",
                path.join(codexRoot, "skills"),
                { section: "Config" },
            ),
        ],
    });

    tools.push({
        id: "continue",
        name: "Continue",
        group: "ext",
        subtitle: "~\\.continue",
        roots: [{ path: path.join(HOME, ".continue"), section: "Config" }],
        files: [
            makeFile(
                "continue/config.yaml",
                "config.yaml",
                path.join(HOME, ".continue", "config.yaml"),
                { section: "Config" },
            ),
            makeFile(
                "continue/config.json",
                "config.json (legacy)",
                path.join(HOME, ".continue", "config.json"),
                { section: "Config" },
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
            roots: [{ path: userDir, section: "Config" }],
            files: [
                makeFile(
                    `vscode-${f.id}/settings.json`,
                    "settings.json",
                    path.join(userDir, "settings.json"),
                    { section: "Config" },
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
                roots: [{ path: extDir, section: "Config" }],
                files: [
                    makeFile(
                        `${e.id}-${f.id}/${path.basename(e.file)}`,
                        path.basename(e.file),
                        fp,
                        {
                            note: RELOAD_NOTE,
                            section: "Config",
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
                folders: [
                    makeFolder(`${c.id}/folder`, "Files", c.path, {
                        section: "Config",
                    }),
                ],
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
                        { section: "Config" },
                    ),
                ],
            });
        }
    }

    const slug = (s: string): string =>
        s
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "") || "root";

    for (const t of tools) {
        if (!t.roots?.length) continue;
        const roots = t.roots.map((r, i) =>
            makeFolder(
                `${t.id}/folder-root-${slug(r.section)}-${i}`,
                r.label ?? r.section,
                r.path,
                {
                    section: r.section,
                },
            ),
        );
        t.folders = [...roots, ...(t.folders ?? [])];
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
    let best: ToolFolder | undefined;
    let bestLen = -1;
    for (const t of tools) {
        for (const fo of t.folders ?? []) {
            let root = path.normalize(canonicalPath(fo.path)).toLowerCase();
            if (!root.endsWith(path.sep)) root += path.sep;
            if ((norm + path.sep).startsWith(root) && root.length > bestLen) {
                best = fo;
                bestLen = root.length;
            }
        }
    }
    return best;
}

/**
 * Reports whether a canonical path is registered as a secret-bearing file.
 *
 * @param tools - The detected tool list.
 * @param filePath - Absolute path to look up.
 * @returns True when the exact file is flagged secret.
 */
export function isSecretPath(tools: Tool[], filePath: string): boolean {
    const key = path.normalize(canonicalPath(filePath)).toLowerCase();
    for (const t of tools) {
        for (const f of t.files) {
            if (
                f.secret === true &&
                path.normalize(canonicalPath(f.path)).toLowerCase() === key
            ) {
                return true;
            }
        }
    }
    return false;
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
 * JSONC comment and trailing-comma stripping helpers, re-exported from
 * `src/shared/jsonc.ts` so main-process consumers (see index.ts) keep a single
 * import surface.
 */
export { stripJsonComments, stripTrailingCommas } from "../shared/jsonc";
