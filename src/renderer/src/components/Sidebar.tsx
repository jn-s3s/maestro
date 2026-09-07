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
    ToolRoot,
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
            className={`flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors ${
                active
                    ? "bg-accentsoft ring-1 ring-accent/30 ring-inset"
                    : "hover:bg-raised"
            }`}
        >
            <span
                className={`size-1.5 shrink-0 ${file.exists ? "bg-emerald-500" : "bg-line2"}`}
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
    isRoot: boolean;
    active: boolean;
    onClick: () => void;
}

const FolderRow = memo(function FolderRow({
    folder,
    isRoot,
    active,
    onClick,
}: FolderRowProps): JSX.Element {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors ${
                active
                    ? "bg-accentsoft ring-1 ring-accent/30 ring-inset"
                    : isRoot
                      ? "border-l-2 border-accent/60 bg-raised/40 hover:bg-raised"
                      : "hover:bg-raised"
            }`}
        >
            <Folder
                size={11}
                className={`shrink-0 ${
                    folder.exists
                        ? isRoot
                            ? "text-accent"
                            : "text-violet-400"
                        : "text-line2"
                }`}
                fill={isRoot ? "currentColor" : "none"}
                strokeWidth={isRoot ? 0 : 1.7}
            />
            <span
                className={`truncate text-xs ${
                    active || isRoot
                        ? "font-medium text-primary"
                        : "text-secondary"
                }`}
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

interface SidebarSection {
    name: string;
    files: ToolFile[];
    folders: ToolFolder[];
}

interface SectionHeaderProps {
    name: string;
    count: number;
    first: boolean;
}

const SectionHeader = memo(function SectionHeader({
    name,
    count,
    first,
}: SectionHeaderProps): JSX.Element {
    return (
        <p
            className={`flex items-center gap-2 border-l-2 border-accent bg-raised/40 px-2 py-1 text-[11px] font-semibold tracking-wide text-secondary uppercase ${first ? "mt-1" : "mt-3 border-t border-line pt-2"}`}
        >
            {name}
            <span className="text-[10px] font-medium tracking-normal text-faint">
                {count}
            </span>
        </p>
    );
});

/**
 * Groups files and folders in the display order defined by the tool roots.
 */
function buildSections(tool: Tool): SidebarSection[] {
    const roots: ToolRoot[] = tool.roots ?? [];
    const folders = tool.folders ?? [];
    const rootPaths = new Set(roots.map((root) => root.path));
    const rootFolders: ToolFolder[] = roots.map((root, index) => {
        const existing = folders.find((folder) => folder.path === root.path);
        return {
            id: existing?.id ?? `${tool.id}/root/${index}`,
            // The section label supplies the context when a root has no custom label.
            label: root.label ?? root.section,
            path: root.path,
            exists: existing?.exists ?? true,
            section: root.section,
        };
    });
    const itemFolders = folders.filter((folder) => !rootPaths.has(folder.path));
    const sectionNames: string[] = [];
    const addSectionName = (name: string | undefined): void => {
        if (name && name !== "Other" && !sectionNames.includes(name)) {
            sectionNames.push(name);
        }
    };

    roots.forEach((root) => addSectionName(root.section));
    tool.files.forEach((file) => addSectionName(file.section));
    itemFolders.forEach((folder) => addSectionName(folder.section));

    const sections = sectionNames.map((name) => ({
        name,
        files: [] as ToolFile[],
        folders: [] as ToolFolder[],
    }));
    const other: SidebarSection = {
        name: "Other",
        files: [],
        folders: [],
    };
    const sectionFor = (name: string | undefined): SidebarSection =>
        sectionNames.includes(name ?? "")
            ? sections[sectionNames.indexOf(name as string)]
            : other;

    rootFolders.forEach((folder) =>
        sectionFor(folder.section).folders.push(folder),
    );
    tool.files.forEach((file) => sectionFor(file.section).files.push(file));
    itemFolders.forEach((folder) =>
        sectionFor(folder.section).folders.push(folder),
    );

    return [...sections, other]
        .map((section) => ({
            ...section,
            files: [...section.files].sort((a, b) =>
                a.label.localeCompare(b.label),
            ),
            folders: [...section.folders].sort((a, b) => {
                const aIsRoot = rootPaths.has(a.path);
                const bIsRoot = rootPaths.has(b.path);
                if (aIsRoot !== bIsRoot) {
                    return aIsRoot ? -1 : 1;
                }
                return a.label.localeCompare(b.label);
            }),
        }))
        .filter(
            (section) => section.files.length > 0 || section.folders.length > 0,
        );
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
    const sections = buildSections(tool);
    const rootPaths = new Set((tool.roots ?? []).map((root) => root.path));
    const allFiles = sections.flatMap((section) => section.files);
    const allFolders = sections.flatMap((section) => section.folders);
    const hasItems = sections.length > 0;
    const existing =
        allFiles.filter((file) => file.exists).length +
        allFolders.filter((folder) => folder.exists).length;
    const total = allFiles.length + allFolders.length;
    return (
        <div>
            <button
                type="button"
                title={
                    hasItems
                        ? open
                            ? "Hide details"
                            : "Show details"
                        : undefined
                }
                onClick={hasItems ? onToggle : undefined}
                className="flex w-full items-center gap-1 px-2 py-1.5 text-left transition-colors hover:bg-raised"
            >
                <span className="truncate text-[13px] font-medium text-primary">
                    {tool.name}
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-faint">
                    <span
                        className={`size-1.5 ${existing > 0 ? "bg-emerald-500" : "bg-line2"}`}
                    />
                    {existing}/{total}
                </span>
                {hasItems &&
                    (open ? (
                        <ChevronDown size={13} className="text-faint" />
                    ) : (
                        <ChevronRight size={13} className="text-faint" />
                    ))}
            </button>
            {open && (
                <ul className="mt-0.5 space-y-0.5 pl-3">
                    {sections.map((section, index) => (
                        <li key={section.name}>
                            <SectionHeader
                                name={section.name}
                                count={
                                    section.files.length +
                                    section.folders.length
                                }
                                first={index === 0}
                            />
                            <ul className="space-y-0.5 border-l border-line bg-app/30 py-1 pl-1">
                                {section.files.map((file) => (
                                    <li key={file.id}>
                                        <FileRow
                                            file={file}
                                            active={file.id === selectedId}
                                            onClick={() => onSelect(tool, file)}
                                        />
                                    </li>
                                ))}
                                {section.folders.map((folder) => (
                                    <li key={folder.id}>
                                        <FolderRow
                                            folder={folder}
                                            isRoot={rootPaths.has(folder.path)}
                                            active={
                                                folder.id === selectedFolderId
                                            }
                                            onClick={() =>
                                                onSelectFolder(tool, folder)
                                            }
                                        />
                                    </li>
                                ))}
                            </ul>
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
                    className="p-2 text-secondary transition-colors hover:bg-raised hover:text-primary"
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
                    className="p-1 text-faint transition-colors hover:bg-raised hover:text-primary"
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
                                className="mb-1 flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] font-semibold tracking-wider text-faint uppercase transition-colors hover:bg-raised"
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
                    className="flex w-full items-center justify-center gap-2 px-3 py-2 text-xs text-secondary transition-colors hover:bg-raised hover:text-primary"
                >
                    <Settings2 size={14} />
                    Manage tools & settings
                </button>
            </div>
        </aside>
    );
}
