import { useMemo, type JSX } from "react";
import { diffLines } from "diff";
import { RefreshCw, Save, TriangleAlert, X } from "lucide-react";

const MAX_LINES = 4000;

interface Segment {
    change: "add" | "del" | "ctx";
    text: string;
}

interface Props {
    label: string;
    base: string;
    mine: string;
    disk: string;
    busy: boolean;
    onReload: () => void;
    onOverwrite: () => void;
    onClose: () => void;
}

/**
 * Normalizes CRLF and CR line endings so diffs only show real changes.
 *
 * @param text - The text to normalize.
 * @returns Text with LF line endings.
 */
function normalize(text: string): string {
    return text.replace(/\r\n?/g, "\n");
}

/**
 * Splits two versions into display segments, normalizing line endings.
 *
 * @param older - The version loaded from disk.
 * @param newer - The version to compare against it.
 * @returns The diff segments, capped by the caller.
 */
function segments(older: string, newer: string): Segment[] {
    const out: Segment[] = [];
    for (const part of diffLines(normalize(older), normalize(newer))) {
        const change: Segment["change"] = part.added
            ? "add"
            : part.removed
              ? "del"
              : "ctx";
        const lines = part.value.split("\n");
        if (lines.length && lines[lines.length - 1] === "") {
            lines.pop();
        }
        for (const line of lines) {
            out.push({ change, text: line.replace(/\r$/, "") });
        }
    }
    return out;
}

function DiffColumn({
    title,
    hint,
    lines,
}: {
    title: string;
    hint: string;
    lines: Segment[];
}): JSX.Element {
    return (
        <div className="flex min-w-0 flex-1 flex-col border-r border-line last:border-r-0">
            <div className="border-b border-line bg-surface px-3 py-2">
                <p className="text-xs font-medium text-primary">{title}</p>
                <p className="text-[10px] text-faint">{hint}</p>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-app py-1 font-mono text-[11px] leading-5">
                {lines.length === 0 ? (
                    <p className="px-3 py-2 text-sans text-faint">Empty file</p>
                ) : (
                    lines.map((line, index) => (
                        <div
                            key={index}
                            className={
                                line.change === "add"
                                    ? "bg-emerald-500/10 px-2 text-emerald-700 dark:text-emerald-300"
                                    : line.change === "del"
                                      ? "bg-rose-500/10 px-2 text-rose-700 line-through decoration-rose-400/40 dark:text-rose-300"
                                      : "px-2 text-secondary"
                            }
                        >
                            <span className="mr-2 inline-block w-2 shrink-0 select-none text-faint">
                                {line.change === "add"
                                    ? "+"
                                    : line.change === "del"
                                      ? "-"
                                      : ""}
                            </span>
                            <span className="whitespace-pre-wrap break-all">
                                {line.text || "\u00a0"}
                            </span>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

/**
 * Three-way conflict resolution: the loaded version, the user's edits and the
 * current disk version are shown side by side before either side wins.
 *
 * @param label - File label shown in the heading.
 * @param base - Content loaded when the tab was opened.
 * @param mine - Current editor content.
 * @param disk - Current file content on disk.
 * @param busy - Whether a resolution write is running.
 * @param onReload - Discards the user's edits in favor of the disk file.
 * @param onOverwrite - Saves the user's edits over the disk file.
 * @param onClose - Keeps the conflict open without resolving it.
 */
export default function ConflictDialog({
    label,
    base,
    mine,
    disk,
    busy,
    onReload,
    onOverwrite,
    onClose,
}: Props): JSX.Element {
    const baseLines = useMemo<Segment[]>(() => {
        const lines = normalize(base).split("\n");
        if (lines.length && lines[lines.length - 1] === "") {
            lines.pop();
        }
        return lines.map((text) => ({ change: "ctx", text }));
    }, [base]);
    const mineLines = useMemo(
        () => segments(base, mine).slice(0, MAX_LINES),
        [base, mine],
    );
    const diskLines = useMemo(
        () => segments(base, disk).slice(0, MAX_LINES),
        [base, disk],
    );

    return (
        <div className="fixed inset-0 z-60 grid place-items-center bg-black/55 p-4 backdrop-blur-sm">
            <div className="flex h-[82vh] w-[min(1280px,96vw)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
                <div className="flex items-start gap-3 border-b border-line px-5 py-3.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-500">
                        <TriangleAlert size={17} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-semibold text-primary">
                            File changed on disk
                        </h2>
                        <p className="mt-0.5 truncate text-xs text-faint">
                            {label} was modified after you loaded it. Compare
                            the versions and choose one.
                        </p>
                    </div>
                    <button
                        type="button"
                        title="Keep editing without resolving"
                        onClick={onClose}
                        className="rounded-lg p-1 text-faint transition-colors hover:bg-raised hover:text-primary"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="flex min-h-0 flex-1">
                    <DiffColumn
                        title="Loaded version"
                        hint="What you started from"
                        lines={baseLines.slice(0, MAX_LINES)}
                    />
                    <DiffColumn
                        title="Your edits"
                        hint={`${mineLines.length} lines · not saved`}
                        lines={mineLines}
                    />
                    <DiffColumn
                        title="On disk"
                        hint={`${diskLines.length} lines · changed elsewhere`}
                        lines={diskLines}
                    />
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
                    <p className="mr-auto text-[11px] text-faint">
                        Nothing is written until you choose a version.
                    </p>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onReload}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3.5 py-2 text-xs text-secondary transition-colors hover:bg-raised hover:text-primary disabled:pointer-events-none disabled:opacity-40"
                    >
                        <RefreshCw size={13} />
                        Reload disk version
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onOverwrite}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-accent2 disabled:pointer-events-none disabled:opacity-40"
                    >
                        <Save size={13} />
                        Save my version
                    </button>
                </div>
            </div>
        </div>
    );
}
