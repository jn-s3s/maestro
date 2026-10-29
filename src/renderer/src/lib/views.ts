import type { Tool, ToolFile, ToolFolder } from "../../../shared/types";

export type NavView = "configs" | "mcp" | "library";

const MCP_NAMES = new Set([
    ".mcp.json",
    "mcp.json",
    "mcp_settings.json",
    "cline_mcp_settings.json",
]);

const LIBRARY_FOLDERS = new Set([
    "agent",
    "agents",
    "command",
    "commands",
    "hook",
    "hooks",
    "plugin",
    "plugins",
    "prompt",
    "prompts",
    "skill",
    "skills",
]);

const INSTRUCTION_FILES = new Set(["agents.md", "claude.md", "gemini.md"]);

function baseName(path: string): string {
    return path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

/**
 * Reports whether a registered file is an MCP server configuration.
 *
 * @param file - The file to classify.
 * @returns True for known MCP file names or labels that mention MCP.
 */
export function isMcpFile(file: ToolFile): boolean {
    return (
        MCP_NAMES.has(baseName(file.path)) ||
        file.label.toLowerCase().includes("mcp")
    );
}

/**
 * Reports whether a registered file is a shared instruction file.
 *
 * @param file - The file to classify.
 * @returns True for AGENTS.md, CLAUDE.md and GEMINI.md.
 */
export function isLibraryFile(file: ToolFile): boolean {
    return INSTRUCTION_FILES.has(baseName(file.path));
}

/**
 * Reports whether a registered folder holds skills, agents, commands, prompts,
 * plugins or hooks.
 *
 * @param folder - The folder to classify.
 * @returns True when the folder is part of the library.
 */
export function isLibraryFolder(folder: ToolFolder): boolean {
    return (
        LIBRARY_FOLDERS.has(baseName(folder.path)) ||
        LIBRARY_FOLDERS.has(folder.label.toLowerCase())
    );
}

/**
 * Narrows a tool to the entries shown by a navigation view.
 *
 * @param tool - The detected tool.
 * @param view - The active navigation view.
 * @returns A filtered copy, or null when the tool has no matching entries.
 */
export function filterToolForView(tool: Tool, view: NavView): Tool | null {
    if (view === "configs") {
        return tool;
    }
    const files = tool.files.filter(view === "mcp" ? isMcpFile : isLibraryFile);
    const folders =
        view === "library" ? (tool.folders ?? []).filter(isLibraryFolder) : [];
    if (files.length === 0 && folders.length === 0) {
        return null;
    }
    // Sections come from the remaining entries; root folders would only add
    // Config and Data rows that are not part of this collection.
    return { ...tool, files, folders, roots: [] };
}

/**
 * Counts the entries a navigation view shows.
 *
 * @param tools - The visible tools.
 * @param view - The active navigation view.
 * @returns Tool count for configurations, entry count for collections.
 */
export function viewEntryCount(tools: Tool[], view: NavView): number {
    if (view === "configs") {
        return tools.length;
    }
    return tools.reduce((total, tool) => {
        const filtered = filterToolForView(tool, view);
        return (
            total +
            (filtered
                ? filtered.files.length + (filtered.folders?.length ?? 0)
                : 0)
        );
    }, 0);
}
