import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import {
    ChevronLeft,
    ChevronRight,
    FileText,
    Folder,
    Plus,
    RefreshCw,
    Trash2,
} from "lucide-react";
import type { DirEntry, ToolFile, ToolFolder } from "../../../shared/types";
import { useToast } from "./useToast";
import ConfirmDialog from "./ConfirmDialog";
import { fmtBytes, fmtTime, langFromPath } from "../lib/format";

interface Props {
    folder: ToolFolder;
    reloadKey?: number;
    initialDir?: string;
    onOpenFile: (file: ToolFile, dir: string) => void;
    onMutated?: () => void;
    onDeleted?: () => void;
}

/**
 * Drill-down file browser for a registered tool folder.
 *
 * Shows the direct children of the current directory only. Clicking a folder
 * navigates into it and the new-file box creates files in the current directory.
 *
 * @param folder - The registered folder to browse.
 * @param reloadKey - Value that triggers a fresh listing when it changes.
 * @param initialDir - Relative directory to start in, used when returning from a file.
 * @param onOpenFile - Callback when a file entry is opened, with the open directory.
 * @param onMutated - Optional callback after a create or delete.
 * @param onDeleted - Optional callback when the folder itself is deleted.
 */
const parentHistory = (dir: string): string[] => {
    const segments = dir.split("/");
    return segments.map((_, i) => segments.slice(0, i).join("/"));
};

export default function FolderView({
    folder,
    reloadKey = 0,
    initialDir = "",
    onOpenFile,
    onMutated,
    onDeleted,
}: Props): JSX.Element {
    const toast = useToast();
    const [entries, setEntries] = useState<DirEntry[] | null>(null);
    const [dirExists, setDirExists] = useState(false);
    const [cwdRel, setCwdRel] = useState(initialDir);
    const [history, setHistory] = useState<string[]>(() =>
        parentHistory(initialDir),
    );
    const [name, setName] = useState("");
    const [pendingDelete, setPendingDelete] = useState<DirEntry | null>(null);
    const [confirmFolderDelete, setConfirmFolderDelete] = useState(false);
    const requestRef = useRef(0);

    const cwdPath = useMemo(
        () => (cwdRel ? `${folder.path}/${cwdRel}` : folder.path),
        [folder.path, cwdRel],
    );

    const load = useCallback(
        (dirPath: string) => {
            const id = ++requestRef.current;
            void window.api
                .listFolder(dirPath)
                .then((r) => {
                    if (id !== requestRef.current) return;
                    setEntries(r.entries);
                    setDirExists(r.exists);
                })
                .catch((err) => {
                    if (id !== requestRef.current) return;
                    toast.error(
                        err instanceof Error ? err.message : String(err),
                    );
                });
        },
        [toast],
    );

    useEffect(() => {
        load(cwdPath);
    }, [load, cwdPath, reloadKey]);

    const displayName = useMemo(
        () =>
            cwdRel
                ? cwdRel.split(/[\\/]/).pop()! || folder.label
                : folder.label,
        [cwdRel, folder.label],
    );

    const open = (entry: DirEntry): void => {
        const rel = cwdRel ? `${cwdRel}/${entry.name}` : entry.name;
        const parentLabel = displayName;
        const file: ToolFile = {
            id: `${folder.id}/${rel}`,
            label: entry.name,
            path: entry.path,
            parentPath: cwdPath,
            parentLabel,
            exists: true,
            lang: langFromPath(entry.path),
        };
        onOpenFile(file, cwdRel);
    };

    const enter = (entry: DirEntry): void => {
        const nextRel = cwdRel ? `${cwdRel}/${entry.name}` : entry.name;
        setEntries(null);
        setHistory((prev) => [...prev, cwdRel]);
        setCwdRel(nextRel);
    };

    const goBack = (): void => {
        const prevRel = history[history.length - 1] ?? "";
        setEntries(null);
        setHistory((prev) => prev.slice(0, -1));
        setCwdRel(prevRel);
    };

    const create = async (): Promise<void> => {
        const trimmed = name.trim();
        if (!trimmed) return;
        try {
            const res = await window.api.createFileIn(cwdPath, trimmed);
            if (!res.ok) {
                toast.error(res.error ?? "Failed to create file");
                return;
            }
            setName("");
            toast.success(`Created ${trimmed}`);
            load(cwdPath);
            onMutated?.();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const performDelete = async (): Promise<void> => {
        const entry = pendingDelete;
        setPendingDelete(null);
        if (!entry) return;
        try {
            const res = await window.api.deleteFile(entry.path);
            if (res.ok) {
                toast.info(`Deleted ${entry.name}`);
                load(cwdPath);
                onMutated?.();
            } else {
                toast.error(res.error ?? "Failed to delete");
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const performFolderDelete = async (): Promise<void> => {
        setConfirmFolderDelete(false);
        try {
            const res = await window.api.deleteFolder(cwdPath);
            if (res.ok) {
                toast.info(`Deleted ${displayName}`);
                onMutated?.();
                if (cwdRel) {
                    goBack();
                } else {
                    onDeleted?.();
                }
            } else {
                toast.error(res.error ?? "Failed to delete folder");
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-line bg-surface">
                <button
                    type="button"
                    title="Go back"
                    onClick={goBack}
                    disabled={!cwdRel}
                    className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-raised hover:text-primary disabled:pointer-events-none disabled:opacity-30"
                >
                    <ChevronLeft size={15} />
                </button>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-primary">
                        {displayName}
                    </div>
                    {cwdRel ? (
                        <div
                            className="truncate font-mono text-[11px] text-faint"
                            title={`${folder.path}\\${cwdRel.replaceAll("/", "\\")}`}
                        >
                            / {cwdRel}
                        </div>
                    ) : (
                        <div
                            className="truncate font-mono text-[11px] text-faint"
                            title={folder.path}
                        >
                            {folder.path}
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    title="Reveal folder in Explorer"
                    onClick={() => void window.api.reveal(cwdPath)}
                    className="rounded-lg p-2 text-secondary transition-colors hover:bg-raised hover:text-primary"
                >
                    <Folder size={15} />
                </button>
                <button
                    type="button"
                    title="Refresh"
                    onClick={() => load(cwdPath)}
                    className="rounded-lg p-2 text-secondary transition-colors hover:bg-raised hover:text-primary"
                >
                    <RefreshCw size={15} />
                </button>
                {cwdRel && (
                    <button
                        type="button"
                        title="Delete this folder"
                        onClick={() => setConfirmFolderDelete(true)}
                        className="rounded-lg p-2 text-secondary transition-colors hover:bg-rose-500/10 hover:text-rose-500"
                    >
                        <Trash2 size={15} />
                    </button>
                )}
            </div>

            {!dirExists && (
                <div className="border-b border-line bg-surface/60 px-4 py-1.5 text-xs text-faint">
                    Folder does not exist yet - creating a file below will
                    create it.
                </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {entries === null ? (
                    <p className="text-xs text-faint">Loading…</p>
                ) : entries.length === 0 ? (
                    <p className="text-xs leading-relaxed text-faint">
                        Nothing here yet. Create your first file below (e.g.
                        code-review.md).
                    </p>
                ) : (
                    <ul className="space-y-1">
                        {entries.map((entry) =>
                            entry.isDir ? (
                                <li key={entry.path}>
                                    <button
                                        type="button"
                                        onClick={() => enter(entry)}
                                        title={entry.path}
                                        className="group flex w-full items-center gap-3 rounded-xl px-3 py-2 text-faint transition-colors hover:bg-surface hover:text-primary"
                                    >
                                        <Folder
                                            size={14}
                                            className="shrink-0 text-accent"
                                        />
                                        <span className="min-w-0 flex-1 truncate text-left font-mono text-xs">
                                            {entry.name}
                                        </span>
                                        <ChevronRight
                                            size={14}
                                            className="shrink-0 text-faint transition-colors group-hover:text-secondary"
                                        />
                                    </button>
                                </li>
                            ) : (
                                <li
                                    key={entry.path}
                                    className="group flex items-stretch rounded-xl border border-transparent transition-colors hover:border-line hover:bg-surface"
                                >
                                    <button
                                        type="button"
                                        onClick={() => open(entry)}
                                        title={entry.path}
                                        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left text-faint transition-colors hover:text-primary"
                                    >
                                        <FileText
                                            size={14}
                                            className="shrink-0 text-accent"
                                        />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-mono text-xs text-primary group-hover:text-accent">
                                                {entry.name}
                                            </span>
                                            <span className="block text-[10px] text-faint">
                                                {fmtBytes(entry.size)} ·
                                                modified {fmtTime(entry.mtime)}
                                            </span>
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        title="Delete file"
                                        onClick={() => setPendingDelete(entry)}
                                        className="my-auto mr-2 rounded-lg p-1.5 text-faint opacity-0 transition-all hover:bg-rose-500/10 hover:text-rose-500 group-hover:opacity-100"
                                    >
                                        <Trash2 size={13} />
                                    </button>
                                </li>
                            ),
                        )}
                    </ul>
                )}
            </div>

            <div className="border-t border-line bg-surface px-4 py-3">
                <label className="mb-1.5 block text-xs font-medium text-secondary">
                    New file in {folder.label}
                    {cwdRel ? ` / ${cwdRel}` : ""}
                </label>
                <div className="flex gap-2">
                    <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void create();
                        }}
                        placeholder={
                            folder.label.toLowerCase() === "commands"
                                ? "code-review.md"
                                : "my-file.md"
                        }
                        spellCheck={false}
                        className="min-w-0 flex-1 rounded-xl px-3 py-2 font-mono text-xs text-primary border border-line bg-app outline-none transition-colors placeholder:text-faint focus:border-accent"
                    />
                    <button
                        type="button"
                        onClick={() => void create()}
                        disabled={!name.trim()}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-medium text-white bg-accent transition-colors hover:bg-accent2 disabled:pointer-events-none disabled:opacity-40"
                    >
                        <Plus size={13} />
                        Create
                    </button>
                </div>
            </div>

            {pendingDelete && (
                <ConfirmDialog
                    title="Delete file"
                    message={`Delete "${pendingDelete.name}"? Its backup history will be removed too. This cannot be undone.`}
                    onConfirm={() => void performDelete()}
                    onCancel={() => setPendingDelete(null)}
                />
            )}
            {confirmFolderDelete && (
                <ConfirmDialog
                    title="Delete folder"
                    message={`Delete "${displayName}" and everything inside it? Its backup history will be removed too. This cannot be undone.`}
                    onConfirm={() => void performFolderDelete()}
                    onCancel={() => setConfirmFolderDelete(false)}
                />
            )}
        </div>
    );
}
