import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { FileText, Loader2, Search, TerminalSquare } from "lucide-react";
import type { SearchHit, Tool, ToolFile } from "../../../shared/types";

export interface PaletteCommand {
    id: string;
    label: string;
    hint?: string;
    run: () => void;
}

interface FileEntry {
    tool: Tool;
    file: ToolFile;
}

interface Props {
    files: FileEntry[];
    commands: PaletteCommand[];
    searchEnabled: boolean;
    onOpenFile: (tool: Tool, file: ToolFile, line?: number) => void;
    onClose: () => void;
}

interface CommandItem {
    kind: "command";
    id: string;
    label: string;
    hint?: string;
    run: () => void;
}

interface FileItem {
    kind: "file";
    id: string;
    label: string;
    hint: string;
    tool: Tool;
    file: ToolFile;
}

interface HitItem {
    kind: "hit";
    id: string;
    label: string;
    hint: string;
    path: string;
    line: number;
}

type Item = CommandItem | FileItem | HitItem;

const MAX_FILES = 40;
const MAX_HITS = 30;

/**
 * Keyboard-driven command palette that switches files, runs editor commands
 * and searches registered configuration content.
 *
 * @param files - Every registered file, used for name filtering.
 * @param commands - Actions offered when the query is empty.
 * @param searchEnabled - Whether the backend supports content search.
 * @param onOpenFile - Opens a file, optionally revealing a line.
 * @param onClose - Closes the palette.
 */
export default function CommandPalette({
    files,
    commands,
    searchEnabled,
    onOpenFile,
    onClose,
}: Props): JSX.Element {
    const [query, setQuery] = useState("");
    const [hits, setHits] = useState<SearchHit[]>([]);
    const [searching, setSearching] = useState(false);
    const [index, setIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const previousFocus =
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
        inputRef.current?.focus();
        return () => previousFocus?.focus();
    }, []);

    useEffect(() => {
        const trimmed = query.trim();
        if (!searchEnabled || trimmed.length < 2) {
            setHits([]);
            setSearching(false);
            return;
        }
        let alive = true;
        setSearching(true);
        const timer = window.setTimeout(() => {
            void window.api
                .searchFiles?.(trimmed, MAX_HITS)
                .then((result) => {
                    if (alive) {
                        setHits(result.hits);
                    }
                })
                .catch(() => {
                    if (alive) {
                        setHits([]);
                    }
                })
                .finally(() => {
                    if (alive) {
                        setSearching(false);
                    }
                });
        }, 220);
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [query, searchEnabled]);

    const items = useMemo<Item[]>(() => {
        const needle = query.trim().toLowerCase();
        const commandItems: CommandItem[] = commands
            .filter(
                (command) =>
                    !needle || command.label.toLowerCase().includes(needle),
            )
            .slice(0, 10)
            .map((command) => ({
                kind: "command",
                id: `command:${command.id}`,
                label: command.label,
                hint: command.hint,
                run: command.run,
            }));
        const fileItems: FileItem[] = files
            .filter(
                ({ tool, file }) =>
                    !needle ||
                    file.label.toLowerCase().includes(needle) ||
                    file.path.toLowerCase().includes(needle) ||
                    tool.name.toLowerCase().includes(needle),
            )
            .slice(0, MAX_FILES)
            .map(({ tool, file }) => ({
                kind: "file",
                id: `file:${file.path}`,
                label: file.label,
                hint: `${tool.name} · ${file.path}`,
                tool,
                file,
            }));
        const hitItems: HitItem[] = hits.slice(0, MAX_HITS).map((hit) => ({
            kind: "hit",
            id: `hit:${hit.path}:${hit.line}:${hit.preview}`,
            label: hit.preview || hit.label,
            hint: `${hit.label} · line ${hit.line}`,
            path: hit.path,
            line: hit.line,
        }));
        return [...commandItems, ...fileItems, ...hitItems];
    }, [commands, files, hits, query]);

    useEffect(() => {
        setIndex(0);
    }, [query]);

    useEffect(() => {
        if (index >= items.length) {
            setIndex(Math.max(items.length - 1, 0));
        }
    }, [index, items.length]);

    useEffect(() => {
        listRef.current
            ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
            ?.scrollIntoView({ block: "nearest" });
    }, [index]);

    const run = (item: Item | undefined): void => {
        if (!item) {
            return;
        }
        if (item.kind === "command") {
            onClose();
            item.run();
            return;
        }
        if (item.kind === "file") {
            onClose();
            onOpenFile(item.tool, item.file);
            return;
        }
        const target = files.find(
            (entry) =>
                entry.file.path.toLowerCase() === item.path.toLowerCase(),
        );
        if (target) {
            onClose();
            onOpenFile(target.tool, target.file, item.line);
        }
    };

    let lastKind: Item["kind"] | null = null;
    const sectionLabel: Record<Item["kind"], string> = {
        command: "Commands",
        file: "Files",
        hit: "Content matches",
    };

    return (
        <div
            className="fixed inset-0 z-70 flex justify-center bg-black/45 px-4 pt-24 backdrop-blur-sm"
            onMouseDown={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label="Command palette"
                className="flex max-h-[65vh] w-160 max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
                onMouseDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                    if (event.key === "Tab") {
                        event.preventDefault();
                        inputRef.current?.focus();
                    }
                }}
            >
                <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                    <Search size={15} className="shrink-0 text-faint" />
                    <input
                        ref={inputRef}
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded={items.length > 0}
                        aria-controls="command-palette-options"
                        aria-activedescendant={
                            items[index]
                                ? `command-palette-option-${index}`
                                : undefined
                        }
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                onClose();
                            } else if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setIndex((current) =>
                                    Math.min(current + 1, items.length - 1),
                                );
                            } else if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setIndex((current) => Math.max(current - 1, 0));
                            } else if (event.key === "Enter") {
                                event.preventDefault();
                                run(items[index]);
                            }
                        }}
                        placeholder="Search files and content, or run a command"
                        spellCheck={false}
                        className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-faint"
                    />
                    {searching && (
                        <Loader2
                            size={14}
                            className="animate-spin text-faint"
                        />
                    )}
                    <kbd className="rounded border border-line px-1.5 py-0.5 text-[10px] text-faint">
                        Esc
                    </kbd>
                </div>

                <div
                    ref={listRef}
                    id="command-palette-options"
                    role="listbox"
                    className="min-h-0 flex-1 overflow-y-auto p-2"
                >
                    {items.length === 0 && (
                        <p className="px-3 py-6 text-xs text-faint">
                            {searchEnabled
                                ? "No matching files, content or commands."
                                : "No matching files or commands."}
                        </p>
                    )}
                    {items.map((item, itemIndex) => {
                        const header =
                            item.kind !== lastKind
                                ? sectionLabel[item.kind]
                                : null;
                        lastKind = item.kind;
                        const selected = itemIndex === index;
                        return (
                            <div key={item.id}>
                                {header && (
                                    <p className="mt-2 mb-1 px-3 text-[10px] font-semibold tracking-wider text-faint uppercase">
                                        {header}
                                    </p>
                                )}
                                <button
                                    type="button"
                                    id={`command-palette-option-${itemIndex}`}
                                    role="option"
                                    aria-selected={selected}
                                    data-index={itemIndex}
                                    onMouseEnter={() => setIndex(itemIndex)}
                                    onClick={() => run(item)}
                                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                                        selected
                                            ? "bg-accentsoft"
                                            : "hover:bg-raised"
                                    }`}
                                >
                                    {item.kind === "command" ? (
                                        <TerminalSquare
                                            size={14}
                                            className="shrink-0 text-accent"
                                        />
                                    ) : (
                                        <FileText
                                            size={14}
                                            className="shrink-0 text-faint"
                                        />
                                    )}
                                    <span className="min-w-0 flex-1">
                                        <span
                                            className={`block truncate text-xs ${
                                                selected
                                                    ? "font-medium text-primary"
                                                    : "text-secondary"
                                            }`}
                                        >
                                            {item.label}
                                        </span>
                                        {item.hint && (
                                            <span className="block truncate text-[10px] text-faint">
                                                {item.hint}
                                            </span>
                                        )}
                                    </span>
                                </button>
                            </div>
                        );
                    })}
                </div>

                <div className="border-t border-line px-4 py-2 text-[10px] text-faint">
                    {searchEnabled
                        ? "Content search covers registered files. Sensitive and .env files are excluded."
                        : "Content search requires the Tauri build."}
                </div>
            </div>
        </div>
    );
}
