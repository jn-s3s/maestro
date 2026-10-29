import { memo, useState, type JSX } from "react";
import {
    BookOpen,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Folder,
    Lock,
    Plug,
    Search,
    Settings2,
    SlidersHorizontal,
    Star,
} from "lucide-react";
import type {
    DiscoveryState,
    Tool,
    ToolFile,
    ToolFolder,
    ToolGroup,
    ToolRoot,
} from "../../../shared/types";
import { filterToolForView, viewEntryCount, type NavView } from "../lib/views";

const GROUP_LABELS: Record<ToolGroup, string> = {
    workspace: "Workspaces",
    cli: "CLI Tools",
    editor: "Editors",
    ext: "VS Code Extensions",
    custom: "Custom",
};

const ORDER: ToolGroup[] = ["workspace", "cli", "editor", "ext", "custom"];

const STATE_LABELS: Record<DiscoveryState, string> = {
    available: "Available",
    missing: "Missing",
    unreadable: "Unreadable. Access is denied.",
    unsupported: "Unsupported. It is a link, a folder or larger than 5 MB.",
};

const STATE_DOT: Record<DiscoveryState, string> = {
    available: "bg-emerald-500",
    missing: "bg-line2",
    unreadable: "bg-amber-500",
    unsupported: "bg-violet-400",
};

function fileState(file: ToolFile): DiscoveryState {
    return file.state ?? (file.exists ? "available" : "missing");
}

const VIEW_BUTTONS = [
    { id: "configs", label: "Configs", icon: SlidersHorizontal },
    { id: "mcp", label: "MCP", icon: Plug },
    { id: "library", label: "Library", icon: BookOpen },
] satisfies { id: NavView; label: string; icon: typeof Plug }[];

const VIEW_TITLES: Record<NavView, string> = {
    configs: "Configurations",
    mcp: "MCP servers",
    library: "Library",
};

interface FavoriteEntry {
    tool: Tool;
    file: ToolFile;
}

/**
 * Filters a tool to the entries matching a query.
 *
 * @param tool - The tool to filter.
 * @param needle - A lower-cased search string, or an empty string.
 * @returns The original tool, a filtered copy, or null when nothing matches.
 */
function filterTool(tool: Tool, needle: string): Tool | null {
    if (!needle) {
        return tool;
    }
    if (tool.name.toLowerCase().includes(needle)) {
        return tool;
    }
    const files = tool.files.filter(
        (file) =>
            file.label.toLowerCase().includes(needle) ||
            file.path.toLowerCase().includes(needle),
    );
    const folders = (tool.folders ?? []).filter(
        (folder) =>
            folder.label.toLowerCase().includes(needle) ||
            folder.path.toLowerCase().includes(needle),
    );
    if (files.length === 0 && folders.length === 0) {
        return null;
    }
    // Roots drive section ordering, so drop them while filtering; the
    // remaining entries still carry their section names.
    return { ...tool, files, folders, roots: [] };
}

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
    const state = fileState(file);
    return (
        <button
            type="button"
            data-file-state={state}
            onClick={onClick}
            className={`flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors ${
                active
                    ? "bg-accentsoft ring-1 ring-accent/30 ring-inset"
                    : "hover:bg-raised"
            }`}
        >
            <span
                title={STATE_LABELS[state]}
                className={`size-1.5 shrink-0 ${STATE_DOT[state]}`}
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
 * Sections that end up empty are dropped, and root folders sort above the
 * rest within their section.
 *
 * @param tool - The tool whose entries are grouped.
 * @returns The non-empty sidebar sections, in display order.
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
        .filter((section) => section.files.length || section.folders.length)
        .map((section) => {
            section.files = section.files.toSorted((a, b) =>
                a.label.localeCompare(b.label),
            );
            section.folders = section.folders.toSorted((a, b) => {
                const aIsRoot = rootPaths.has(a.path);
                const bIsRoot = rootPaths.has(b.path);
                if (aIsRoot !== bIsRoot) {
                    return aIsRoot ? -1 : 1;
                }
                return a.label.localeCompare(b.label);
            });
            return section;
        });
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
        allFiles.filter((file) => fileState(file) === "available").length +
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
    favorites: FavoriteEntry[];
    selectedId: string | null;
    selectedFolderId: string | null;
    onSelect: (tool: Tool, file: ToolFile) => void;
    onSelectFolder: (tool: Tool, folder: ToolFolder) => void;
    onManage: () => void;
    collapsed: boolean;
    onToggle: () => void;
    filter: string;
    onFilterChange: (value: string) => void;
    view: NavView;
    onViewChange: (view: NavView) => void;
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
 * @param view - The active navigation collection.
 * @param onViewChange - Switches the navigation collection.
 */
export default function Sidebar({
    tools,
    favorites,
    selectedId,
    selectedFolderId,
    onSelect,
    onSelectFolder,
    onManage,
    collapsed,
    onToggle,
    filter,
    onFilterChange,
    view,
    onViewChange,
}: Props): JSX.Element {
    const [groupCollapsed, setGroupCollapsed] = useState<
        Record<string, boolean>
    >({});
    const needle = filter.trim().toLowerCase();

    const viewTools = tools
        .map((tool) => filterToolForView(tool, view))
        .filter((tool): tool is Tool => tool !== null);
    const groups = ORDER.map((group) => ({
        group,
        items: viewTools
            .filter((tool) => tool.group === group)
            .map((tool) => filterTool(tool, needle))
            .filter((tool): tool is Tool => tool !== null),
    })).filter(({ items }) => items.length);
    const visibleFavorites =
        view === "configs"
            ? favorites.filter(
                  ({ tool, file }) =>
                      !needle ||
                      file.label.toLowerCase().includes(needle) ||
                      file.path.toLowerCase().includes(needle) ||
                      tool.name.toLowerCase().includes(needle),
              )
            : [];
    const entryCount = viewEntryCount(tools, view);

    const toggle = (key: string): void =>
        setGroupCollapsed((current) => ({
            ...current,
            [key]: !current[key],
        }));

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
            <div className="border-b border-line px-2 py-2">
                <div
                    role="tablist"
                    aria-label="Navigation"
                    className="flex items-center gap-0.5 rounded-lg border border-line bg-app p-0.5"
                >
                    {VIEW_BUTTONS.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={view === id}
                            title={`Show ${VIEW_TITLES[id].toLowerCase()}`}
                            onClick={() => onViewChange(id)}
                            className={`flex flex-1 items-center justify-center gap-1 rounded-md px-1 py-1 text-[10px] font-medium transition-colors ${
                                view === id
                                    ? "bg-raised text-primary"
                                    : "text-faint hover:text-secondary"
                            }`}
                        >
                            <Icon size={11} />
                            {label}
                        </button>
                    ))}
                </div>
            </div>
            <div className="border-b border-line px-3 py-2.5">
                <div className="flex items-center gap-2">
                    <p className="text-[11px] font-medium text-secondary">
                        {VIEW_TITLES[view]}
                    </p>
                    <span className="text-[10px] text-faint">
                        {entryCount} {view === "configs" ? "tools" : "entries"}
                    </span>
                    <button
                        type="button"
                        title="Collapse sidebar"
                        aria-label="Collapse sidebar"
                        aria-expanded={!collapsed}
                        onClick={onToggle}
                        className="ml-auto p-1 text-faint transition-colors hover:bg-raised hover:text-primary"
                    >
                        <ChevronLeft size={14} />
                    </button>
                </div>
                <label className="mt-2 flex items-center gap-1.5 rounded-lg border border-line bg-app px-2 py-1.5 focus-within:border-accent">
                    <Search size={12} className="shrink-0 text-faint" />
                    <input
                        value={filter}
                        onChange={(event) => onFilterChange(event.target.value)}
                        placeholder={
                            view === "configs"
                                ? "Filter configurations"
                                : view === "mcp"
                                  ? "Filter MCP configs"
                                  : "Filter library"
                        }
                        spellCheck={false}
                        className="min-w-0 flex-1 bg-transparent text-[11px] text-primary outline-none placeholder:text-faint"
                    />
                </label>
            </div>

            <nav className="flex-1 overflow-y-auto px-2 py-2">
                {visibleFavorites.length > 0 && (
                    <div className="mb-3">
                        <p className="mb-1 flex items-center gap-1 px-2 py-1 text-[10px] font-semibold tracking-wider text-faint uppercase">
                            <Star size={10} className="text-amber-500" />
                            Favorites
                        </p>
                        <ul className="space-y-0.5">
                            {visibleFavorites.map(({ tool, file }) => (
                                <li key={`favorite-${file.path}`}>
                                    <FileRow
                                        file={file}
                                        active={file.id === selectedId}
                                        onClick={() => onSelect(tool, file)}
                                    />
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {groups.length === 0 && (
                    <p className="px-3 py-6 text-xs leading-relaxed text-faint">
                        {needle
                            ? `No ${
                                  view === "mcp"
                                      ? "MCP configuration"
                                      : view === "library"
                                        ? "library entry"
                                        : "configuration"
                              } matches this filter.`
                            : view === "mcp"
                              ? "No MCP configurations detected yet. Register a workspace with .mcp.json or install an extension that stores MCP settings."
                              : view === "library"
                                ? "No skills, agents, commands or instruction files detected yet."
                                : "No tools detected yet. Config files appear here automatically once their directories exist."}
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
