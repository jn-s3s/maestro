import { useEffect, useMemo, useState, type JSX } from "react";
import { diffLines } from "diff";
import { FileDown, History, Trash2, Undo2, X } from "lucide-react";
import type { BackupEntry, ToolFile } from "../../../shared/types";
import { useToast } from "./useToast";
import ConfirmDialog from "./ConfirmDialog";
import { fmtBytes } from "../lib/format";

const MAX_DIFF_LINES = 5000;

interface Props {
    file: ToolFile;
    getCurrent: () => string;
    onLoadIntoEditor: (content: string) => void;
    onRestored: () => void;
    onClose: () => void;
}

interface DiffLine {
    t: "add" | "del" | "ctx";
    s: string;
}

/**
 * Modal that diffs, restores and deletes backup history for a file.
 *
 * @param file - The file being inspected.
 * @param getCurrent - Returns the current editor content.
 * @param onLoadIntoEditor - Loads chosen backup content into the editor.
 * @param onRestored - Fires after a restore completes.
 * @param onClose - Closes the modal.
 */
export default function HistoryModal({
    file,
    getCurrent,
    onLoadIntoEditor,
    onRestored,
    onClose,
}: Props): JSX.Element {
    const toast = useToast();
    const [entries, setEntries] = useState<BackupEntry[]>([]);
    const [selected, setSelected] = useState<BackupEntry | null>(null);
    const [content, setContent] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);
    const [reference, setReference] = useState<string | null>(null);

    useEffect(() => {
        void window.api
            .listBackups(file.path)
            .then((r) => setEntries(r.entries))
            .catch((err) =>
                toast.error(err instanceof Error ? err.message : String(err)),
            );
    }, [file.path, toast]);

    const lines: DiffLine[] = useMemo(() => {
        if (content == null || reference == null) return [];
        // Normalize line endings so CRLF vs LF doesn't appear as a diff.
        // Added lines are the newer text; removed lines are what this backup replaced.
        const normalize = (s: string): string => s.replace(/\r\n?/g, "\n");
        const older = normalize(content);
        const newer = normalize(reference);
        const out: DiffLine[] = [];
        for (const part of diffLines(older, newer)) {
            const kind: DiffLine["t"] = part.added
                ? "add"
                : part.removed
                  ? "del"
                  : "ctx";
            const ls = part.value.split("\n");
            if (ls.length > 0 && ls[ls.length - 1] === "") ls.pop();
            for (const s of ls) out.push({ t: kind, s: s.replace(/\r$/, "") });
        }
        return out;
    }, [content, reference]);

    const visible = lines.slice(0, MAX_DIFF_LINES);

    const pickEntry = async (entry: BackupEntry): Promise<void> => {
        setSelected(entry);
        setContent(null);
        setReference(null);
        try {
            const r = await window.api.readBackup(entry.path);
            setContent(r.content);
            // Compare against the next-newer backup, or the live editor when none.
            const idx = entries.findIndex((e) => e.path === entry.path);
            const next = idx > 0 ? entries[idx - 1] : null;
            const nextContent = next
                ? (await window.api.readBackup(next.path)).content
                : getCurrent();
            setReference(nextContent);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const removeBackup = async (entry: BackupEntry): Promise<void> => {
        try {
            await window.api.deleteBackup(entry.path);
            setEntries((prev) => prev.filter((e) => e.path !== entry.path));
            if (selected?.path === entry.path) {
                setSelected(null);
                setContent(null);
            }
            toast.info("Backup deleted");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const clearAll = async (): Promise<void> => {
        setConfirmClear(false);
        try {
            await window.api.clearBackups(file.path);
            setEntries([]);
            setSelected(null);
            setContent(null);
            toast.info("Backup history cleared");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const restore = async (): Promise<void> => {
        if (content == null || busy) return;
        setBusy(true);
        try {
            const res = await window.api.writeFile(file.path, content);
            if (res.ok) {
                toast.success("Restored from backup");
                onRestored();
                onClose();
            } else {
                toast.error(res.error);
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <div
                className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm"
                onMouseDown={onClose}
            >
                <div
                    className="flex h-[80vh] w-240 max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
                        <History size={15} className="text-accent" />
                        <h2 className="text-sm font-semibold text-primary">
                            Backup history
                        </h2>
                        <span
                            className="truncate font-mono text-[11px] text-faint"
                            title={file.path}
                        >
                            {file.label}
                        </span>
                        {entries.length > 0 && (
                            <button
                                type="button"
                                title="Delete all backups for this file"
                                onClick={() => setConfirmClear(true)}
                                className="ml-auto rounded-lg p-1.5 text-faint transition-colors hover:bg-rose-500/10 hover:text-rose-500"
                            >
                                <Trash2 size={14} />
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onClose}
                            className={`${entries.length > 0 ? "" : "ml-auto"} rounded-lg p-1 text-faint transition-colors hover:bg-raised hover:text-primary`}
                        >
                            <X size={16} />
                        </button>
                    </div>

                    <div className="flex min-h-0 flex-1">
                        <div className="w-72 shrink-0 overflow-y-auto border-r border-line p-2">
                            {entries.length === 0 && (
                                <p className="px-3 py-6 text-xs leading-relaxed text-faint">
                                    No backups yet. One is created automatically
                                    every time this file is saved over an
                                    existing version.
                                </p>
                            )}
                            {entries.map((entry) => (
                                <div
                                    key={entry.path}
                                    className="group relative"
                                >
                                    <button
                                        type="button"
                                        onClick={() => void pickEntry(entry)}
                                        className={`flex w-full flex-col items-start rounded-lg px-3 py-2 pr-8 text-left transition-colors ${
                                            selected?.path === entry.path
                                                ? "bg-accentsoft"
                                                : "hover:bg-raised"
                                        }`}
                                    >
                                        <span
                                            className={`text-xs ${selected?.path === entry.path ? "font-medium text-primary" : "text-secondary"}`}
                                        >
                                            {new Intl.DateTimeFormat(
                                                undefined,
                                                {
                                                    dateStyle: "medium",
                                                    timeStyle: "medium",
                                                },
                                            ).format(new Date(entry.mtime))}
                                        </span>
                                        <span className="text-[10px] text-faint">
                                            {fmtBytes(entry.size)}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        title="Delete backup"
                                        onClick={() => void removeBackup(entry)}
                                        className="absolute top-2 right-2 rounded-md p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-rose-500/10 hover:text-rose-500"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            ))}
                        </div>

                        <div className="flex min-w-0 flex-1 flex-col">
                            {!selected ? (
                                <div className="grid flex-1 place-items-center text-xs text-faint">
                                    Select a backup to compare it with the
                                    current file
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-center gap-2 border-b border-line px-4 py-2">
                                        <span className="text-[11px] text-faint">
                                            diff vs next version{" "}
                                            {lines.length > MAX_DIFF_LINES
                                                ? `${MAX_DIFF_LINES} of ${lines.length} lines`
                                                : `${lines.length} lines`}
                                        </span>
                                        <div className="ml-auto flex items-center gap-2">
                                            <button
                                                type="button"
                                                disabled={content == null}
                                                onClick={() =>
                                                    content != null &&
                                                    onLoadIntoEditor(content)
                                                }
                                                className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-secondary transition-colors hover:bg-raised hover:text-primary disabled:pointer-events-none disabled:opacity-40"
                                            >
                                                <FileDown size={13} />
                                                Load into editor
                                            </button>
                                            <button
                                                type="button"
                                                disabled={
                                                    content == null || busy
                                                }
                                                onClick={() => void restore()}
                                                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent2 disabled:pointer-events-none disabled:opacity-40"
                                            >
                                                <Undo2 size={13} />
                                                Restore
                                            </button>
                                        </div>
                                    </div>

                                    <div className="min-h-0 flex-1 overflow-auto bg-app p-2 font-mono text-xs leading-5">
                                        {content == null ? (
                                            <p className="p-3 text-sans text-faint">
                                                Loading...
                                            </p>
                                        ) : visible.length === 0 ? (
                                            <p className="p-3 text-sans text-faint">
                                                Identical to the next version.
                                            </p>
                                        ) : (
                                            visible.map((l, i) => (
                                                <div
                                                    key={i}
                                                    className={
                                                        l.t === "add"
                                                            ? "bg-emerald-500/10 px-2 text-emerald-700 dark:text-emerald-300"
                                                            : l.t === "del"
                                                              ? "bg-rose-500/10 px-2 text-rose-700 dark:text-rose-300"
                                                              : "px-2 text-faint"
                                                    }
                                                >
                                                    <span className="mr-2 inline-block w-3 shrink-0 select-none opacity-70">
                                                        {l.t === "add"
                                                            ? "+"
                                                            : l.t === "del"
                                                              ? "-"
                                                              : ""}
                                                    </span>
                                                    <span className="whitespace-pre-wrap break-all">
                                                        {l.s}
                                                    </span>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            {confirmClear && (
                <ConfirmDialog
                    title="Delete all backups"
                    message={`Delete ALL ${entries.length} backups for "${file.label}"? This cannot be undone.`}
                    confirmLabel="Delete all"
                    onConfirm={() => void clearAll()}
                    onCancel={() => setConfirmClear(false)}
                />
            )}
        </>
    );
}
