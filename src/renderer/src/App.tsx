import {
    Suspense,
    lazy,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
} from "react";
import { FileCog, Loader2, Settings2 } from "lucide-react";
import logoUrl from "./assets/logo.png";
import type {
    AppSettings,
    Tool,
    ToolFile,
    ToolFolder,
} from "../../shared/types";
import Sidebar from "./components/Sidebar";
import EditorPane, { type EditorHandle } from "./components/EditorPane";
import ThemeSwitch from "./components/ThemeSwitch";
import FolderView from "./components/FolderView";
import PreviewPane from "./components/PreviewPane";
import { formatDocument } from "./lib/beautify";
import { ToastProvider } from "./components/Toasts";
import { useToast } from "./components/useToast";
import ConfirmDialog from "./components/ConfirmDialog";
import { ThemeProvider } from "./theme";
import { useThemeMode } from "./theme-context";
import { ErrorBoundary } from "./components/ErrorBoundary";

const SettingsModal = lazy(() => import("./components/SettingsModal"));
const HistoryModal = lazy(() => import("./components/HistoryModal"));

/**
 * Returns a Windows-friendly, lower-cased path for equality checks.
 */
function normPath(p: string): string {
    return p.replace(/\//g, "\\").toLowerCase();
}

/**
 * Finds the closest enclosing registered root folder for a given folder.
 * Longest-prefix match against the tool's registered roots (not every
 * folder), so a registered subfolder cannot match itself and the
 * root-normalization in `selectFolder` stays meaningful.
 */
function containingRoot(
    tool: Tool,
    folder: ToolFolder,
): ToolFolder | undefined {
    const normFolder = normPath(folder.path);
    let best: ToolFolder | undefined;
    let bestLen = -1;
    for (const root of tool.roots ?? []) {
        const normRoot = normPath(root.path);
        if (
            normFolder.startsWith(normRoot) &&
            normRoot.length > bestLen &&
            // Reject false prefixes where one root path is a lexical prefix of
            // another (e.g. opencode vs opencode-evil). Same boundary rule the
            // main-process `findContainingFolder` applies via `path.sep`.
            (normFolder.length === normRoot.length ||
                normFolder.charAt(normRoot.length) === "\\" ||
                normFolder.charAt(normRoot.length) === "/")
        ) {
            const synth = (tool.folders ?? []).find(
                (f) => f.path === root.path,
            );
            if (synth) {
                best = synth;
                bestLen = normRoot.length;
            }
        }
    }
    return best;
}

interface Selection {
    tool: Tool;
    file: ToolFile;
    selFolderRef?: FolderContext;
    exists: boolean;
    content: string;
    size: number;
    mtime: number;
}

interface FolderContext {
    tool: Tool;
    folder: ToolFolder;
    dir: string;
}

type ModalKind = "settings" | "history" | null;

/**
 * Main UI shell: sidebar, editor or folder view, header and modals.
 * Owns selection, dirty state and file-watcher wiring.
 */
function AppContent(): JSX.Element {
    const [tools, setTools] = useState<Tool[]>([]);
    const [hidden, setHidden] = useState<string[]>([]);
    const [settings, setSettings] = useState<AppSettings | null>(null);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [sel, setSel] = useState<Selection | null>(null);
    const [selFolder, setSelFolder] = useState<FolderContext | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [reloadNonce, setReloadNonce] = useState(0);
    const [folderNonce, setFolderNonce] = useState(0);
    const [modal, setModal] = useState<ModalKind>(null);
    const [external, setExternal] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [formatting, setFormatting] = useState(false);
    const [liveContent, setLiveContent] = useState<string | null>(null);
    const editorRef = useRef<EditorHandle | null>(null);
    const savingRef = useRef(false);
    const formattingRef = useRef(false);
    const dirtyRef = useRef(false);
    const selRef = useRef<Selection | null>(null);
    const selFolderRef = useRef<FolderContext | null>(null);
    const recentSavesRef = useRef<
        Map<string, { content: string; until: number }>
    >(new Map());
    const mode = useThemeMode();
    const toast = useToast();

    useEffect(() => {
        selRef.current = sel;
    }, [sel]);

    useEffect(() => {
        selFolderRef.current = selFolder;
    }, [selFolder]);

    /**
     * Marks the current selection as having unsaved changes (idempotent).
     */
    const markDirty = useCallback(() => {
        if (!dirtyRef.current) {
            dirtyRef.current = true;
            setDirty(true);
        }
    }, []);

    /**
     * Clears the unsaved-changes flag.
     */
    const clearDirty = useCallback(() => {
        dirtyRef.current = false;
        setDirty(false);
    }, []);

    /**
     * Keeps the Markdown preview in sync with the current editor content.
     * Only wired when the active file is Markdown, so non-Markdown files
     * never pay the O(n) stringify plus state update cost on keystrokes.
     */
    const handleEditorChange = useCallback((content: string) => {
        setLiveContent(content);
    }, []);

    /**
     * Re-fetches the tool list and hidden-tools setting in parallel.
     */
    const refresh = useCallback(async () => {
        const [t, s] = await Promise.all([
            window.api.listTools(),
            window.api.getSettings(),
        ]);
        setTools(t.tools);
        setHidden(s.hiddenTools);
        setSettings(s);
    }, []);

    useEffect(() => {
        let alive = true;
        void window.api
            .listTools()
            .then((t) => {
                if (alive) setTools(t.tools);
            })
            .catch((err) =>
                toast.error(err instanceof Error ? err.message : String(err)),
            );
        void window.api
            .getSettings()
            .then((s) => {
                if (alive) {
                    setHidden(s.hiddenTools);
                    setSettings(s);
                }
            })
            .catch((err) =>
                toast.error(err instanceof Error ? err.message : String(err)),
            );
        return () => {
            alive = false;
        };
    }, [toast]);

    /**
     * Reads the file and updates the active selection, optionally
     * recording the parent folder for back navigation.
     */
    const applySelection = useCallback(
        (tool: Tool, file: ToolFile, folder?: FolderContext) => {
            if (!folder) {
                setSelFolder(null);
            }
            const previousPath = selRef.current?.file.path;
            if (previousPath) {
                recentSavesRef.current.delete(previousPath);
            }
            void window.api
                .readFile(file.path)
                .then((r) => {
                    setSel({
                        tool,
                        file,
                        selFolderRef: folder,
                        exists: r.exists,
                        content: r.content,
                        size: r.size,
                        mtime: r.mtime,
                    });
                    clearDirty();
                    setReloadNonce((n) => n + 1);
                    setLiveContent(null);
                })
                .catch((err) =>
                    toast.error(
                        err instanceof Error ? err.message : String(err),
                    ),
                );
        },
        [clearDirty, toast],
    );

    /**
     * Returns the user to the folder view that the current file was opened from.
     */
    const backToFolder = useCallback(() => {
        if (!sel?.selFolderRef) return;
        recentSavesRef.current.delete(sel.file.path);
        setSel(null);
        clearDirty();
        setExternal(false);
        setSelFolder(sel.selFolderRef);
    }, [sel, clearDirty]);

    /**
     * Deletes the currently selected file after confirmation.
     * On success, clears the editor and bumps the folder nonce so the sidebar refreshes.
     */
    const performEditorDelete = useCallback(async (): Promise<void> => {
        setConfirmDelete(false);
        const cur = selRef.current;
        if (!cur) return;
        try {
            const res = await window.api.deleteFile(cur.file.path);
            if (res.ok) {
                toast.info(`Deleted ${cur.file.label}`);
                recentSavesRef.current.delete(cur.file.path);
                setSel(null);
                clearDirty();
                setExternal(false);
                setFolderNonce((n) => n + 1);
                if (cur.selFolderRef) {
                    setSelFolder(cur.selFolderRef);
                }
            } else {
                toast.error(res.error ?? "Failed to delete");
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    }, [clearDirty, toast]);

    /**
     * Opens a config file in the editor and pushes it to recents.
     */
    const selectFile = useCallback(
        (tool: Tool, file: ToolFile) => {
            setSelFolder(null);
            applySelection(tool, file, undefined);
            void window.api.pushRecent(file.path).catch(() => {});
        },
        [applySelection],
    );

    /**
     * Opens a tool folder in the folder view.
     *
     * If the clicked folder lives inside the tool's registered root folder, this
     * is normalised to the root folder with `dir` set to the relative path. That
     * way FolderView's existing `cwdRel` machinery handles back-navigation the
     * same way as drilling in from the root - the back button is enabled and
     * climbs one level at a time. Without this, opening a registered subfolder
     * directly from the sidebar would land on a FolderView with cwdRel="" and
     * leave the back button permanently disabled.
     */
    const selectFolder = useCallback(
        (tool: Tool, folder: ToolFolder) => {
            const previousPath = selRef.current?.file.path;
            if (previousPath) {
                recentSavesRef.current.delete(previousPath);
            }
            setSel(null);
            clearDirty();
            setExternal(false);

            const rootFolder = containingRoot(tool, folder);
            let target = folder;
            let dir = "";
            if (rootFolder && rootFolder.id !== folder.id) {
                const rootN = normPath(rootFolder.path);
                const folderN = normPath(folder.path);
                if (
                    folderN.length > rootN.length &&
                    folderN.startsWith(rootN) &&
                    (folderN.charAt(rootN.length) === "\\" ||
                        rootN.endsWith("\\"))
                ) {
                    const remainder = folder.path.slice(rootFolder.path.length);
                    dir = remainder
                        .split(/[\\/]+/)
                        .filter(Boolean)
                        .join("/");
                    target = rootFolder;
                }
            }

            setSelFolder({ tool, folder: target, dir });
        },
        [clearDirty],
    );

    useEffect(() => {
        const off = window.api.onOpenFile((p) => {
            void (async () => {
                await refresh();
                for (const t of tools) {
                    for (const f of t.files) {
                        if (normPath(f.path) === normPath(p)) {
                            selectFile(t, f);
                            return;
                        }
                    }
                    for (const fo of t.folders ?? []) {
                        if (normPath(fo.path) === normPath(p)) {
                            selectFolder(t, fo);
                            return;
                        }
                    }
                }
            })();
        });
        return off;
    }, [tools, refresh, selectFile, selectFolder]);

    const selPath = sel?.file.path;

    useEffect(() => {
        if (selPath) void window.api.watchFile(selPath).catch(() => {});
    }, [selPath]);

    const selFolderPath = selFolder?.folder.path;

    useEffect(() => {
        if (!selPath && selFolderPath)
            void window.api.watchFolder(selFolderPath).catch(() => {});
    }, [selFolderPath, selPath]);

    useEffect(() => {
        const off = window.api.onFileChanged((changed) => {
            const fcur = selFolderRef.current;
            if (fcur && normPath(changed) === normPath(fcur.folder.path)) {
                setFolderNonce((n) => n + 1);
            }
            const cur = selRef.current;
            if (!cur || normPath(changed) !== normPath(cur.file.path)) return;
            void window.api
                .fileStat(cur.file.path)
                .then(async (st) => {
                    if (!st) return;
                    if (st.mtime === cur.mtime && st.size === cur.size) return;
                    if (!dirtyRef.current) {
                        // Backstop: the main-side recentWrites map is the primary defense for self-saves.
                        const expected = recentSavesRef.current.get(
                            cur.file.path,
                        );
                        if (
                            expected !== undefined &&
                            expected.until > Date.now()
                        ) {
                            try {
                                const r = await window.api.readFile(
                                    cur.file.path,
                                );
                                if (r.content === expected.content) {
                                    recentSavesRef.current.delete(
                                        cur.file.path,
                                    );
                                    return;
                                }
                            } catch {
                                // Fall through to the existing reload path
                                // when the read fails.
                            }
                        }
                        applySelection(cur.tool, cur.file);
                    } else {
                        setExternal(true);
                    }
                })
                .catch(() => {});
        });
        return off;
    }, [applySelection]);

    /**
     * Persists the current editor content via IPC and refreshes size/mtime.
     * No-ops when the selection is not dirty or a save is already running.
     */
    const handleSave = useCallback(async () => {
        if (!sel || savingRef.current || saving) return;
        if (!dirtyRef.current && sel.exists) return;
        const content = editorRef.current?.getContent();
        if (content === undefined) return;
        savingRef.current = true;
        setSaving(true);
        try {
            const res = await window.api.writeFile(sel.file.path, content);
            if (res.ok) {
                clearDirty();
                setExternal(false);
                recentSavesRef.current.set(sel.file.path, {
                    content,
                    until: Date.now() + 2000,
                });
                let size = new Blob([content]).size;
                let mtime = Date.now();
                try {
                    const st = await window.api.fileStat(sel.file.path);
                    if (st) {
                        size = st.size;
                        mtime = st.mtime;
                    }
                } catch {
                    // Keep the local Blob size/mtime estimate on stat failure.
                }
                setSel((cur) =>
                    cur ? { ...cur, exists: true, size, mtime } : cur,
                );
                toast.success(
                    res.created
                        ? `Created ${sel.file.label}`
                        : res.backupPath
                          ? "Saved · backup created"
                          : "Saved",
                );
            } else {
                toast.error(res.error);
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    }, [sel, saving, clearDirty, toast]);

    /**
     * Re-reads the current file from disk, discarding in-memory edits.
     */
    const handleRevert = useCallback(() => {
        if (!sel) return;
        applySelection(sel.tool, sel.file);
    }, [sel, applySelection]);

    /**
     * Formats the current editor content in memory with prettier (or
     * @iarna/toml for TOML) and replaces the editor doc. Nothing is written
     * to disk; the user still saves with Ctrl+S.
     */
    const handleFormat = useCallback(async () => {
        const cur = selRef.current;
        if (!cur) return;
        if (cur.file.lang === "dotenv" || cur.file.lang === "text") return;
        if (formattingRef.current) return;
        const current = editorRef.current?.getContent() ?? "";
        formattingRef.current = true;
        setFormatting(true);
        try {
            const result = await formatDocument(current, cur.file.lang);
            if (result.ok) {
                if (result.content === current) {
                    toast.info("Already formatted");
                } else {
                    editorRef.current?.applyEdit(result.content);
                    toast.success("Formatted - press Ctrl+S to save");
                }
            } else {
                toast.error(result.error);
            }
        } finally {
            formattingRef.current = false;
            setFormatting(false);
        }
    }, [toast]);

    useEffect(() => {
        const h = (e: KeyboardEvent): void => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                void handleSave();
            }
        };
        window.addEventListener("keydown", h);
        return () => window.removeEventListener("keydown", h);
    }, [handleSave]);

    useEffect(() => {
        const h = (e: KeyboardEvent): void => {
            if (
                (e.ctrlKey || e.metaKey) &&
                e.shiftKey &&
                e.key.toLowerCase() === "f"
            ) {
                e.preventDefault();
                void handleFormat();
            }
        };
        window.addEventListener("keydown", h);
        return () => window.removeEventListener("keydown", h);
    }, [handleFormat]);

    const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
    const visible = useMemo(
        () => tools.filter((t) => !hiddenSet.has(t.id)),
        [tools, hiddenSet],
    );

    const iconBtn =
        "rounded-lg p-2 text-secondary transition-colors hover:bg-raised hover:text-primary disabled:pointer-events-none disabled:opacity-30";

    return (
        <div className="flex h-screen flex-col">
            <header className="drag-region flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 select-none">
                <img
                    src={logoUrl}
                    alt="app logo"
                    className="size-4 shrink-0 rounded"
                />
                <span className="text-xs font-semibold tracking-wide text-primary">
                    Maestro
                </span>
                <div className="flex-1" />
                <ThemeSwitch />
                <button
                    type="button"
                    title="Settings"
                    onClick={() => setModal("settings")}
                    className={`${iconBtn} no-drag`}
                >
                    <Settings2 size={15} />
                </button>
                <div className="drag-region w-34 shrink-0" />
            </header>

            <div className="flex min-h-0 flex-1">
                <Sidebar
                    tools={visible}
                    selectedId={sel?.file.id ?? null}
                    selectedFolderId={selFolder?.folder.id ?? null}
                    onSelect={(t, f) => selectFile(t, f)}
                    onSelectFolder={(t, f) => selectFolder(t, f)}
                    onManage={() => setModal("settings")}
                    collapsed={sidebarCollapsed}
                    onToggle={() => setSidebarCollapsed((c) => !c)}
                />

                <main className="flex min-w-0 flex-1 flex-col bg-app">
                    {sel ? (
                        <div className="flex min-h-0 flex-1">
                            <div className="flex min-w-0 flex-1 flex-col">
                                <EditorPane
                                    key={`${sel.file.id}:${reloadNonce}`}
                                    ref={editorRef}
                                    lang={sel.file.lang}
                                    mode={mode}
                                    softWrap={settings?.softWrap ?? true}
                                    initialContent={sel.content}
                                    reloadKey={`${sel.file.id}:${reloadNonce}`}
                                    onDirty={markDirty}
                                    onSave={() => void handleSave()}
                                    onFormat={() => void handleFormat()}
                                    formatting={formatting}
                                    onChange={
                                        sel.file.lang === "markdown"
                                            ? handleEditorChange
                                            : undefined
                                    }
                                    unsaved={dirty}
                                    filePath={sel.file.path}
                                    parentLabel={sel.file.parentLabel}
                                    onBack={
                                        sel.selFolderRef
                                            ? backToFolder
                                            : undefined
                                    }
                                    fileExists={sel.exists}
                                    fileSecret={sel.file.secret}
                                    fileNote={sel.file.note}
                                    externalChange={external}
                                    fileSize={sel.size}
                                    fileMtime={sel.mtime}
                                    onHistoryClick={() => setModal("history")}
                                    onReloadClick={() => handleRevert()}
                                    onDelete={() => setConfirmDelete(true)}
                                />
                            </div>
                            {sel.file.lang === "markdown" && (
                                <>
                                    <div className="w-px shrink-0 bg-line" />
                                    <PreviewPane
                                        content={liveContent ?? sel.content}
                                        lang={sel.file.lang}
                                    />
                                </>
                            )}
                        </div>
                    ) : selFolder ? (
                        <FolderView
                            key={`${selFolder.folder.path}:${selFolder.dir}`}
                            folder={selFolder.folder}
                            reloadKey={folderNonce}
                            initialDir={selFolder.dir}
                            onOpenFile={(f, dir) =>
                                applySelection(selFolder.tool, f, {
                                    tool: selFolder.tool,
                                    folder: selFolder.folder,
                                    dir,
                                })
                            }
                            onMutated={() => void refresh()}
                            onDeleted={() => {
                                setSel(null);
                                setSelFolder(null);
                                clearDirty();
                                setExternal(false);
                            }}
                        />
                    ) : (
                        <div className="grid flex-1 place-items-center">
                            <div className="text-center">
                                <FileCog
                                    size={44}
                                    className="mx-auto text-line2"
                                    strokeWidth={1.25}
                                />
                                <p className="mt-4 text-sm font-medium text-secondary">
                                    Select a config file or folder to manage
                                </p>
                                <p className="mt-1 text-xs text-faint">
                                    {visible.length} tools detected · backups
                                    saved to %APPDATA%\maestro\backups
                                </p>
                            </div>
                        </div>
                    )}
                </main>
            </div>

            {modal && (
                <Suspense
                    fallback={
                        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
                            <Loader2
                                size={22}
                                className="animate-spin text-accent"
                            />
                        </div>
                    }
                >
                    {modal === "settings" ? (
                        <SettingsModal
                            tools={tools}
                            hidden={hidden}
                            onClose={() => setModal(null)}
                            onChanged={refresh}
                        />
                    ) : (
                        sel && (
                            <HistoryModal
                                file={sel.file}
                                getCurrent={() =>
                                    editorRef.current?.getContent() ??
                                    sel.content
                                }
                                onLoadIntoEditor={(c) => {
                                    setModal(null);
                                    if (!sel || c === sel.content) {
                                        toast.info(
                                            "That backup matches the current file",
                                        );
                                        return;
                                    }
                                    setSel({ ...sel, content: c });
                                    setReloadNonce((n) => n + 1);
                                    setLiveContent(null);
                                    markDirty();
                                }}
                                onRestored={() =>
                                    applySelection(
                                        sel.tool,
                                        sel.file,
                                        sel.selFolderRef,
                                    )
                                }
                                onClose={() => setModal(null)}
                            />
                        )
                    )}
                </Suspense>
            )}

            {confirmDelete && sel && (
                <ConfirmDialog
                    title="Delete file"
                    message={`Delete "${sel.file.label}"? It will be sent to the Recycle Bin.`}
                    onConfirm={() => void performEditorDelete()}
                    onCancel={() => setConfirmDelete(false)}
                />
            )}
        </div>
    );
}

/**
 * Root application component that composes providers and the main UI.
 *
 * @param initialDark - Whether the app starts in dark mode.
 */
export default function App({
    initialDark,
}: {
    initialDark: boolean;
}): JSX.Element {
    return (
        <ErrorBoundary>
            <ToastProvider>
                <ThemeProvider initial={initialDark ? "dark" : "light"}>
                    <AppContent />
                </ThemeProvider>
            </ToastProvider>
        </ErrorBoundary>
    );
}
