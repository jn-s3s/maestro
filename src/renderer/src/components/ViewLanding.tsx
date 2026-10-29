import type { JSX } from "react";
import {
    BookOpen,
    FileCog,
    Folder,
    Lock,
    Plug,
    Search,
    Settings2,
} from "lucide-react";
import type { Tool, ToolFile, ToolFolder } from "../../../shared/types";

interface FileEntry {
    tool: Tool;
    file: ToolFile;
}

interface FolderEntry {
    tool: Tool;
    folder: ToolFolder;
}

interface Props {
    view: "mcp" | "library";
    files: FileEntry[];
    folders: FolderEntry[];
    onOpenFile: (tool: Tool, file: ToolFile) => void;
    onOpenFolder: (tool: Tool, folder: ToolFolder) => void;
    onSearch: () => void;
    onSettings: () => void;
}

/**
 * Landing view for the MCP and Library collections. Lists the detected
 * configurations with their owning tool and opens them in the usual tabs and
 * folder browser.
 *
 * @param view - The active collection.
 * @param files - Matching files across visible tools.
 * @param folders - Matching folders across visible tools.
 * @param onOpenFile - Opens a file in a tab.
 * @param onOpenFolder - Opens a folder in the browser.
 * @param onSearch - Opens the command palette.
 * @param onSettings - Opens tool settings.
 */
export default function ViewLanding({
    view,
    files,
    folders,
    onOpenFile,
    onOpenFolder,
    onSearch,
    onSettings,
}: Props): JSX.Element {
    const mcp = view === "mcp";
    const total = files.length + folders.length;
    return (
        <div className="grid flex-1 place-items-center overflow-y-auto p-8">
            <div className="w-full max-w-xl">
                <div className="flex items-start gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accentsoft text-accent">
                        {mcp ? <Plug size={19} /> : <BookOpen size={19} />}
                    </span>
                    <div>
                        <h2 className="text-sm font-semibold text-primary">
                            {mcp ? "MCP servers" : "Library"}
                        </h2>
                        <p className="mt-1 text-xs leading-relaxed text-faint">
                            {mcp
                                ? "MCP configuration files detected across your tools. Open one to review or extend its server list."
                                : "Prompt, agent, skill and command folders plus shared instruction files. Open a folder to browse its entries."}
                        </p>
                    </div>
                </div>

                <p className="mt-4 text-[11px] text-faint">
                    {total}{" "}
                    {mcp
                        ? total === 1
                            ? "configuration"
                            : "configurations"
                        : total === 1
                          ? "entry"
                          : "entries"}{" "}
                    detected
                </p>

                {folders.length > 0 && (
                    <div className="mt-4">
                        <p className="mb-1.5 text-[10px] font-semibold tracking-wider text-faint uppercase">
                            Folders
                        </p>
                        <ul className="space-y-1">
                            {folders.map(({ tool, folder }) => (
                                <li key={`${tool.id}:${folder.id}`}>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            onOpenFolder(tool, folder)
                                        }
                                        className="flex w-full items-center gap-2 rounded-xl border border-line px-3 py-2 text-left transition-colors hover:bg-raised"
                                    >
                                        <Folder
                                            size={13}
                                            className="shrink-0 text-violet-400"
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-xs text-primary">
                                                {folder.label}
                                            </span>
                                            <span
                                                className="block truncate font-mono text-[10px] text-faint"
                                                title={folder.path}
                                            >
                                                {folder.path}
                                            </span>
                                        </span>
                                        <span className="shrink-0 text-[10px] text-faint">
                                            {tool.name}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {files.length > 0 && (
                    <div className="mt-4">
                        <p className="mb-1.5 text-[10px] font-semibold tracking-wider text-faint uppercase">
                            {mcp ? "Configurations" : "Instruction files"}
                        </p>
                        <ul className="space-y-1">
                            {files.map(({ tool, file }) => (
                                <li key={`${tool.id}:${file.id}`}>
                                    <button
                                        type="button"
                                        onClick={() => onOpenFile(tool, file)}
                                        className="flex w-full items-center gap-2 rounded-xl border border-line px-3 py-2 text-left transition-colors hover:bg-raised"
                                    >
                                        <FileCog
                                            size={13}
                                            className="shrink-0 text-accent"
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-xs text-primary">
                                                {file.label}
                                            </span>
                                            <span
                                                className="block truncate font-mono text-[10px] text-faint"
                                                title={file.path}
                                            >
                                                {file.path}
                                            </span>
                                        </span>
                                        {file.secret && (
                                            <Lock
                                                size={11}
                                                className="shrink-0 text-amber-500"
                                            />
                                        )}
                                        <span className="shrink-0 text-[10px] text-faint">
                                            {tool.name}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {total === 0 && (
                    <p className="mt-5 rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs leading-relaxed text-faint">
                        {mcp
                            ? "No MCP configurations detected. Register a workspace with .mcp.json or install an extension that stores MCP settings."
                            : "No skills, agents, commands, prompts or instruction files detected yet."}
                    </p>
                )}

                <div className="mt-6 flex justify-center gap-2">
                    <button
                        type="button"
                        onClick={onSearch}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-accent2"
                    >
                        <Search size={13} />
                        Search configs
                    </button>
                    <button
                        type="button"
                        onClick={onSettings}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3.5 py-2 text-xs text-secondary transition-colors hover:bg-raised hover:text-primary"
                    >
                        <Settings2 size={13} />
                        Manage tools
                    </button>
                </div>
            </div>
        </div>
    );
}
