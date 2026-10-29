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
    Loader2,
    RefreshCw,
    RotateCcw,
    Save,
    Star,
    Trash2,
    TriangleAlert,
    Info,
    Wand,
} from "lucide-react";
import {
    Compartment,
    EditorState,
    Prec,
    type Extension,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import {
    autocompletion,
    type Completion,
    type CompletionContext,
    type CompletionResult,
} from "@codemirror/autocomplete";
import { basicSetup } from "codemirror";
import { json } from "@codemirror/lang-json";
import { jsonc } from "@shopify/lang-jsonc";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import type {
    ConfigWarning,
    FileLang,
    SchemaKey,
    SchemaScope,
} from "../../../shared/types";
import { fmtBytes, fmtTime, LANG_LABELS } from "../lib/format";
import { editorTheme } from "./editor/themes";
import { toml } from "./editor/toml";
import { useToast } from "./useToast";

export interface EditorHandle {
    getContent(): string;
    applyEdit(content: string): void;
    revealLine(line: number): void;
}

export interface DiagnosticSummary {
    errors: number;
    warnings: number;
}

interface Props {
    lang: FileLang;
    mode: "light" | "dark";
    softWrap: boolean;
    initialContent: string;
    reloadKey: string;
    onDirty: () => void;
    onSave: () => void;
    onFormat?: () => void;
    formatting?: boolean;
    onChange?: (content: string) => void;
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
    isFavorite?: boolean;
    onToggleFavorite?: () => void;
    onDiagnostics?: (summary: DiagnosticSummary) => void;
    restartHint?: boolean;
    schemaKeys?: SchemaKey[];
    checkAdvice?: (content: string) => Promise<ConfigWarning[]>;
}

const iconBtn =
    "rounded-lg p-2 text-secondary transition-colors hover:bg-raised hover:text-primary disabled:pointer-events-none disabled:opacity-30";

/**
 * Picks the CodeMirror language extensions for a detected file language.
 *
 * @param lang - The language resolved from the file path.
 * @returns The language extensions, empty when no mode is available.
 */
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
        case "javascript":
            return [javascript({ jsx: true })];
        case "typescript":
            return [javascript({ jsx: true, typescript: true })];
        case "python":
            return [python()];
        default:
            return [];
    }
}

/**
 * Resolves the CodeMirror theme extensions for a colour scheme.
 *
 * @param mode - The scheme to render.
 * @returns The editor theme extensions.
 */
function themeFor(mode: "light" | "dark"): Extension[] {
    return editorTheme(mode);
}

/**
 * Collects Lezer error nodes as inline diagnostics.
 *
 * @param view - The editor view whose syntax tree is inspected.
 * @param label - Human-readable language label for the message.
 * @returns At most 100 diagnostics covering the parse errors.
 */
function syntaxProblems(view: EditorView, label: string): Diagnostic[] {
    const length = view.state.doc.length;
    const problems: Diagnostic[] = [];
    syntaxTree(view.state).iterate({
        enter: (node) => {
            if (!node.type.isError || problems.length >= 100) {
                return;
            }
            const from = Math.min(node.from, length);
            const to = Math.min(Math.max(node.to, node.from + 1), length);
            problems.push({
                from,
                to,
                severity: "error",
                message: `Syntax error in ${label}`,
            });
        },
    });
    return problems;
}

/**
 * Estimates whether the cursor sits inside an MCP server object by counting
 * braces after the nearest `mcpServers` key.
 *
 * @param text - The full document text.
 * @param position - The completion position.
 * @returns `server` inside a named server object, otherwise `root`.
 */
function schemaScopeAt(text: string, position: number): SchemaScope {
    const marker = text.lastIndexOf('"mcpServers"', position);
    if (marker < 0) {
        return "root";
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = marker + 12; index < position; index += 1) {
        const character = text[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (character === "\\") {
                escaped = true;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }
        if (character === '"') {
            inString = true;
        } else if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth = Math.max(0, depth - 1);
        }
    }
    return depth >= 2 ? "server" : "root";
}

/**
 * Suggests bundled schema keys at a JSON property position.
 *
 * @param getKeys - Accessor for the active file's schema keys.
 * @param context - The CodeMirror completion context.
 * @returns Matching key completions, or null outside a property name.
 */
function schemaCompletions(
    getKeys: () => SchemaKey[],
    context: CompletionContext,
): CompletionResult | null {
    const line = context.state.doc.lineAt(context.pos);
    const prefix = line.text.slice(0, context.pos - line.from);
    const match = /^\s*"?([\w$.-]*)$/.exec(prefix);
    if (!match) {
        return null;
    }
    const typed = match[1] ?? "";
    if (!context.explicit && typed.length === 0) {
        return null;
    }
    const scope = schemaScopeAt(context.state.doc.toString(), context.pos);
    const options = getKeys()
        .filter(
            (key) =>
                key.scope === scope &&
                key.name.toLowerCase().startsWith(typed.toLowerCase()),
        )
        .map((key) => ({
            label: key.name,
            detail: key.detail,
            type: "property",
            apply: (
                view: EditorView,
                completion: Completion,
                from: number,
                to: number,
            ) => {
                const suffix = view.state.doc.sliceString(
                    to,
                    view.state.doc.length,
                );
                const closesQuote = suffix.startsWith('"');
                const separator = /^"?\s*:\s*/.exec(suffix)?.[0];
                view.dispatch({
                    changes: {
                        from,
                        to: to + (separator?.length ?? Number(closesQuote)),
                        insert: `"${completion.label}": `,
                    },
                    selection: { anchor: from + completion.label.length + 4 },
                });
            },
        }));
    if (options.length === 0) {
        return null;
    }
    const quoted = prefix.trimStart().startsWith('"');
    return {
        from: context.pos - typed.length - (quoted ? 1 : 0),
        options,
        validFor: /^"?[\w$.-]*$/,
    };
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
    const [wrapComp] = useState(() => new Compartment());
    const initialContentRef = useRef(props.initialContent);
    const toast = useToast();
    const saveRef = useRef(props.onSave);

    // The editor is recreated by reloadKey, not by a new baseline after a save.
    // Keeping the latest initial content in a ref lets the mount read it
    // without remounting the view and losing the cursor or undo history.
    useEffect(() => {
        initialContentRef.current = props.initialContent;
    }, [props.initialContent]);

    useEffect(() => {
        saveRef.current = props.onSave;
    }, [props.onSave]);

    const onInternalDirty = useRef(props.onDirty);
    useEffect(() => {
        onInternalDirty.current = props.onDirty;
    }, [props.onDirty]);

    const onChangeRef = useRef(props.onChange);
    useEffect(() => {
        onChangeRef.current = props.onChange;
    }, [props.onChange]);

    const onDiagnosticsRef = useRef(props.onDiagnostics);
    useEffect(() => {
        onDiagnosticsRef.current = props.onDiagnostics;
    }, [props.onDiagnostics]);

    const schemaKeysRef = useRef<SchemaKey[]>(props.schemaKeys ?? []);
    useEffect(() => {
        schemaKeysRef.current = props.schemaKeys ?? [];
    }, [props.schemaKeys]);

    const checkAdviceRef = useRef(props.checkAdvice);
    useEffect(() => {
        checkAdviceRef.current = props.checkAdvice;
    }, [props.checkAdvice]);

    const modeRef = useRef(props.mode);
    useEffect(() => {
        modeRef.current = props.mode;
    }, [props.mode]);

    const softWrapRef = useRef(props.softWrap);
    useEffect(() => {
        softWrapRef.current = props.softWrap;
    }, [props.softWrap]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: themeComp.reconfigure(themeFor(props.mode)),
        });
    }, [props.mode, themeComp]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: wrapComp.reconfigure(
                props.softWrap ? EditorView.lineWrapping : [],
            ),
        });
    }, [props.softWrap, wrapComp]);

    useEffect(() => {
        if (!hostRef.current) {
            return;
        }
        const view = new EditorView({
            state: EditorState.create({
                doc: initialContentRef.current,
                extensions: [
                    basicSetup,
                    themeComp.of(themeFor(modeRef.current)),
                    wrapComp.of(
                        softWrapRef.current ? EditorView.lineWrapping : [],
                    ),
                    ...languageFor(props.lang),
                    ...(props.lang === "json" || props.lang === "jsonc"
                        ? [
                              autocompletion({
                                  override: [
                                      (context) =>
                                          schemaCompletions(
                                              () => schemaKeysRef.current,
                                              context,
                                          ),
                                  ],
                              }),
                          ]
                        : []),
                    lintGutter(),
                    linter(
                        async (lintedView) => {
                            const problems = syntaxProblems(
                                lintedView,
                                LANG_LABELS[props.lang] ?? props.lang,
                            );
                            const errors = problems.length;
                            let warnings = 0;
                            const check = checkAdviceRef.current;
                            if (
                                check &&
                                lintedView.state.doc.length <= 512 * 1024
                            ) {
                                try {
                                    const text =
                                        lintedView.state.doc.toString();
                                    const advice = await check(text);
                                    for (const item of advice) {
                                        let from = 0;
                                        let to = Math.min(
                                            lintedView.state.doc.length,
                                            1,
                                        );
                                        if (item.key) {
                                            const index = text.indexOf(
                                                `"${item.key}"`,
                                            );
                                            if (index < 0) {
                                                continue;
                                            }
                                            from = index;
                                            to = index + item.key.length + 2;
                                        }
                                        problems.push({
                                            from,
                                            to,
                                            severity: "warning",
                                            message: item.message,
                                        });
                                        warnings += 1;
                                    }
                                } catch {
                                    // Advice is optional and never blocks editing.
                                }
                            }
                            window.setTimeout(
                                () =>
                                    onDiagnosticsRef.current?.({
                                        errors,
                                        warnings,
                                    }),
                                0,
                            );
                            return problems;
                        },
                        { delay: 450 },
                    ),
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
                        if (u.docChanged) {
                            onInternalDirty.current();
                            if (onChangeRef.current) {
                                onChangeRef.current(u.state.doc.toString());
                            }
                        }
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
    }, [props.reloadKey, props.lang, themeComp, wrapComp]);

    useImperativeHandle(
        ref,
        () => ({
            getContent: () => viewRef.current?.state.doc.toString() ?? "",
            applyEdit: (content) => {
                const view = viewRef.current;
                if (!view) {
                    return;
                }
                view.dispatch({
                    changes: {
                        from: 0,
                        to: view.state.doc.length,
                        insert: content,
                    },
                });
            },
            revealLine: (line) => {
                const view = viewRef.current;
                if (!view) {
                    return;
                }
                const target = Math.min(
                    Math.max(Math.trunc(line), 1),
                    view.state.doc.lines,
                );
                const info = view.state.doc.line(target);
                view.dispatch({
                    selection: { anchor: info.from },
                    effects: EditorView.scrollIntoView(info.from, {
                        y: "center",
                    }),
                });
                view.focus();
            },
        }),
        [],
    );

    return (
        <div data-editor-pane="true" className="flex h-full flex-col">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface px-4 py-2">
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
                <div className="min-w-40 flex-1">
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
                    {props.onToggleFavorite && (
                        <button
                            type="button"
                            title={
                                props.isFavorite
                                    ? "Remove from favorites"
                                    : "Add to favorites"
                            }
                            onClick={() => props.onToggleFavorite?.()}
                            className={`${iconBtn} ${props.isFavorite ? "text-amber-500" : ""}`}
                        >
                            <Star
                                size={15}
                                fill={
                                    props.isFavorite ? "currentColor" : "none"
                                }
                            />
                        </button>
                    )}
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
                                .openFile(props.filePath)
                                .then((result) => {
                                    if (!result.ok && result.error) {
                                        toast.error(result.error);
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
                        title="Format document (Ctrl+Shift+F)"
                        disabled={
                            !props.onFormat ||
                            props.formatting ||
                            props.lang === "dotenv" ||
                            props.lang === "python" ||
                            props.lang === "shell" ||
                            props.lang === "text"
                        }
                        onClick={() => props.onFormat?.()}
                        className={iconBtn}
                    >
                        {props.formatting ? (
                            <Loader2 size={15} className="animate-spin" />
                        ) : (
                            <Wand size={15} />
                        )}
                    </button>
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
                    Contains secrets/tokens - backups of this file are encrypted
                    at rest.
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
                {props.restartHint && (
                    <span className="text-amber-500">
                        restart the tool after saving
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
