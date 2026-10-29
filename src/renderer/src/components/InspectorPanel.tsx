import type { JSX } from "react";
import {
    CheckCircle2,
    CircleAlert,
    Clock3,
    FileCog,
    History,
    RotateCcw,
    TriangleAlert,
    X,
} from "lucide-react";
import type { FileLang } from "../../../shared/types";
import { fmtBytes, fmtTime, LANG_LABELS } from "../lib/format";

interface Props {
    label: string;
    path: string;
    toolName: string;
    lang: FileLang;
    exists: boolean;
    dirty: boolean;
    external: boolean;
    size: number;
    mtime: number;
    revision: string | null;
    diagnostics: number;
    warnings: number;
    scope: string;
    backupCount: number | null;
    backupsLoading: boolean;
    onOpenHistory: () => void;
    onReload: () => void;
    onClose: () => void;
}

function Section({
    title,
    children,
}: {
    title: string;
    children: React.ReactNode;
}): JSX.Element {
    return (
        <section className="border-b border-line px-4 py-3">
            <p className="mb-2 text-[10px] font-semibold tracking-wider text-faint uppercase">
                {title}
            </p>
            {children}
        </section>
    );
}

function StateRow({ ok, text }: { ok: boolean; text: string }): JSX.Element {
    return (
        <p className="flex items-center gap-1.5 text-xs">
            {ok ? (
                <CheckCircle2 size={13} className="text-emerald-500" />
            ) : (
                <CircleAlert size={13} className="text-sky-500" />
            )}
            <span className="text-secondary">{text}</span>
        </p>
    );
}

/**
 * Right-hand inspector for the active tab: source, scope, disk state,
 * validation problems and backup availability.
 *
 * @param label - File display name.
 * @param path - Absolute file path.
 * @param toolName - Owning tool name.
 * @param lang - Detected editor language.
 * @param exists - Whether the file exists on disk.
 * @param dirty - Whether the tab has unsaved edits.
 * @param external - Whether the file changed on disk while dirty.
 * @param size - Last known size in bytes.
 * @param mtime - Last known modification time.
 * @param revision - Last loaded or saved revision.
 * @param diagnostics - Number of inline syntax problems.
 * @param warnings - Number of deprecated-setting warnings.
 * @param scope - Workspace or global source label.
 * @param backupCount - Number of stored snapshots, or null while loading.
 * @param backupsLoading - Whether the snapshot count is being fetched.
 * @param onOpenHistory - Opens the backup history modal.
 * @param onReload - Reloads the file from disk.
 * @param onClose - Hides the inspector.
 */
export default function InspectorPanel({
    label,
    path,
    toolName,
    lang,
    exists,
    dirty,
    external,
    size,
    mtime,
    revision,
    diagnostics,
    warnings,
    scope,
    backupCount,
    backupsLoading,
    onOpenHistory,
    onReload,
    onClose,
}: Props): JSX.Element {
    return (
        <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-surface/60">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                <FileCog size={14} className="text-accent" />
                <p className="text-xs font-semibold text-primary">Inspector</p>
                <button
                    type="button"
                    title="Hide inspector"
                    aria-label="Hide inspector"
                    onClick={onClose}
                    className="ml-auto rounded p-1 text-faint transition-colors hover:bg-raised hover:text-primary"
                >
                    <X size={14} />
                </button>
            </div>

            <Section title="Source">
                <p className="truncate text-sm font-medium text-primary">
                    {label}
                </p>
                <p className="mt-0.5 text-xs text-secondary">{toolName}</p>
                <p
                    className="mt-2 wrap-break-word font-mono text-[10px] leading-relaxed text-faint"
                    title={path}
                >
                    {path}
                </p>
                <span className="mt-2 inline-flex rounded-full bg-accentsoft px-2 py-0.5 text-[10px] font-medium text-accent">
                    {scope}
                </span>
            </Section>

            <Section title="State">
                <div className="space-y-1.5">
                    <StateRow
                        ok={!dirty}
                        text={dirty ? "Unsaved edits" : "Saved"}
                    />
                    {external && (
                        <StateRow
                            ok={false}
                            text="Changed on disk since loading"
                        />
                    )}
                    <StateRow
                        ok={exists}
                        text={exists ? "File exists" : "Not created yet"}
                    />
                </div>
                <div className="mt-3 space-y-1 text-[11px] text-faint">
                    <p className="flex items-center gap-1.5">
                        <Clock3 size={11} />
                        {exists ? fmtTime(mtime) : "No file on disk"}
                    </p>
                    <p>
                        {LANG_LABELS[lang] ?? lang} ·{" "}
                        {exists ? fmtBytes(size) : "0 B"}
                    </p>
                    <p className="truncate font-mono" title={revision ?? ""}>
                        revision {revision ? revision.slice(0, 12) : "none"}
                    </p>
                </div>
            </Section>

            <Section title="Validation">
                {diagnostics === 0 && warnings === 0 ? (
                    <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 size={13} />
                        No validation problems
                    </p>
                ) : (
                    <div className="space-y-1">
                        {diagnostics > 0 && (
                            <p className="flex items-center gap-1.5 text-xs text-rose-500">
                                <CircleAlert size={13} />
                                {diagnostics} syntax problem
                                {diagnostics === 1 ? "" : "s"}
                            </p>
                        )}
                        {warnings > 0 && (
                            <p className="flex items-center gap-1.5 text-xs text-amber-500">
                                <TriangleAlert size={13} />
                                {warnings} warning
                                {warnings === 1 ? "" : "s"}
                            </p>
                        )}
                    </div>
                )}
                <p className="mt-1.5 text-[10px] leading-relaxed text-faint">
                    Syntax errors and deprecated settings are highlighted in the
                    editor. JSON and JSONC are also checked before saving.
                </p>
            </Section>

            <Section title="History">
                <p className="text-xs text-secondary">
                    {backupsLoading
                        ? "Loading snapshots..."
                        : backupCount === null
                          ? "Snapshots unavailable"
                          : `${backupCount} snapshot${backupCount === 1 ? "" : "s"} stored`}
                </p>
                <div className="mt-2 flex gap-2">
                    <button
                        type="button"
                        onClick={onOpenHistory}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-secondary transition-colors hover:bg-raised hover:text-primary"
                    >
                        <History size={12} />
                        Open history
                    </button>
                    <button
                        type="button"
                        title="Reload active file"
                        onClick={onReload}
                        className="rounded-lg border border-line px-2.5 py-1.5 text-secondary transition-colors hover:bg-raised hover:text-primary"
                    >
                        <RotateCcw size={12} />
                    </button>
                </div>
            </Section>
        </aside>
    );
}
