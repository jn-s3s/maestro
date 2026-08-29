import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from "react";
import {
    ChevronLeft,
    ExternalLink,
    FolderOpen,
    History,
    RefreshCw,
    RotateCcw,
    Save,
    Trash2,
    TriangleAlert,
    Info,
} from "lucide-react";
import {
    Compartment,
    EditorState,
    Prec,
    type Extension,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { json, jsonLanguage } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { LanguageSupport } from "@codemirror/language";
import type { FileLang } from "../../../shared/types";
import { fmtBytes, fmtTime, LANG_LABELS } from "../lib/format";
import { editorTheme } from "./editor/themes";
import { toml } from "./editor/toml";

/**
 * JSONC support that layers line-comment language data on top of the JSON language.
 *
 * @returns A CodeMirror LanguageSupport for JSONC.
 */
function jsonc(): LanguageSupport {
    return new LanguageSupport(jsonLanguage, [
        jsonLanguage.data.of({
            commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
        }),
    ]);
}

export interface EditorHandle {
    getContent(): string;
}

interface Props {
    lang: FileLang;
    mode: "light" | "dark";
    initialContent: string;
    reloadKey: string;
    onDirty: () => void;
    onSave: () => void;
    unsaved: boolean;
    parentLabel?: string;
    parentPath?: string;
    filePath?: string;
    onBack?: () => void;
    fileExists: boolean;
    fileSecret?: boolean;
    fileNote?: string;
    externalChange?: boolean;
    fileSize?: number;
    fileMtime?: number;
    onHistoryClick?: () => void;
    onReloadClick?: () => void;
    onDelete?: () => void;
}

const iconBtn =
    "rounded-lg p-2 text-secondary transition-colors hover:bg-raised hover:text-primary disabled:pointer-events-none disabled:opacity-30";

function languageFor(lang: FileLang): Extension[] {
    switch (lang) {
        case "json":
            return [json()];
        case "jsonc":
            return [jsonc()];
        case "yaml":
            return [yaml()];
        case "toml":
            return [toml()];
        case "markdown":
            return [markdown()];
        default:
            return [];
    }
}

function themeFor(mode: "light" | "dark"): Extension[] {
    return editorTheme(mode);
}

/**
 * CodeMirror editor with optional folder-style toolbar, banners, and status bar.
 * When selFolderRef is provided, renders a navigation toolbar mirroring FolderView.
 *
 * @param props - Editor config plus optional folder context and action callbacks.
 */
const EditorPane = forwardRef<EditorHandle, Props>((props, ref) => {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [themeComp] = useState(() => new Compartment());
    const saveRef = useRef(props.onSave);

    useEffect(() => {
        saveRef.current = props.onSave;
    }, [props.onSave]);

    const onInternalDirty = useRef(props.onDirty);
    useEffect(() => {
        onInternalDirty.current = props.onDirty;
    }, [props.onDirty]);

    const modeRef = useRef(props.mode);
    useEffect(() => {
        modeRef.current = props.mode;
    }, [props.mode]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: themeComp.reconfigure(themeFor(props.mode)),
        });
    }, [props.mode, themeComp]);

    useEffect(() => {
        if (!hostRef.current) return;
        const view = new EditorView({
            state: EditorState.create({
                doc: props.initialContent,
                extensions: [
                    basicSetup,
                    themeComp.of(themeFor(modeRef.current)),
                    ...languageFor(props.lang),
                    Prec.high(
                        keymap.of([
                            {
                                key: "Mod-s",
                                run: () => {
                                    saveRef.current();
                                    return true;
                                },
                            },
                        ]),
                    ),
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged) onInternalDirty.current();
                    }),
                ],
            }),
            parent: hostRef.current,
        });
        viewRef.current = view;
        return () => {
            view.destroy();
            viewRef.current = null;
        };
    }, [props.reloadKey, props.initialContent, props.lang, themeComp]);

    useImperativeHandle(
        ref,
        () => ({
            getContent: () => viewRef.current?.state.doc.toString() ?? "",
        }),
        [],
    );

    return (
        <div className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2">
                {props.onBack && (
                    <button
                        type="button"
                        title="Go back to folder"
                        onClick={() => props.onBack?.()}
                        className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-raised hover:text-primary"
                    >
                        <ChevronLeft size={15} />
                    </button>
                )}
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-primary">
                        {props.parentLabel ?? ""}
                    </div>
                    <div
                        className="truncate font-mono text-[11px] text-faint"
                        title={props.filePath ?? ""}
                    >
                        {props.filePath ?? ""}
                    </div>
                </div>
                <div className="flex items-center gap-1">
                    {props.onHistoryClick && (
                        <button
                            type="button"
                            title="Backup history"
                            onClick={() => props.onHistoryClick?.()}
                            className={iconBtn}
                        >
                            <History size={15} />
                        </button>
                    )}
                    <button
                        type="button"
                        title="Reveal in Explorer"
                        disabled={!props.fileExists}
                        onClick={() =>
                            props.filePath && window.api.reveal(props.filePath)
                        }
                        className={iconBtn}
                    >
                        <FolderOpen size={15} />
                    </button>
                    <button
                        type="button"
                        title="Open with default editor"
                        disabled={!props.fileExists}
                        onClick={() =>
                            props.filePath &&
                            window.api
                                .openExternal(props.filePath)
                                .then((r) => {
                                    if (!r.ok && r.error) {
                                        /* intentionally swallowed */
                                    }
                                })
                        }
                        className={iconBtn}
                    >
                        <ExternalLink size={15} />
                    </button>
                    <button
                        type="button"
                        title="Reload from disk"
                        disabled={!props.externalChange && !props.unsaved}
                        onClick={() => props.onReloadClick?.()}
                        className={iconBtn}
                    >
                        <RotateCcw size={15} />
                    </button>
                    {props.onDelete && (
                        <button
                            type="button"
                            title="Delete file"
                            onClick={() => props.onDelete?.()}
                            className={`${iconBtn} hover:bg-rose-500/10 hover:text-rose-500`}
                        >
                            <Trash2 size={15} />
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => saveRef.current()}
                        disabled={!props.unsaved}
                        className={`ml-1 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                            props.unsaved
                                ? "bg-accent text-white hover:bg-accent2"
                                : "bg-raised text-faint"
                        }`}
                    >
                        <Save size={13} />
                        Save
                    </button>
                </div>
            </div>

            {/* Banners */}
            {props.fileSecret && (
                <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <TriangleAlert size={13} className="shrink-0" />
                    Contains secrets/tokens - every save creates a local backup
                    that includes them.
                </div>
            )}
            {props.fileNote && (
                <div className="flex items-center gap-2 border-b border-sky-500/20 bg-sky-500/10 px-4 py-1.5 text-xs text-sky-700 dark:text-sky-300">
                    <Info size={13} className="shrink-0" />
                    {props.fileNote}
                </div>
            )}
            {!props.fileExists && (
                <div className="border-b border-line bg-surface/60 px-4 py-1.5 text-xs text-faint">
                    File does not exist yet - Save (Ctrl+S) will create it.
                </div>
            )}
            {props.externalChange && (
                <div className="flex items-center gap-2 border-b border-sky-500/20 bg-sky-500/10 px-4 py-1.5 text-xs text-sky-700 dark:text-sky-300">
                    <RefreshCw size={13} className="shrink-0" />
                    <span>
                        {props.unsaved
                            ? "File changed on disk - reloading will discard your edits."
                            : "File changed on disk."}
                    </span>
                    <button
                        type="button"
                        onClick={() => props.onReloadClick?.()}
                        className="ml-auto rounded px-1.5 py-0.5 font-medium underline underline-offset-2 transition-colors hover:bg-sky-500/15"
                    >
                        Load latest
                    </button>
                </div>
            )}

            {/* Editor */}
            <div
                ref={hostRef}
                className="min-h-0 flex-1 overflow-hidden bg-app"
            />

            {/* Status Bar */}
            <div className="flex items-center gap-4 border-t border-line bg-surface px-4 py-1.5 text-[11px] text-faint">
                <span>{LANG_LABELS[props.lang] ?? props.lang}</span>
                {props.fileExists && (
                    <span>
                        {fmtBytes(props.fileSize || 0)} · modified{" "}
                        {fmtTime(props.fileMtime || 0)}
                    </span>
                )}
                <span
                    className={`ml-auto ${props.unsaved ? "text-amber-500" : ""}`}
                >
                    {props.unsaved ? "unsaved changes" : "saved"}
                </span>
            </div>
        </div>
    );
});

EditorPane.displayName = "EditorPane";

export default EditorPane;
