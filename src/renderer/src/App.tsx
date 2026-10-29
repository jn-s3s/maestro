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
import {
    Clock3,
    FileCog,
    FolderGit2,
    Loader2,
    PanelRight,
    Search,
    Settings2,
} from "lucide-react";
import logoUrl from "./assets/logo.png";
import { langFromPath } from "../../shared/types";
import type {
    AppSettings,
    ReadResult,
    SchemaInfo,
    ThemeMode,
    Tool,
    ToolFile,
    ToolFolder,
} from "../../shared/types";
import Sidebar from "./components/Sidebar";
import EditorPane, { type EditorHandle } from "./components/EditorPane";
import ThemeSwitch from "./components/ThemeSwitch";
import FolderView from "./components/FolderView";
import PreviewPane from "./components/PreviewPane";
import TabBar, { type TabInfo } from "./components/TabBar";
import CommandPalette, {
    type PaletteCommand,
} from "./components/CommandPalette";
import ConflictDialog from "./components/ConflictDialog";
import InspectorPanel from "./components/InspectorPanel";
import ViewLanding from "./components/ViewLanding";
import { formatDocument } from "./lib/beautify";
import {
    isLibraryFile,
    isLibraryFolder,
    isMcpFile,
    type NavView,
} from "./lib/views";
import { ToastProvider } from "./components/Toasts";
import { useToast } from "./components/useToast";
import ConfirmDialog from "./components/ConfirmDialog";
import { ThemeProvider } from "./theme";
import { useThemeMode } from "./theme-context";
import { ErrorBoundary } from "./components/ErrorBoundary";

const SettingsModal = lazy(() => import("./components/SettingsModal"));
const HistoryModal = lazy(() => import("./components/HistoryModal"));

const FAVORITES_KEY = "maestro.favorites.v1";
const FAVORITE_FILES_KEY = "maestro.favorite-files.v1";

/**
 * Returns a Windows-friendly, lower-cased path for equality checks.
 *
 * @param target - The path to normalize.
 * @returns The separator-normalized, lower-cased path.
 */
function normPath(target: string): string {
    return target.replace(/\//g, "\\").toLowerCase();
}

/**
 * Finds the closest enclosing registered root folder for a given folder.
 * Longest-prefix match against the tool's registered roots (not every
 * folder), so a registered subfolder cannot match itself and the
 * root-normalization in `selectFolder` stays meaningful.
 *
 * @param tool - The tool that owns the folder.
 * @param folder - The folder to find a parent root for.
 * @returns The closest registered root, or undefined when none contains it.
 */
function containingRoot(
    tool: Tool,
    folder: ToolFolder,
): ToolFolder | undefined {
    const normFolder = normPath(folder.path);
    let bestMatch: ToolFolder | undefined;
    let bestLength = -1;
    for (const root of tool.roots ?? []) {
        const normRoot = normPath(root.path);
        if (
            normFolder.startsWith(normRoot) &&
            normRoot.length > bestLength &&
            (normFolder.length === normRoot.length ||
                normFolder.charAt(normRoot.length) === "\\" ||
                normFolder.charAt(normRoot.length) === "/")
        ) {
            const registered = (tool.folders ?? []).find(
                (candidate) => candidate.path === root.path,
            );
            if (registered) {
                bestMatch = registered;
                bestLength = normRoot.length;
            }
        }
    }
    return bestMatch;
}

function loadFavorites(): string[] {
    try {
        const stored = JSON.parse(
            localStorage.getItem(FAVORITES_KEY) ?? "[]",
        ) as unknown;
        return Array.isArray(stored)
            ? stored.filter(
                  (entry): entry is string => typeof entry === "string",
              )
            : [];
    } catch {
        return [];
    }
}

interface FavoriteRecord {
    toolId: string;
    file: ToolFile;
}

function loadFavoriteRecords(): Record<string, FavoriteRecord> {
    try {
        const stored = JSON.parse(
            localStorage.getItem(FAVORITE_FILES_KEY) ?? "{}",
        ) as unknown;
        if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
            return {};
        }
        return Object.fromEntries(
            Object.entries(stored).filter(
                (entry): entry is [string, FavoriteRecord] => {
                    const value = entry[1];
                    if (!value || typeof value !== "object") {
                        return false;
                    }
                    const record = value as Partial<FavoriteRecord>;
                    const file = record.file;
                    return (
                        typeof record.toolId === "string" &&
                        !!file &&
                        typeof file.id === "string" &&
                        typeof file.label === "string" &&
                        typeof file.path === "string" &&
                        typeof file.exists === "boolean" &&
                        typeof file.lang === "string"
                    );
                },
            ),
        );
    } catch {
        return {};
    }
}

interface FolderContext {
    tool: Tool;
    folder: ToolFolder;
    dir: string;
}

interface OpenTab {
    id: string;
    tool: Tool;
    file: ToolFile;
    folderRef?: FolderContext;
    exists: boolean;
    content: string;
    size: number;
    mtime: number;
    revision: string | null;
    draftBaseRevision?: string | null;
    dirty: boolean;
    external: boolean;
    reloadNonce: number;
    diagnostics: number;
    warnings: number;
    liveContent: string | null;
    draft: string | null;
}

interface ConflictState {
    tabId: string;
    mine: string;
    editVersion: number;
    disk: string;
    diskExists: boolean;
    diskRevision: string | null;
    diskSize: number;
    diskMtime: number;
    busy: boolean;
}

type ModalKind = "settings" | "history" | null;

/**
 * Main UI shell: navigation, tabbed editors, command palette, inspector and
 * recovery modals. Owns document state and file-watcher wiring.
 */
function AppContent(): JSX.Element {
    const [tools, setTools] = useState<Tool[]>([]);
    const [hidden, setHidden] = useState<string[]>([]);
    const [settings, setSettings] = useState<AppSettings | null>(null);
    const [favorites, setFavorites] = useState<string[]>(loadFavorites);
    const [favoriteRecords, setFavoriteRecords] =
        useState<Record<string, FavoriteRecord>>(loadFavoriteRecords);
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [filter, setFilter] = useState("");
    const [workspaceFilter, setWorkspaceFilter] = useState("all");
    const [navView, setNavView] = useState<NavView>("configs");
    const [tabs, setTabs] = useState<OpenTab[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [folderActive, setFolderActive] = useState(false);
    const [selFolder, setSelFolder] = useState<FolderContext | null>(null);
    const [saving, setSaving] = useState(false);
    const [folderNonce, setFolderNonce] = useState(0);
    const [modal, setModal] = useState<ModalKind>(null);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [confirmClose, setConfirmClose] = useState<string | null>(null);
    const [formatting, setFormatting] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [inspectorOpen, setInspectorOpen] = useState(false);
    const [conflict, setConflict] = useState<ConflictState | null>(null);
    const [reveal, setReveal] = useState<{ id: string; line: number } | null>(
        null,
    );
    const [backupCount, setBackupCount] = useState<number | null>(null);
    const [backupsLoading, setBackupsLoading] = useState(false);
    const [schema, setSchema] = useState<SchemaInfo | null>(null);
    const editorRef = useRef<EditorHandle | null>(null);
    const savingRef = useRef(false);
    const formattingRef = useRef(false);
    const tabsRef = useRef<OpenTab[]>([]);
    const activeIdRef = useRef<string | null>(null);
    const selFolderRef = useRef<FolderContext | null>(null);
    const dirtyIdsRef = useRef(new Set<string>());
    const editVersionsRef = useRef(new Map<string, number>());
    const draftContentRef = useRef(new Map<string, string>());
    const navigationRef = useRef(0);
    const draftsRestoredRef = useRef(false);
    const draftTimersRef = useRef<Map<string, number>>(new Map());
    const draftEpochRef = useRef<Map<string, number>>(new Map());
    const draftFailuresRef = useRef(new Set<string>());
    const recentSavesRef = useRef<
        Map<string, { content: string; until: number }>
    >(new Map());
    const mode = useThemeMode();
    const toast = useToast();
    const checkConfig = window.api.checkConfig;

    useEffect(() => {
        tabsRef.current = tabs;
    }, [tabs]);

    useEffect(() => {
        activeIdRef.current = activeId;
    }, [activeId]);

    useEffect(() => {
        selFolderRef.current = selFolder;
    }, [selFolder]);

    const activeTab = useMemo(
        () => tabs.find((tab) => tab.id === activeId) ?? null,
        [tabs, activeId],
    );
    const schemaPath = activeTab?.file.path;
    const schemaLang = activeTab?.file.lang;

    const patchTab = useCallback(
        (
            id: string,
            patch: Partial<OpenTab> | ((tab: OpenTab) => Partial<OpenTab>),
        ) => {
            setTabs((current) =>
                current.map((tab) =>
                    tab.id === id
                        ? {
                              ...tab,
                              ...(typeof patch === "function"
                                  ? patch(tab)
                                  : patch),
                          }
                        : tab,
                ),
            );
        },
        [],
    );

    const markTabDirty = useCallback((id: string) => {
        dirtyIdsRef.current.add(id);
        editVersionsRef.current.set(
            id,
            (editVersionsRef.current.get(id) ?? 0) + 1,
        );
        setTabs((current) =>
            current.map((tab) =>
                tab.id === id && !tab.dirty ? { ...tab, dirty: true } : tab,
            ),
        );
    }, []);

    const clearDraftTimer = useCallback((path: string) => {
        const timer = draftTimersRef.current.get(path);
        if (timer !== undefined) {
            window.clearTimeout(timer);
            draftTimersRef.current.delete(path);
        }
    }, []);

    const deleteStoredDraft = useCallback(
        (path: string) => {
            draftEpochRef.current.set(
                path,
                (draftEpochRef.current.get(path) ?? 0) + 1,
            );
            clearDraftTimer(path);
            if (
                !window.api.capabilities.draftRecovery ||
                !window.api.deleteDraft
            ) {
                return;
            }
            void window.api.deleteDraft(path).catch(() => {});
        },
        [clearDraftTimer],
    );

    /**
     * Reports a draft write failure once per file until a later write succeeds.
     *
     * @param path - Source file whose draft could not be stored.
     * @param message - Error text from the draft command.
     */
    const reportDraftFailure = useCallback(
        (path: string, message: string) => {
            if (draftFailuresRef.current.has(path)) {
                return;
            }
            draftFailuresRef.current.add(path);
            toast.error(`Draft not saved: ${message}`);
        },
        [toast],
    );

    /**
     * Stores the latest editor text as an encrypted draft after a short pause.
     * The base revision is captured when the draft is written so a restart can
     * tell whether the file changed since the edits began.
     *
     * @param tabId - The tab whose content changed.
     * @param content - The current editor content.
     */
    const scheduleDraft = useCallback(
        (tabId: string, content: string) => {
            if (
                !window.api.capabilities.draftRecovery ||
                !window.api.saveDraft
            ) {
                return;
            }
            const tab = tabsRef.current.find(
                (candidate) => candidate.id === tabId,
            );
            if (!tab) {
                return;
            }
            const path = tab.file.path;
            const existing = draftTimersRef.current.get(path);
            if (existing !== undefined) {
                window.clearTimeout(existing);
            }
            draftTimersRef.current.set(
                path,
                window.setTimeout(() => {
                    draftTimersRef.current.delete(path);
                    const latest = tabsRef.current.find(
                        (candidate) => candidate.id === tabId,
                    );
                    if (!latest) {
                        return;
                    }
                    if (content === latest.content) {
                        deleteStoredDraft(path);
                        return;
                    }
                    const save = window.api.saveDraft;
                    if (!save) {
                        return;
                    }
                    const epoch = draftEpochRef.current.get(path) ?? 0;
                    void save(
                        path,
                        content,
                        latest.draftBaseRevision === undefined
                            ? latest.revision
                            : latest.draftBaseRevision,
                    )
                        .then((result) => {
                            if (!result.ok) {
                                reportDraftFailure(
                                    path,
                                    result.error ?? "unknown error",
                                );
                                return;
                            }
                            draftFailuresRef.current.delete(path);
                            if (
                                (draftEpochRef.current.get(path) ?? 0) !== epoch
                            ) {
                                void window.api
                                    .deleteDraft?.(path)
                                    .catch(() => {});
                            }
                        })
                        .catch((error) =>
                            reportDraftFailure(
                                path,
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                            ),
                        );
                }, 600),
            );
        },
        [deleteStoredDraft, reportDraftFailure],
    );

    const handleEditorChange = useCallback(
        (tabId: string, content: string) => {
            const tab = tabsRef.current.find(
                (candidate) => candidate.id === tabId,
            );
            if (!tab) {
                return;
            }
            draftContentRef.current.set(tabId, content);
            if (tab.file.lang === "markdown") {
                patchTab(tabId, { liveContent: content });
            }
            scheduleDraft(tabId, content);
        },
        [patchTab, scheduleDraft],
    );

    /**
     * Stores the active editor content as a per-tab draft before the editor
     * unmounts, so switching tabs or opening a folder keeps unsaved edits.
     */
    const captureDraft = useCallback(() => {
        const id = activeIdRef.current;
        if (!id) {
            return;
        }
        const content = editorRef.current?.getContent();
        if (content === undefined) {
            return;
        }
        draftContentRef.current.set(id, content);
        patchTab(id, (tab) => ({
            draft: content === tab.content ? null : content,
        }));
    }, [patchTab]);

    /**
     * Activates a tab after preserving the current editor draft.
     *
     * @param id - The tab to activate.
     */
    const activateTab = useCallback(
        (id: string) => {
            captureDraft();
            navigationRef.current += 1;
            setFolderActive(false);
            setActiveId(id);
        },
        [captureDraft],
    );

    /**
     * Re-fetches the tool list and settings.
     */
    const refresh = useCallback(async () => {
        const [toolsResult, settingsResult] = await Promise.all([
            window.api.listTools(),
            window.api.getSettings(),
        ]);
        setTools(toolsResult.tools);
        setHidden(settingsResult.hiddenTools);
        setSettings(settingsResult);
    }, []);

    const rememberRecent = useCallback((path: string) => {
        setSettings((current) =>
            current
                ? {
                      ...current,
                      recentFiles: [
                          path,
                          ...current.recentFiles.filter(
                              (entry) => normPath(entry) !== normPath(path),
                          ),
                      ].slice(0, 10),
                  }
                : current,
        );
        void window.api.pushRecent(path).catch(() => {});
    }, []);

    useEffect(() => {
        let alive = true;
        void window.api
            .listTools()
            .then((result) => {
                if (alive) {
                    setTools(result.tools);
                }
            })
            .catch((err) =>
                toast.error(err instanceof Error ? err.message : String(err)),
            );
        void window.api
            .getSettings()
            .then((result) => {
                if (alive) {
                    setHidden(result.hiddenTools);
                    setSettings(result);
                }
            })
            .catch((err) =>
                toast.error(err instanceof Error ? err.message : String(err)),
            );
        return () => {
            alive = false;
        };
    }, [toast]);

    useEffect(() => {
        const workspaces = settings?.workspaces ?? [];
        if (
            workspaceFilter !== "all" &&
            !workspaces.some((workspace) => workspace.id === workspaceFilter)
        ) {
            setWorkspaceFilter("all");
        }
    }, [settings, workspaceFilter]);

    useEffect(() => {
        setSchema(null);
        if (
            !schemaPath ||
            (schemaLang !== "json" && schemaLang !== "jsonc") ||
            !window.api.capabilities.schemaAdvice ||
            !window.api.getSchema
        ) {
            return;
        }
        let alive = true;
        void window.api
            .getSchema(schemaPath)
            .then((info) => {
                if (alive) {
                    setSchema(info);
                }
            })
            .catch(() => {
                if (alive) {
                    setSchema(null);
                }
            });
        return () => {
            alive = false;
        };
    }, [schemaLang, schemaPath]);

    useEffect(() => {
        if (
            !window.api.capabilities.draftRecovery ||
            !window.api.listDrafts ||
            draftsRestoredRef.current
        ) {
            return;
        }
        draftsRestoredRef.current = true;
        let alive = true;
        let settled = false;
        void (async () => {
            const [toolsResult, draftsResult] = await Promise.all([
                window.api.listTools(),
                window.api.listDrafts!(),
            ]);
            if (!alive) {
                return;
            }
            setTools(toolsResult.tools);
            const restored = (
                await Promise.all(
                    draftsResult.drafts.map(async (draft) => {
                        const id = normPath(draft.path);
                        if (tabsRef.current.some((tab) => tab.id === id)) {
                            return null;
                        }
                        let match: {
                            tool: Tool;
                            file: ToolFile;
                            folderRef?: FolderContext;
                        } | null = null;
                        for (const tool of toolsResult.tools) {
                            const file = tool.files.find(
                                (candidate) => normPath(candidate.path) === id,
                            );
                            if (file) {
                                match = { tool, file };
                                break;
                            }
                            const folder = (tool.folders ?? [])
                                .filter((candidate) => {
                                    const root = normPath(candidate.path);
                                    return (
                                        id.startsWith(`${root}\\`) &&
                                        id.length > root.length + 1
                                    );
                                })
                                .toSorted(
                                    (a, b) =>
                                        normPath(b.path).length -
                                        normPath(a.path).length,
                                )[0];
                            if (folder) {
                                const relative = draft.path
                                    .slice(folder.path.length)
                                    .replace(/^[\\/]+/, "");
                                const separator = relative.lastIndexOf("\\");
                                const slashSeparator =
                                    relative.lastIndexOf("/");
                                const parentSeparator = Math.max(
                                    separator,
                                    slashSeparator,
                                );
                                const parentRelative =
                                    parentSeparator < 0
                                        ? ""
                                        : relative
                                              .slice(0, parentSeparator)
                                              .replace(/[\\/]+/g, "/");
                                const label = relative
                                    .slice(parentSeparator + 1)
                                    .replace(/[\\/]+/g, "");
                                const parentPath = parentRelative
                                    ? `${folder.path}/${parentRelative}`
                                    : folder.path;
                                match = {
                                    tool,
                                    file: {
                                        id: `${folder.id}/${relative.replace(/[\\/]+/g, "/")}`,
                                        label,
                                        path: draft.path,
                                        exists: true,
                                        lang: langFromPath(draft.path),
                                        parentPath,
                                        parentLabel:
                                            parentRelative.split("/").pop() ||
                                            folder.label,
                                    },
                                    folderRef: {
                                        tool,
                                        folder,
                                        dir: parentRelative,
                                    },
                                };
                                break;
                            }
                        }
                        if (!match) {
                            return null;
                        }
                        let disk: ReadResult;
                        try {
                            disk = await window.api.readFile(draft.path);
                        } catch {
                            return null;
                        }
                        if (draft.content === disk.content) {
                            try {
                                await window.api.deleteDraft?.(draft.path);
                            } catch {
                                // A stale clean draft is best-effort cleanup.
                            }
                            return null;
                        }
                        const revision = disk.revision ?? null;
                        const tab: OpenTab = {
                            id,
                            tool: match.tool,
                            file: match.file,
                            folderRef: match.folderRef,
                            exists: disk.exists,
                            content: disk.content,
                            size: disk.size,
                            mtime: disk.mtime,
                            revision,
                            draftBaseRevision: draft.baseRevision ?? null,
                            dirty: true,
                            external: revision !== (draft.baseRevision ?? null),
                            reloadNonce: 0,
                            diagnostics: 0,
                            warnings: 0,
                            liveContent: null,
                            draft: draft.content,
                        };
                        draftContentRef.current.set(id, draft.content);
                        dirtyIdsRef.current.add(id);
                        return tab;
                    }),
                )
            ).filter((tab): tab is OpenTab => tab !== null);
            if (!alive || restored.length === 0) {
                if (alive) {
                    settled = true;
                }
                return;
            }
            const hadWorkspace =
                tabsRef.current.length > 0 ||
                activeIdRef.current !== null ||
                selFolderRef.current !== null;
            setTabs((current) => [
                ...current,
                ...restored.filter(
                    (tab) =>
                        !current.some((existing) => existing.id === tab.id),
                ),
            ]);
            if (!hadWorkspace) {
                setFolderActive(false);
                setActiveId(restored[0]?.id ?? null);
            }
            settled = true;
            toast.info(
                `Recovered ${restored.length} unsaved draft${
                    restored.length === 1 ? "" : "s"
                }`,
            );
        })().catch((error) => {
            if (alive) {
                settled = true;
                toast.error(
                    error instanceof Error ? error.message : String(error),
                );
            }
        });
        return () => {
            alive = false;
            // StrictMode runs this effect twice in development. Releasing the
            // guard when the simulated cleanup cancels the first run lets the
            // second run restore the drafts.
            if (!settled) {
                draftsRestoredRef.current = false;
            }
        };
    }, [toast]);

    /**
     * Opens a file in a tab, reusing an existing tab for the same path.
     *
     * @param tool - The tool that owns the file.
     * @param file - The file entry to open.
     * @param folderRef - Folder context for the back button.
     * @param line - Optional line to reveal once the editor mounts.
     */
    const openFile = useCallback(
        (
            tool: Tool,
            file: ToolFile,
            folderRef?: FolderContext,
            line?: number,
        ) => {
            const id = normPath(file.path);
            const existing = tabsRef.current.find((tab) => tab.id === id);
            if (existing) {
                activateTab(existing.id);
                if (line) {
                    setReveal({ id: existing.id, line });
                }
                rememberRecent(file.path);
                return;
            }
            const request = (navigationRef.current += 1);
            void window.api
                .readFile(file.path)
                .then((result) => {
                    captureDraft();
                    const tab: OpenTab = {
                        id,
                        tool,
                        file,
                        folderRef,
                        exists: result.exists,
                        content: result.content,
                        size: result.size,
                        mtime: result.mtime,
                        revision: result.revision ?? null,
                        dirty: false,
                        external: false,
                        reloadNonce: 0,
                        diagnostics: 0,
                        warnings: 0,
                        liveContent: null,
                        draft: null,
                    };
                    setTabs((current) =>
                        current.some((candidate) => candidate.id === id)
                            ? current
                            : [...current, tab],
                    );
                    if (request === navigationRef.current) {
                        setFolderActive(false);
                        setActiveId(id);
                        if (line) {
                            setReveal({ id, line });
                        }
                    }
                    rememberRecent(file.path);
                })
                .catch((err) =>
                    toast.error(
                        err instanceof Error ? err.message : String(err),
                    ),
                );
        },
        [activateTab, captureDraft, rememberRecent, toast],
    );

    useEffect(() => {
        const off = window.api.onOpenFile((filePath) => {
            void (async () => {
                const result = await window.api.listTools();
                setTools(result.tools);
                for (const tool of result.tools) {
                    const file = tool.files.find(
                        (candidate) =>
                            normPath(candidate.path) === normPath(filePath),
                    );
                    if (file) {
                        openFile(tool, file);
                        return;
                    }
                    const folder = (tool.folders ?? []).find(
                        (candidate) =>
                            normPath(candidate.path) === normPath(filePath),
                    );
                    if (folder) {
                        captureDraft();
                        navigationRef.current += 1;
                        setSelFolder({ tool, folder, dir: "" });
                        setActiveId(null);
                        setFolderActive(true);
                        return;
                    }
                }
            })().catch((err) =>
                toast.error(err instanceof Error ? err.message : String(err)),
            );
        });
        return off;
    }, [captureDraft, openFile, toast]);

    useEffect(() => {
        if (!reveal) {
            return;
        }
        if (activeId !== reveal.id || folderActive) {
            return;
        }
        const timer = window.setTimeout(() => {
            editorRef.current?.revealLine(reveal.line);
            setReveal(null);
        }, 50);
        return () => window.clearTimeout(timer);
    }, [reveal, activeId, folderActive, tabs.length]);

    const activePath = activeTab?.file.path;
    useEffect(() => {
        if (!folderActive && activePath) {
            void window.api.watchFile(activePath).catch(() => {});
        }
    }, [activePath, folderActive]);

    const selFolderPath = selFolder?.folder.path;
    useEffect(() => {
        if (folderActive && selFolderPath) {
            void window.api.watchFolder(selFolderPath).catch(() => {});
        }
    }, [folderActive, selFolderPath]);

    useEffect(() => {
        let alive = true;
        if (!activeTab) {
            setBackupCount(null);
            setBackupsLoading(false);
            return;
        }
        setBackupCount(null);
        setBackupsLoading(true);
        void window.api
            .listBackups(activeTab.file.path)
            .then((result) => {
                if (alive) {
                    setBackupCount(result.entries.length);
                }
            })
            .catch(() => {
                if (alive) {
                    setBackupCount(null);
                }
            })
            .finally(() => {
                if (alive) {
                    setBackupsLoading(false);
                }
            });
        return () => {
            alive = false;
        };
    }, [activeTab?.id, activeTab?.revision, activeTab?.file.path]);

    /**
     * Re-reads a tab from disk, discarding its in-memory edits.
     *
     * @param tabId - The tab to reload.
     */
    const reloadTab = useCallback(
        async (tabId: string): Promise<void> => {
            const tab = tabsRef.current.find(
                (candidate) => candidate.id === tabId,
            );
            if (!tab) {
                return;
            }
            const editVersion = editVersionsRef.current.get(tabId) ?? 0;
            try {
                const result = await window.api.readFile(tab.file.path);
                const current = tabsRef.current.find(
                    (candidate) => candidate.id === tabId,
                );
                if (
                    !current ||
                    (editVersionsRef.current.get(tabId) ?? 0) !== editVersion
                ) {
                    if (current) {
                        patchTab(tabId, { external: true });
                    }
                    return;
                }
                dirtyIdsRef.current.delete(tabId);
                deleteStoredDraft(tab.file.path);
                patchTab(tabId, {
                    content: result.content,
                    exists: result.exists,
                    size: result.size,
                    mtime: result.mtime,
                    revision: result.revision ?? null,
                    draftBaseRevision: result.revision ?? null,
                    dirty: false,
                    external: false,
                    reloadNonce: tab.reloadNonce + 1,
                    diagnostics: 0,
                    warnings: 0,
                    liveContent: null,
                    draft: null,
                });
            } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
            }
        },
        [deleteStoredDraft, patchTab, toast],
    );

    // Only the active tab is watched, so a tab that changed while it was in the
    // background is refreshed when it becomes active again.
    useEffect(() => {
        if (!activeId || folderActive) {
            return;
        }
        const tab = tabsRef.current.find(
            (candidate) => candidate.id === activeId,
        );
        if (!tab) {
            return;
        }
        let alive = true;
        void window.api
            .fileStat(tab.file.path)
            .then((stats) => {
                if (!alive) {
                    return;
                }
                const current = tabsRef.current.find(
                    (candidate) => candidate.id === activeId,
                );
                if (!current) {
                    return;
                }
                if (!stats) {
                    if (!dirtyIdsRef.current.has(current.id)) {
                        void reloadTab(current.id);
                    }
                    return;
                }
                if (
                    stats.mtime === current.mtime &&
                    stats.size === current.size
                ) {
                    return;
                }
                if (dirtyIdsRef.current.has(current.id)) {
                    patchTab(current.id, { external: true });
                } else {
                    void reloadTab(current.id);
                }
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, [activeId, folderActive, patchTab, reloadTab]);

    useEffect(() => {
        const off = window.api.onFileChanged((changed) => {
            const folderSelection = selFolderRef.current;
            if (
                folderSelection &&
                normPath(changed) === normPath(folderSelection.folder.path)
            ) {
                setFolderNonce((nonce) => nonce + 1);
            }
            const tab = tabsRef.current.find(
                (candidate) =>
                    normPath(candidate.file.path) === normPath(changed),
            );
            if (!tab) {
                return;
            }
            void window.api
                .fileStat(tab.file.path)
                .then(async (stats) => {
                    if (!stats) {
                        if (!dirtyIdsRef.current.has(tab.id)) {
                            await reloadTab(tab.id);
                        }
                        return;
                    }
                    if (stats.mtime === tab.mtime && stats.size === tab.size) {
                        return;
                    }
                    if (!dirtyIdsRef.current.has(tab.id)) {
                        const expected = recentSavesRef.current.get(
                            tab.file.path,
                        );
                        if (
                            expected !== undefined &&
                            expected.until > Date.now()
                        ) {
                            try {
                                const result = await window.api.readFile(
                                    tab.file.path,
                                );
                                if (result.content === expected.content) {
                                    recentSavesRef.current.delete(
                                        tab.file.path,
                                    );
                                    return;
                                }
                            } catch {
                                // Reload below when the read fails.
                            }
                        }
                        await reloadTab(tab.id);
                    } else {
                        patchTab(tab.id, { external: true });
                    }
                })
                .catch(() => {});
        });
        return off;
    }, [patchTab, reloadTab]);

    /**
     * Saves a tab after checking its loaded revision. A stale revision opens
     * the three-way conflict dialog instead of overwriting the disk file.
     *
     * @param tabId - The tab to save, defaulting to the active tab.
     */
    const saveTab = useCallback(
        async (tabId?: string): Promise<void> => {
            const id = tabId ?? activeIdRef.current;
            const tab = tabsRef.current.find(
                (candidate) => candidate.id === id,
            );
            if (!tab || savingRef.current) {
                return;
            }
            if (!dirtyIdsRef.current.has(tab.id) && tab.exists) {
                return;
            }
            const content = editorRef.current?.getContent();
            if (content === undefined) {
                return;
            }
            const saveVersion = editVersionsRef.current.get(tab.id) ?? 0;
            savingRef.current = true;
            setSaving(true);
            try {
                const disk = await window.api.readFile(tab.file.path);
                const baseRevision =
                    tab.draftBaseRevision === undefined
                        ? tab.revision
                        : tab.draftBaseRevision;
                const revisionChanged =
                    (tab.draftBaseRevision !== undefined ||
                        baseRevision !== null) &&
                    disk.revision !== baseRevision;
                const changedOnDisk =
                    revisionChanged ||
                    (tab.exists
                        ? !disk.exists || disk.content !== tab.content
                        : disk.exists);
                if (changedOnDisk) {
                    setConflict({
                        tabId: tab.id,
                        mine: content,
                        editVersion: saveVersion,
                        disk: disk.content,
                        diskExists: disk.exists,
                        diskRevision: disk.revision ?? null,
                        diskSize: disk.size,
                        diskMtime: disk.mtime,
                        busy: false,
                    });
                    return;
                }
                const result = await window.api.writeFile(
                    tab.file.path,
                    content,
                    tab.revision,
                );
                if (result.ok) {
                    let size = new Blob([content]).size;
                    let mtime = Date.now();
                    try {
                        const stats = await window.api.fileStat(tab.file.path);
                        if (stats) {
                            size = stats.size;
                            mtime = stats.mtime;
                        }
                    } catch {
                        // Keep the local size estimate when stat fails.
                    }
                    const currentDraft = draftContentRef.current.get(tab.id);
                    const editedDuringSave =
                        (editVersionsRef.current.get(tab.id) ?? 0) !==
                            saveVersion &&
                        currentDraft !== undefined &&
                        currentDraft !== content;
                    if (!editedDuringSave) {
                        dirtyIdsRef.current.delete(tab.id);
                        draftContentRef.current.delete(tab.id);
                        deleteStoredDraft(tab.file.path);
                    }
                    recentSavesRef.current.set(tab.file.path, {
                        content,
                        until: Date.now() + 2000,
                    });
                    patchTab(tab.id, {
                        content,
                        exists: true,
                        size,
                        mtime,
                        revision: result.revision ?? tab.revision,
                        draftBaseRevision: result.revision ?? tab.revision,
                        dirty: editedDuringSave,
                        external: false,
                        liveContent: null,
                        draft: editedDuringSave ? currentDraft : null,
                    });
                    toast.success(
                        result.created
                            ? `Created ${tab.file.label}`
                            : result.backupPath
                              ? "Saved · backup created"
                              : "Saved",
                    );
                    return;
                }
                if (/changed on disk/i.test(result.error)) {
                    const latest = await window.api.readFile(tab.file.path);
                    setConflict({
                        tabId: tab.id,
                        mine: content,
                        editVersion: saveVersion,
                        disk: latest.content,
                        diskExists: latest.exists,
                        diskRevision: latest.revision ?? null,
                        diskSize: latest.size,
                        diskMtime: latest.mtime,
                        busy: false,
                    });
                    return;
                }
                toast.error(result.error);
            } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
            } finally {
                savingRef.current = false;
                setSaving(false);
            }
        },
        [deleteStoredDraft, patchTab, toast],
    );

    const formatActive = useCallback(async (): Promise<void> => {
        const id = activeIdRef.current;
        const tab = tabsRef.current.find((candidate) => candidate.id === id);
        if (!tab || formattingRef.current) {
            return;
        }
        if (tab.file.lang === "dotenv" || tab.file.lang === "text") {
            return;
        }
        const editor = editorRef.current;
        const current = editor?.getContent() ?? "";
        formattingRef.current = true;
        setFormatting(true);
        try {
            const result = await formatDocument(current, tab.file.lang);
            if (!result.ok) {
                toast.error(result.error);
                return;
            }
            if (result.content === current) {
                toast.info("Already formatted");
                return;
            }
            editor?.applyEdit(result.content);
            toast.success("Formatted - press Ctrl+S to save");
        } finally {
            formattingRef.current = false;
            setFormatting(false);
        }
    }, [toast]);

    /**
     * Closes a tab without asking about unsaved changes.
     *
     * @param id - The tab to remove.
     */
    const closeTab = useCallback(
        (id: string) => {
            const closing = tabsRef.current.find((tab) => tab.id === id);
            const remaining = tabsRef.current.filter((tab) => tab.id !== id);
            dirtyIdsRef.current.delete(id);
            if (closing) {
                deleteStoredDraft(closing.file.path);
            }
            setTabs(remaining);
            if (activeIdRef.current === id) {
                const next = remaining.at(-1);
                setActiveId(next?.id ?? null);
                if (!next) {
                    setFolderActive(selFolderRef.current !== null);
                }
            }
        },
        [deleteStoredDraft],
    );

    const requestClose = useCallback(
        (id: string) => {
            if (dirtyIdsRef.current.has(id)) {
                setConfirmClose(id);
            } else {
                closeTab(id);
            }
        },
        [closeTab],
    );

    const cycleTab = useCallback(
        (direction: number) => {
            const list = tabsRef.current;
            if (list.length < 2) {
                return;
            }
            const currentIndex = list.findIndex(
                (tab) => tab.id === activeIdRef.current,
            );
            const nextIndex =
                currentIndex < 0
                    ? 0
                    : (currentIndex + direction + list.length) % list.length;
            activateTab(list[nextIndex].id);
        },
        [activateTab],
    );

    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (!(event.ctrlKey || event.metaKey)) {
                return;
            }
            if (modal !== null) {
                return;
            }
            const key = event.key.toLowerCase();
            if (key === "s") {
                event.preventDefault();
                void saveTab();
            } else if (key === "p") {
                event.preventDefault();
                setPaletteOpen(true);
            } else if (event.shiftKey && key === "f") {
                event.preventDefault();
                void formatActive();
            } else if (key === "w") {
                const id = activeIdRef.current;
                if (id) {
                    event.preventDefault();
                    requestClose(id);
                }
            } else if (key === "tab") {
                if (tabsRef.current.length > 1) {
                    event.preventDefault();
                    cycleTab(event.shiftKey ? -1 : 1);
                }
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [cycleTab, formatActive, modal, requestClose, saveTab]);

    /**
     * Selects a tool folder and normalizes a registered subfolder to its root.
     *
     * @param tool - The tool that owns the folder.
     * @param folder - The folder to browse.
     */
    const selectFolder = useCallback(
        (tool: Tool, folder: ToolFolder) => {
            captureDraft();
            navigationRef.current += 1;
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
            setActiveId(null);
            setFolderActive(true);
        },
        [captureDraft],
    );

    const backToFolder = useCallback(() => {
        if (!activeTab?.folderRef) {
            return;
        }
        captureDraft();
        navigationRef.current += 1;
        setSelFolder(activeTab.folderRef);
        setActiveId(null);
        setFolderActive(true);
    }, [activeTab, captureDraft]);

    const toggleFavorite = useCallback(
        (tool: Tool, file: ToolFile) => {
            const key = normPath(file.path);
            const removing = favorites.includes(key);
            setFavorites((current) => {
                const next = current.includes(key)
                    ? current.filter((entry) => entry !== key)
                    : [...current, key];
                try {
                    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
                } catch {
                    // Favorites are a UI convenience; ignoring storage failure
                    // keeps the editor usable.
                }
                return next;
            });
            setFavoriteRecords((current) => {
                const next = { ...current };
                if (removing) {
                    delete next[key];
                } else {
                    next[key] = { toolId: tool.id, file };
                }
                try {
                    localStorage.setItem(
                        FAVORITE_FILES_KEY,
                        JSON.stringify(next),
                    );
                } catch {
                    // The path list remains the source of truth if metadata cannot be saved.
                }
                return next;
            });
        },
        [favorites],
    );

    const resolveConflictReload = useCallback(() => {
        if (!conflict) {
            return;
        }
        dirtyIdsRef.current.delete(conflict.tabId);
        const conflictTab = tabsRef.current.find(
            (candidate) => candidate.id === conflict.tabId,
        );
        if (conflictTab) {
            deleteStoredDraft(conflictTab.file.path);
        }
        patchTab(conflict.tabId, {
            content: conflict.disk,
            exists: conflict.diskExists,
            size: conflict.diskSize,
            mtime: conflict.diskMtime,
            revision: conflict.diskRevision,
            draftBaseRevision: conflict.diskRevision,
            dirty: false,
            external: false,
            reloadNonce:
                (tabsRef.current.find((tab) => tab.id === conflict.tabId)
                    ?.reloadNonce ?? 0) + 1,
            diagnostics: 0,
            warnings: 0,
            liveContent: null,
            draft: null,
        });
        setConflict(null);
    }, [conflict, deleteStoredDraft, patchTab]);

    const resolveConflictOverwrite = useCallback(async (): Promise<void> => {
        if (!conflict) {
            return;
        }
        const tab = tabsRef.current.find(
            (candidate) => candidate.id === conflict.tabId,
        );
        if (!tab) {
            setConflict(null);
            return;
        }
        const saveVersion = editVersionsRef.current.get(tab.id) ?? 0;
        if (saveVersion !== conflict.editVersion) {
            setConflict({
                ...conflict,
                mine: editorRef.current?.getContent() ?? conflict.mine,
                editVersion: saveVersion,
            });
            return;
        }
        setConflict({ ...conflict, busy: true });
        try {
            const result = await window.api.writeFile(
                tab.file.path,
                conflict.mine,
                conflict.diskExists ? conflict.diskRevision : null,
            );
            if (!result.ok) {
                if (/changed on disk/i.test(result.error)) {
                    const disk = await window.api.readFile(tab.file.path);
                    setConflict((current) =>
                        current
                            ? {
                                  ...current,
                                  disk: disk.content,
                                  diskExists: disk.exists,
                                  diskRevision: disk.revision ?? null,
                                  diskSize: disk.size,
                                  diskMtime: disk.mtime,
                                  busy: false,
                              }
                            : current,
                    );
                    return;
                }
                toast.error(result.error);
                setConflict((current) =>
                    current ? { ...current, busy: false } : current,
                );
                return;
            }
            let size = new Blob([conflict.mine]).size;
            let mtime = Date.now();
            try {
                const stats = await window.api.fileStat(tab.file.path);
                if (stats) {
                    size = stats.size;
                    mtime = stats.mtime;
                }
            } catch {
                // Keep the local size estimate when stat fails.
            }
            const currentDraft = draftContentRef.current.get(tab.id);
            const editedDuringSave =
                (editVersionsRef.current.get(tab.id) ?? 0) !== saveVersion &&
                currentDraft !== undefined &&
                currentDraft !== conflict.mine;
            if (!editedDuringSave) {
                dirtyIdsRef.current.delete(tab.id);
                draftContentRef.current.delete(tab.id);
                deleteStoredDraft(tab.file.path);
            }
            recentSavesRef.current.set(tab.file.path, {
                content: conflict.mine,
                until: Date.now() + 2000,
            });
            patchTab(tab.id, {
                content: conflict.mine,
                exists: true,
                size,
                mtime,
                revision: result.revision ?? tab.revision,
                draftBaseRevision: result.revision ?? tab.revision,
                dirty: editedDuringSave,
                external: false,
                liveContent: null,
                draft: editedDuringSave ? currentDraft : null,
            });
            toast.success("Saved my version");
            setConflict(null);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
            setConflict((current) =>
                current ? { ...current, busy: false } : current,
            );
        }
    }, [conflict, deleteStoredDraft, patchTab, toast]);

    const performDelete = useCallback(async (): Promise<void> => {
        const id = confirmDelete;
        setConfirmDelete(null);
        const tab = tabsRef.current.find((candidate) => candidate.id === id);
        if (!tab) {
            return;
        }
        try {
            const result = await window.api.deleteFile(tab.file.path);
            if (!result.ok) {
                toast.error(result.error ?? "Failed to delete");
                return;
            }
            toast.info(`Deleted ${tab.file.label}`);
            recentSavesRef.current.delete(tab.file.path);
            const folderRef = tab.folderRef;
            closeTab(tab.id);
            if (folderRef) {
                setSelFolder(folderRef);
                setActiveId(null);
                setFolderActive(true);
            }
            setFolderNonce((nonce) => nonce + 1);
            await refresh();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    }, [closeTab, confirmDelete, refresh, toast]);

    const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
    const workspaces = settings?.workspaces ?? [];
    const visible = useMemo(
        () =>
            tools.filter(
                (tool) =>
                    !hiddenSet.has(tool.id) &&
                    (workspaceFilter === "all" || tool.id === workspaceFilter),
            ),
        [tools, hiddenSet, workspaceFilter],
    );

    const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
    const favoriteEntries = useMemo(() => {
        const entries: { tool: Tool; file: ToolFile }[] = [];
        for (const key of favorites) {
            const owner =
                visible.find((tool) =>
                    tool.files.some((file) => normPath(file.path) === key),
                ) ??
                visible.find(
                    (tool) => tool.id === favoriteRecords[key]?.toolId,
                );
            if (!owner) {
                continue;
            }
            const file =
                owner.files.find(
                    (candidate) => normPath(candidate.path) === key,
                ) ?? favoriteRecords[key]?.file;
            if (file && favoriteSet.has(key)) {
                entries.push({ tool: owner, file });
            }
        }
        return entries;
    }, [favoriteRecords, favoriteSet, favorites, visible]);

    const recentEntries = useMemo(() => {
        const entries: { tool: Tool; file: ToolFile }[] = [];
        for (const path of settings?.recentFiles ?? []) {
            const key = normPath(path);
            for (const tool of tools) {
                const file = tool.files.find(
                    (candidate) => normPath(candidate.path) === key,
                );
                if (file) {
                    entries.push({ tool, file });
                    break;
                }
            }
        }
        return entries.slice(0, 5);
    }, [settings, tools]);

    const paletteFiles = useMemo(
        () =>
            tools
                .filter((tool) => !hiddenSet.has(tool.id))
                .flatMap((tool) => tool.files.map((file) => ({ tool, file })))
                .toSorted((a, b) => {
                    const aFavorite = favoriteSet.has(normPath(a.file.path));
                    const bFavorite = favoriteSet.has(normPath(b.file.path));
                    if (aFavorite !== bFavorite) {
                        return aFavorite ? -1 : 1;
                    }
                    return `${a.tool.name}/${a.file.label}`.localeCompare(
                        `${b.tool.name}/${b.file.label}`,
                    );
                }),
        [tools, hiddenSet, favoriteSet],
    );

    const toggleTheme = useCallback(() => {
        const next: ThemeMode = mode === "dark" ? "light" : "dark";
        void window.api
            .setTheme(next)
            .then((saved) => setSettings(saved))
            .catch((err) =>
                toast.error(err instanceof Error ? err.message : String(err)),
            );
    }, [mode, toast]);

    const changeView = useCallback((view: NavView) => {
        setNavView(view);
        setFilter("");
    }, []);

    const mcpFiles = useMemo(
        () =>
            visible.flatMap((tool) =>
                tool.files.filter(isMcpFile).map((file) => ({ tool, file })),
            ),
        [visible],
    );
    const libraryFiles = useMemo(
        () =>
            visible.flatMap((tool) =>
                tool.files
                    .filter(isLibraryFile)
                    .map((file) => ({ tool, file })),
            ),
        [visible],
    );
    const libraryFolders = useMemo(
        () =>
            visible.flatMap((tool) =>
                (tool.folders ?? [])
                    .filter(isLibraryFolder)
                    .map((folder) => ({ tool, folder })),
            ),
        [visible],
    );

    const paletteCommands = useMemo<PaletteCommand[]>(() => {
        const tab = activeTab;
        return [
            {
                id: "save",
                label: "Save active file",
                hint: "Ctrl+S",
                run: () => void saveTab(),
            },
            {
                id: "format",
                label: "Format active file",
                hint: "Ctrl+Shift+F",
                run: () => void formatActive(),
            },
            {
                id: "reload",
                label: "Reload active file from disk",
                run: () => {
                    if (tab) {
                        void reloadTab(tab.id);
                    }
                },
            },
            {
                id: "history",
                label: "Open backup history",
                run: () => {
                    if (tab) {
                        setModal("history");
                    }
                },
            },
            {
                id: "favorite",
                label:
                    tab && favoriteSet.has(tab.id)
                        ? "Remove active file from favorites"
                        : "Add active file to favorites",
                run: () => {
                    if (tab) {
                        toggleFavorite(tab.tool, tab.file);
                    }
                },
            },
            {
                id: "inspector",
                label: inspectorOpen ? "Hide inspector" : "Show inspector",
                run: () => setInspectorOpen((open) => !open),
            },
            {
                id: "sidebar",
                label: sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar",
                run: () => setSidebarCollapsed((collapsed) => !collapsed),
            },
            {
                id: "view-configs",
                label: "Show configurations",
                run: () => changeView("configs"),
            },
            {
                id: "view-mcp",
                label: "Show MCP servers",
                run: () => changeView("mcp"),
            },
            {
                id: "view-library",
                label: "Show library",
                run: () => changeView("library"),
            },
            {
                id: "theme",
                label: `Switch to ${mode === "dark" ? "light" : "dark"} theme`,
                run: toggleTheme,
            },
            {
                id: "settings",
                label: "Open settings",
                run: () => setModal("settings"),
            },
        ];
    }, [
        activeTab,
        changeView,
        favoriteSet,
        formatActive,
        inspectorOpen,
        mode,
        reloadTab,
        saveTab,
        sidebarCollapsed,
        toggleFavorite,
        toggleTheme,
    ]);

    const tabInfos: TabInfo[] = tabs.map((tab) => ({
        id: tab.id,
        label: tab.file.label,
        path: tab.file.path,
        dirty: tab.dirty,
        external: tab.external,
    }));

    const iconBtn =
        "no-drag rounded-lg p-2 text-secondary transition-colors hover:bg-raised hover:text-primary disabled:pointer-events-none disabled:opacity-30";

    return (
        <div className="flex h-screen flex-col">
            <header className="drag-region flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 select-none">
                <img
                    src={logoUrl}
                    alt="app logo"
                    className="size-4 shrink-0 rounded"
                />
                <span className="hidden text-xs font-semibold tracking-wide text-primary sm:inline">
                    Maestro
                </span>
                {window.api.capabilities.workspaces &&
                    workspaces.length > 0 && (
                        <label className="no-drag ml-2 flex items-center gap-1.5 rounded-lg border border-line bg-app px-2 py-1">
                            <FolderGit2 size={12} className="text-accent" />
                            <select
                                value={workspaceFilter}
                                onChange={(event) =>
                                    setWorkspaceFilter(event.target.value)
                                }
                                className="max-w-40 bg-transparent text-[11px] text-primary outline-none"
                                title="Filter configurations by workspace"
                            >
                                <option value="all">All configurations</option>
                                {workspaces.map((workspace) => (
                                    <option
                                        key={workspace.id}
                                        value={workspace.id}
                                    >
                                        {workspace.name}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={() => setPaletteOpen(true)}
                    title="Search files and commands"
                    className="no-drag flex items-center gap-2 rounded-lg border border-line bg-app px-2.5 py-1.5 text-[11px] text-faint transition-colors hover:border-line2 hover:text-secondary"
                >
                    <Search size={12} />
                    <span className="hidden sm:inline">Search configs</span>
                    <kbd className="hidden rounded border border-line px-1 text-[9px] sm:inline">
                        Ctrl P
                    </kbd>
                </button>
                <button
                    type="button"
                    title="Toggle inspector"
                    aria-pressed={inspectorOpen}
                    onClick={() => setInspectorOpen((open) => !open)}
                    className={`${iconBtn} ${inspectorOpen ? "text-accent" : ""}`}
                >
                    <PanelRight size={15} />
                </button>
                <ThemeSwitch />
                <button
                    type="button"
                    title="Settings"
                    onClick={() => setModal("settings")}
                    className={iconBtn}
                >
                    <Settings2 size={15} />
                </button>
                <div className="drag-region titlebar-spacer w-34 shrink-0" />
            </header>

            <div className="flex min-h-0 flex-1">
                <Sidebar
                    tools={visible}
                    favorites={favoriteEntries}
                    selectedId={
                        folderActive ? null : (activeTab?.file.id ?? null)
                    }
                    selectedFolderId={
                        folderActive && selFolder ? selFolder.folder.id : null
                    }
                    onSelect={(tool, file) => openFile(tool, file)}
                    onSelectFolder={(tool, folder) =>
                        selectFolder(tool, folder)
                    }
                    onManage={() => setModal("settings")}
                    collapsed={sidebarCollapsed}
                    onToggle={() => setSidebarCollapsed((c) => !c)}
                    filter={filter}
                    onFilterChange={setFilter}
                    view={navView}
                    onViewChange={changeView}
                />

                <main className="flex min-w-0 flex-1 flex-col bg-app">
                    {tabs.length > 0 && (
                        <TabBar
                            tabs={tabInfos}
                            activeId={folderActive ? null : activeId}
                            onSelect={activateTab}
                            onClose={requestClose}
                        />
                    )}

                    <div className="flex min-h-0 flex-1">
                        <div
                            className={`min-h-0 min-w-0 flex-1 ${
                                folderActive ? "hidden" : "flex"
                            }`}
                        >
                            {!folderActive && activeTab && (
                                <div
                                    data-active="true"
                                    className="flex min-h-0 min-w-0 flex-1"
                                >
                                    <div className="flex min-w-0 flex-1 flex-col">
                                        <EditorPane
                                            key={`${activeTab.id}:${activeTab.reloadNonce}`}
                                            ref={editorRef}
                                            lang={activeTab.file.lang}
                                            mode={mode}
                                            softWrap={
                                                settings?.softWrap ?? true
                                            }
                                            initialContent={
                                                activeTab.draft ??
                                                activeTab.content
                                            }
                                            reloadKey={`${activeTab.id}:${activeTab.reloadNonce}`}
                                            onDirty={() =>
                                                markTabDirty(activeTab.id)
                                            }
                                            onSave={() =>
                                                void saveTab(activeTab.id)
                                            }
                                            onFormat={() => void formatActive()}
                                            formatting={formatting}
                                            onChange={(content) =>
                                                handleEditorChange(
                                                    activeTab.id,
                                                    content,
                                                )
                                            }
                                            onDiagnostics={(summary) =>
                                                patchTab(activeTab.id, {
                                                    diagnostics: summary.errors,
                                                    warnings: summary.warnings,
                                                })
                                            }
                                            unsaved={activeTab.dirty}
                                            filePath={activeTab.file.path}
                                            parentLabel={
                                                activeTab.file.parentLabel
                                            }
                                            onBack={
                                                activeTab.folderRef
                                                    ? backToFolder
                                                    : undefined
                                            }
                                            fileExists={activeTab.exists}
                                            fileSecret={activeTab.file.secret}
                                            fileNote={activeTab.file.note}
                                            externalChange={activeTab.external}
                                            fileSize={activeTab.size}
                                            fileMtime={activeTab.mtime}
                                            onHistoryClick={() =>
                                                setModal("history")
                                            }
                                            onReloadClick={() =>
                                                void reloadTab(activeTab.id)
                                            }
                                            onDelete={() =>
                                                setConfirmDelete(activeTab.id)
                                            }
                                            isFavorite={favoriteSet.has(
                                                activeTab.id,
                                            )}
                                            onToggleFavorite={() =>
                                                toggleFavorite(
                                                    activeTab.tool,
                                                    activeTab.file,
                                                )
                                            }
                                            restartHint={
                                                activeTab.file.note
                                                    ? /reload|restart/i.test(
                                                          activeTab.file.note,
                                                      )
                                                    : false
                                            }
                                            schemaKeys={schema?.keys ?? []}
                                            checkAdvice={
                                                window.api.capabilities
                                                    .schemaAdvice &&
                                                checkConfig &&
                                                (activeTab.file.lang ===
                                                    "json" ||
                                                    activeTab.file.lang ===
                                                        "jsonc")
                                                    ? (content) =>
                                                          checkConfig(
                                                              activeTab.file
                                                                  .path,
                                                              content,
                                                          ).then(
                                                              (result) =>
                                                                  result.warnings,
                                                          )
                                                    : undefined
                                            }
                                        />
                                    </div>
                                    {activeTab.file.lang === "markdown" && (
                                        <>
                                            <div className="w-px shrink-0 bg-line" />
                                            <PreviewPane
                                                content={
                                                    activeTab.liveContent ??
                                                    activeTab.draft ??
                                                    activeTab.content
                                                }
                                                lang={activeTab.file.lang}
                                            />
                                        </>
                                    )}
                                </div>
                            )}
                            {!folderActive &&
                                !activeTab &&
                                navView !== "configs" && (
                                    <ViewLanding
                                        view={navView}
                                        files={
                                            navView === "mcp"
                                                ? mcpFiles
                                                : libraryFiles
                                        }
                                        folders={
                                            navView === "library"
                                                ? libraryFolders
                                                : []
                                        }
                                        onOpenFile={openFile}
                                        onOpenFolder={selectFolder}
                                        onSearch={() => setPaletteOpen(true)}
                                        onSettings={() => setModal("settings")}
                                    />
                                )}
                            {!folderActive &&
                                !activeTab &&
                                navView === "configs" && (
                                    <div className="grid flex-1 place-items-center overflow-y-auto p-8">
                                        <div className="w-full max-w-md">
                                            <div className="text-center">
                                                <FileCog
                                                    size={44}
                                                    className="mx-auto text-line2"
                                                    strokeWidth={1.25}
                                                />
                                                <p className="mt-4 text-sm font-medium text-secondary">
                                                    Select a config file or
                                                    folder to manage
                                                </p>
                                                <p className="mt-1 text-xs text-faint">
                                                    {visible.length} tools
                                                    detected · snapshots
                                                    encrypted at rest
                                                </p>
                                                <div className="mt-4 flex justify-center gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            setPaletteOpen(true)
                                                        }
                                                        className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-accent2"
                                                    >
                                                        <Search size={13} />
                                                        Search configs
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            setModal("settings")
                                                        }
                                                        className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3.5 py-2 text-xs text-secondary transition-colors hover:bg-raised hover:text-primary"
                                                    >
                                                        <Settings2 size={13} />
                                                        Manage tools
                                                    </button>
                                                </div>
                                            </div>
                                            {recentEntries.length > 0 && (
                                                <div className="mt-8">
                                                    <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-faint uppercase">
                                                        <Clock3 size={11} />
                                                        Recent work
                                                    </p>
                                                    <ul className="space-y-1">
                                                        {recentEntries.map(
                                                            ({
                                                                tool,
                                                                file,
                                                            }) => (
                                                                <li
                                                                    key={
                                                                        file.path
                                                                    }
                                                                >
                                                                    <button
                                                                        type="button"
                                                                        onClick={() =>
                                                                            openFile(
                                                                                tool,
                                                                                file,
                                                                            )
                                                                        }
                                                                        className="flex w-full items-center gap-2 rounded-xl border border-line px-3 py-2 text-left transition-colors hover:bg-raised"
                                                                    >
                                                                        <span className="truncate text-xs text-primary">
                                                                            {
                                                                                file.label
                                                                            }
                                                                        </span>
                                                                        <span className="ml-auto shrink-0 text-[10px] text-faint">
                                                                            {
                                                                                tool.name
                                                                            }
                                                                        </span>
                                                                    </button>
                                                                </li>
                                                            ),
                                                        )}
                                                    </ul>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                        </div>

                        {folderActive && selFolder && (
                            <FolderView
                                key={`${selFolder.folder.path}:${selFolder.dir}`}
                                folder={selFolder.folder}
                                reloadKey={folderNonce}
                                initialDir={selFolder.dir}
                                onOpenFile={(file, dir) =>
                                    openFile(selFolder.tool, file, {
                                        tool: selFolder.tool,
                                        folder: selFolder.folder,
                                        dir,
                                    })
                                }
                                onMutated={() => void refresh()}
                                onDeleted={() => {
                                    setSelFolder(null);
                                    setFolderActive(false);
                                    setFolderNonce((nonce) => nonce + 1);
                                    void refresh();
                                }}
                            />
                        )}

                        {inspectorOpen && !folderActive && activeTab && (
                            <InspectorPanel
                                label={activeTab.file.label}
                                path={activeTab.file.path}
                                toolName={activeTab.tool.name}
                                lang={activeTab.file.lang}
                                exists={activeTab.exists}
                                dirty={activeTab.dirty}
                                external={activeTab.external}
                                size={activeTab.size}
                                mtime={activeTab.mtime}
                                revision={activeTab.revision}
                                diagnostics={activeTab.diagnostics}
                                warnings={activeTab.warnings}
                                scope={
                                    activeTab.tool.group === "workspace"
                                        ? "Workspace"
                                        : "Global"
                                }
                                backupCount={backupCount}
                                backupsLoading={backupsLoading}
                                onOpenHistory={() => setModal("history")}
                                onReload={() => void reloadTab(activeTab.id)}
                                onClose={() => setInspectorOpen(false)}
                            />
                        )}
                    </div>
                </main>
            </div>

            {paletteOpen && (
                <CommandPalette
                    files={paletteFiles}
                    commands={paletteCommands}
                    searchEnabled={window.api.capabilities.search}
                    onOpenFile={(tool, file, line) =>
                        openFile(tool, file, undefined, line)
                    }
                    onClose={() => setPaletteOpen(false)}
                />
            )}

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
                        activeTab && (
                            <HistoryModal
                                file={activeTab.file}
                                getCurrent={() =>
                                    editorRef.current?.getContent() ??
                                    activeTab.draft ??
                                    activeTab.content
                                }
                                onLoadIntoEditor={(content) => {
                                    setModal(null);
                                    if (content === activeTab.content) {
                                        toast.info(
                                            "That backup matches the current file",
                                        );
                                        return;
                                    }
                                    editorRef.current?.applyEdit(content);
                                    markTabDirty(activeTab.id);
                                    patchTab(activeTab.id, {
                                        liveContent: content,
                                    });
                                }}
                                onRestored={() => void reloadTab(activeTab.id)}
                                onClose={() => setModal(null)}
                            />
                        )
                    )}
                </Suspense>
            )}

            {conflict && activeTab && conflict.tabId === activeTab.id && (
                <ConflictDialog
                    label={activeTab.file.label}
                    base={activeTab.content}
                    mine={conflict.mine}
                    disk={conflict.disk}
                    busy={conflict.busy || saving}
                    onReload={resolveConflictReload}
                    onOverwrite={() => void resolveConflictOverwrite()}
                    onClose={() => setConflict(null)}
                />
            )}

            {confirmClose && (
                <ConfirmDialog
                    title="Close unsaved tab"
                    message="This tab has unsaved changes. Closing it discards them."
                    confirmLabel="Discard and close"
                    onConfirm={() => {
                        closeTab(confirmClose);
                        setConfirmClose(null);
                    }}
                    onCancel={() => setConfirmClose(null)}
                />
            )}

            {confirmDelete && (
                <ConfirmDialog
                    title="Delete file"
                    message={`Delete "${
                        tabs.find((tab) => tab.id === confirmDelete)?.file
                            .label ?? "this file"
                    }"? It will be sent to the Recycle Bin.`}
                    onConfirm={() => void performDelete()}
                    onCancel={() => setConfirmDelete(null)}
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
