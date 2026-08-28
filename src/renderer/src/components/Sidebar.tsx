import { memo, useState, type JSX } from "react";
import {
    ChevronDown,
    ChevronRight,
    Folder,
    Lock,
    Settings2,
} from "lucide-react";
import type {
    Tool,
    ToolFile,
    ToolFolder,
    ToolGroup,
} from "../../../shared/types";

const GROUP_LABELS: Record<ToolGroup, string> = {
    cli: "CLI Tools",
    editor: "Editors",
    ext: "VS Code Extensions",
    custom: "Custom",
};

const ORDER: ToolGroup[] = ["cli", "editor", "ext", "custom"];

interface RowProps {
    file: ToolFile;
    active: boolean;
    onClick: () => void;
}

const FileRow = memo(function FileRow({
    file,
    active,
    onClick,
}: RowProps): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                active
                    ? "bg-accentsoft ring-1 ring-accent/30 ring-inset"
                    : "hover:bg-raised"
            }`}
        >
            <span
                className={`size-1.5 shrink-0 rounded-full ${file.exists ? "bg-emerald-500" : "bg-line2"}`}
            />
            <span
                className={`truncate text-xs ${active ? "font-medium text-primary" : "text-secondary"}`}
                title={file.path}
            >
                {file.label}
            </span>
            {file.secret && (
                <Lock size={11} className="ml-auto shrink-0 text-amber-500" />
            )}
        </button>
    );
});

interface FolderRowProps {
    folder: ToolFolder;
    active: boolean;
    onClick: () => void;
}

const FolderRow = memo(function FolderRow({
    folder,
    active,
    onClick,
}: FolderRowProps): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                active
                    ? "bg-accentsoft ring-1 ring-accent/30 ring-inset"
                    : "hover:bg-raised"
            }`}
        >
            <Folder
                size={11}
                className={`shrink-0 ${folder.exists ? "text-violet-400" : "text-line2"}`}
                fill="currentColor"
                strokeWidth={0}
            />
            <span
                className={`truncate text-xs ${active ? "font-medium text-primary" : "text-secondary"}`}
                title={folder.path}
            >
                {folder.label}
            </span>
        </button>
    );
});

interface BlockProps {
    tool: Tool;
    open: boolean;
    onToggle: () => void;
    selectedId: string | null;
    selectedFolderId: string | null;
    onSelect: (tool: Tool, file: ToolFile) => void;
    onSelectFolder: (tool: Tool, folder: ToolFolder) => void;
}

const ToolBlock = memo(function ToolBlock({
    tool,
    open,
    onToggle,
    selectedId,
    selectedFolderId,
    onSelect,
    onSelectFolder,
}: BlockProps): JSX.Element {
    const existing =
        tool.files.filter((f) => f.exists).length +
        (tool.folders ?? []).filter((f) => f.exists).length;
    const total = tool.files.length + (tool.folders ?? []).length;
    const folders = tool.folders ?? [];
    return (
        <div>
            <button
                type="button"
                className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-raised"
                onClick={onToggle}
            >
                {open ? (
                    <ChevronDown size={13} className="text-faint" />
                ) : (
                    <ChevronRight size={13} className="text-faint" />
                )}
                <span className="truncate text-[13px] font-medium text-primary">
                    {tool.name}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-faint">
                    {existing}/{total}
                </span>
            </button>
            {open && (
                <ul className="mt-0.5 space-y-0.5 pl-3">
                    {tool.files.map((file) => (
                        <li key={file.id}>
                            <FileRow
                                file={file}
                                active={file.id === selectedId}
                                onClick={() => onSelect(tool, file)}
                            />
                        </li>
                    ))}
                    {folders.map((folder) => (
                        <li key={folder.id}>
                            <FolderRow
                                folder={folder}
                                active={folder.id === selectedFolderId}
                                onClick={() => onSelectFolder(tool, folder)}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
});

interface Props {
    tools: Tool[];
    selectedId: string | null;
    selectedFolderId: string | null;
    onSelect: (tool: Tool, file: ToolFile) => void;
    onSelectFolder: (tool: Tool, folder: ToolFolder) => void;
    onManage: () => void;
}

/**
 * Collapsible sidebar listing detected tools grouped by category.
 *
 * @param tools - The detected tool registry.
 * @param selectedId - Currently selected file id.
 * @param selectedFolderId - Currently selected folder id.
 * @param onSelect - Selects a config file.
 * @param onSelectFolder - Selects a tool folder.
 * @param onManage - Opens the settings modal.
 */
export default function Sidebar({
    tools,
    selectedId,
    selectedFolderId,
    onSelect,
    onSelectFolder,
    onManage,
}: Props): JSX.Element {
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

    const groups = ORDER.map((g) => ({
        group: g,
        items: tools.filter((t) => t.group === g),
    })).filter((g) => g.items.length > 0);

    const toggle = (key: string): void =>
        setCollapsed((c) => ({ ...c, [key]: !c[key] }));

    return (
        <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-surface/50">
            <div className="border-b border-line px-4 py-3">
                <p className="text-[11px] text-faint">
                    {tools.length} tools · folders & files detected
                </p>
            </div>

            <nav className="flex-1 overflow-y-auto px-2 py-3">
                {groups.length === 0 && (
                    <p className="px-3 py-6 text-xs leading-relaxed text-faint">
                        No tools detected yet. Config files appear here
                        automatically once their directories exist.
                    </p>
                )}
                {groups.map(({ group, items }) => {
                    const groupCollapsed = collapsed[group] ?? false;
                    return (
                        <div key={group} className="mb-4">
                            <button
                                type="button"
                                className="mb-1 flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-[10px] font-semibold tracking-wider text-faint uppercase transition-colors hover:bg-raised"
                                onClick={() => toggle(group)}
                            >
                                {groupCollapsed ? (
                                    <ChevronRight size={11} />
                                ) : (
                                    <ChevronDown size={11} />
                                )}
                                {GROUP_LABELS[group]}
                                <span className="ml-auto normal-case">
                                    {items.length}
                                </span>
                            </button>

                            {!groupCollapsed &&
                                items.map((tool) => (
                                    <ToolBlock
                                        key={tool.id}
                                        tool={tool}
                                        open={!collapsed[tool.id]}
                                        onToggle={() => toggle(tool.id)}
                                        selectedId={selectedId}
                                        selectedFolderId={selectedFolderId}
                                        onSelect={onSelect}
                                        onSelectFolder={onSelectFolder}
                                    />
                                ))}
                        </div>
                    );
                })}
            </nav>

            <div className="border-t border-line p-2">
                <button
                    type="button"
                    onClick={onManage}
                    className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs text-secondary transition-colors hover:bg-raised hover:text-primary"
                >
                    <Settings2 size={14} />
                    Manage tools & settings
                </button>
            </div>
        </aside>
    );
}
