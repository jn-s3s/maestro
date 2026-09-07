import { memo, useState, type JSX } from "react";
import {
    ChevronDown,
    ChevronLeft,
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
    const rootFolder = (tool.folders ?? []).find(
        (f) => f.id === `${tool.id}/folder-root`,
    );
    const subFolders = (tool.folders ?? []).filter(
        (f) => f.id !== `${tool.id}/folder-root`,
    );
    return (
        <div>
            <div className="flex w-full items-center gap-1 rounded-lg transition-colors hover:bg-raised">
                {rootFolder ? (
                    <button
                        type="button"
                        title={rootFolder.path}
                        className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                            rootFolder.id === selectedFolderId
                                ? "bg-accentsoft ring-1 ring-accent/30 ring-inset"
                                : ""
                        }`}
                        onClick={() => onSelectFolder(tool, rootFolder)}
                    >
                        <Folder
                            size={11}
                            className={`shrink-0 ${rootFolder.exists ? "text-violet-400" : "text-line2"}`}
                            fill="currentColor"
                            strokeWidth={0}
                        />
                        <span
                            className={`truncate text-[13px] font-medium ${
                                rootFolder.id === selectedFolderId
                                    ? "text-primary"
                                    : "text-secondary"
                            }`}
                        >
                            {tool.name}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-faint">
                            {existing}/{total}
                        </span>
                    </button>
                ) : (
                    <button
                        type="button"
                        className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left transition-colors"
                        onClick={onToggle}
                    >
                        <span className="truncate text-[13px] font-medium text-primary">
                            {tool.name}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-faint">
                            {existing}/{total}
                        </span>
                    </button>
                )}
                {(tool.files.length > 0 || subFolders.length > 0) && (
                    <button
                        type="button"
                        title={open ? "Hide details" : "Show details"}
                        onClick={onToggle}
                        className="shrink-0 rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-primary"
                    >
                        {open ? (
                            <ChevronDown size={13} />
                        ) : (
                            <ChevronRight size={13} />
                        )}
                    </button>
                )}
            </div>
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
                    {subFolders.map((folder) => (
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
    collapsed: boolean;
    onToggle: () => void;
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
 * @param collapsed - Whether the whole sidebar is collapsed to a thin rail.
 * @param onToggle - Flips the whole-sidebar collapsed state.
 */
export default function Sidebar({
    tools,
    selectedId,
    selectedFolderId,
    onSelect,
    onSelectFolder,
    onManage,
    collapsed,
    onToggle,
}: Props): JSX.Element {
    const [groupCollapsed, setGroupCollapsed] = useState<
        Record<string, boolean>
    >({});

    const groups = ORDER.map((g) => ({
        group: g,
        items: tools.filter((t) => t.group === g),
    })).filter((g) => g.items.length > 0);

    const toggle = (key: string): void =>
        setGroupCollapsed((c) => ({ ...c, [key]: !c[key] }));

    if (collapsed) {
        return (
            <aside className="flex w-12 shrink-0 flex-col items-center border-r border-line bg-surface/50 py-3">
                <button
                    type="button"
                    title="Expand sidebar"
                    aria-label="Expand sidebar"
                    aria-expanded={!collapsed}
                    onClick={onToggle}
                    className="rounded-lg p-2 text-secondary transition-colors hover:bg-raised hover:text-primary"
                >
                    <ChevronRight size={15} />
                </button>
            </aside>
        );
    }

    return (
        <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-surface/50">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <p className="text-[11px] text-faint">
                    {tools.length} tools · folders & files detected
                </p>
                <button
                    type="button"
                    title="Collapse sidebar"
                    aria-label="Collapse sidebar"
                    aria-expanded={!collapsed}
                    onClick={onToggle}
                    className="rounded-lg p-1 text-faint transition-colors hover:bg-raised hover:text-primary"
                >
                    <ChevronLeft size={14} />
                </button>
            </div>

            <nav className="flex-1 overflow-y-auto px-2 py-3">
                {groups.length === 0 && (
                    <p className="px-3 py-6 text-xs leading-relaxed text-faint">
                        No tools detected yet. Config files appear here
                        automatically once their directories exist.
                    </p>
                )}
                {groups.map(({ group, items }) => {
                    const groupCollapsedState = groupCollapsed[group] ?? false;
                    return (
                        <div key={group} className="mb-4">
                            <button
                                type="button"
                                className="mb-1 flex w-full items-center gap-1 rounded-lg px-2 py-1 text-left text-[10px] font-semibold tracking-wider text-faint uppercase transition-colors hover:bg-raised"
                                onClick={() => toggle(group)}
                            >
                                {groupCollapsedState ? (
                                    <ChevronRight size={11} />
                                ) : (
                                    <ChevronDown size={11} />
                                )}
                                {GROUP_LABELS[group]}
                                <span className="ml-auto normal-case">
                                    {items.length}
                                </span>
                            </button>

                            {!groupCollapsedState &&
                                items.map((tool) => (
                                    <ToolBlock
                                        key={tool.id}
                                        tool={tool}
                                        open={!groupCollapsed[tool.id]}
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
