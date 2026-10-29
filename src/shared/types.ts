export type FileLang =
    | "json"
    | "jsonc"
    | "yaml"
    | "toml"
    | "markdown"
    | "dotenv"
    | "javascript"
    | "typescript"
    | "python"
    | "shell"
    | "text";

/**
 * A multi-root directory entry, identifying the section a root belongs to.
 */
export interface ToolRoot {
    path: string; // absolute directory path
    section: string; // section name this root belongs to, e.g. "Config" | "Data"
    label?: string; // optional folder-row label; defaults to section
}

/**
 * Discovery state of a registered file. Older backends omit `state`, so the
 * renderer falls back to `exists`.
 */
export type DiscoveryState =
    "available" | "missing" | "unreadable" | "unsupported";

export interface ToolFile {
    id: string;
    label: string;
    path: string;
    exists: boolean;
    state?: DiscoveryState;
    lang: FileLang;
    parentPath?: string;
    parentLabel?: string;
    secret?: boolean;
    note?: string;
    section?: string;
}

export interface ToolFolder {
    id: string;
    label: string;
    path: string;
    exists: boolean;
    section?: string;
}

export interface DirEntry {
    name: string;
    path: string;
    rel: string;
    isDir: boolean;
    mtime: number;
    size: number;
}

export type ToolGroup = "workspace" | "cli" | "editor" | "ext" | "custom";

export interface Tool {
    id: string;
    name: string;
    group: ToolGroup;
    subtitle?: string;
    roots?: ToolRoot[];
    files: ToolFile[];
    folders?: ToolFolder[];
}

export interface CustomEntry {
    id: string;
    name: string;
    path: string;
}

export type ThemeMode = "system" | "light" | "dark";

export interface Workspace {
    id: string;
    name: string;
    path: string;
}

export interface AppSettings {
    version: number;
    theme: ThemeMode;
    closeToTray: boolean;
    softWrap: boolean;
    historyResetDone: boolean;
    perFileHistoryResetDone: boolean;
    secretBackupsEncrypted: boolean;
    hiddenTools: string[];
    recentFiles: string[];
    custom: CustomEntry[];
    historyLimit?: number;
    workspaces?: Workspace[];
}

export interface ReadResult {
    exists: boolean;
    content: string;
    size: number;
    mtime: number;
    revision?: string | null;
}

export type WriteResult =
    | {
          ok: true;
          created: boolean;
          backupPath: string | null;
          revision?: string;
      }
    | { ok: false; error: string };

export interface OpResult {
    ok: boolean;
    error?: string;
}

export interface BackupEntry {
    file: string;
    path: string;
    mtime: number;
    size: number;
    name?: string | null;
    pinned?: boolean;
}

export interface FileStat {
    size: number;
    mtime: number;
}

export interface SearchHit {
    path: string;
    label: string;
    line: number;
    preview: string;
}

export type SchemaScope = "root" | "server";

export interface SchemaKey {
    name: string;
    detail: string;
    scope: SchemaScope;
}

export interface SchemaInfo {
    id: string;
    label: string;
    keys: SchemaKey[];
}

export interface ConfigWarning {
    key?: string | null;
    message: string;
}

export interface RecoveredDraft {
    path: string;
    content: string;
    baseRevision?: string | null;
    savedAt: number;
}

/**
 * Availability of the Maestro 1 data root and the result of the last import.
 */
export interface LegacyStatus {
    available: boolean;
    source: string;
    alreadyImported: boolean;
    lastImportedAt?: number | null;
}

/**
 * Counts returned by one explicit import from the Maestro 1 data root.
 */
export interface LegacyImportResult {
    settings: AppSettings;
    settingsImported: boolean;
    snapshotsImported: number;
    snapshotsExisting: number;
    snapshotsSkipped: number;
    filesMatched: number;
    unmatchedFolders: number;
    warnings: string[];
}

/**
 * Optional backend surfaces. The Electron build reports all false and the
 * renderer hides the matching controls instead of calling missing commands.
 */
export interface ApiCapabilities {
    workspaces: boolean;
    search: boolean;
    snapshotMeta: boolean;
    historyLimit: boolean;
    schemaAdvice: boolean;
    draftRecovery: boolean;
    legacyImport: boolean;
}

/**
 * Maps a file path to the language used by the editor.
 *
 * @param filePath - The file path to inspect.
 * @returns The inferred language label for the path.
 */
export function langFromPath(filePath: string): FileLang {
    const base = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    const ext = base.includes(".") ? `.${base.split(".").pop()}` : "";
    if (base.startsWith(".env")) {
        return "dotenv";
    }
    switch (ext) {
        case ".json":
            return "json";
        case ".jsonc":
            return "jsonc";
        case ".yml":
        case ".yaml":
            return "yaml";
        case ".toml":
            return "toml";
        case ".md":
        case ".markdown":
            return "markdown";
        case ".js":
        case ".jsx":
        case ".mjs":
        case ".cjs":
            return "javascript";
        case ".ts":
        case ".tsx":
        case ".mts":
        case ".cts":
            return "typescript";
        case ".py":
            return "python";
        case ".sh":
        case ".bash":
        case ".zsh":
        case ".fish":
            return "shell";
        default:
            return "text";
    }
}

export interface Api {
    capabilities: ApiCapabilities;
    listTools(): Promise<{ tools: Tool[] }>;
    readFile(path: string): Promise<ReadResult>;
    writeFile(
        path: string,
        content: string,
        expectedRevision?: string | null,
    ): Promise<WriteResult>;
    reveal(path: string): Promise<void>;
    openFile(path: string): Promise<OpResult>;
    openExternal(url: string): Promise<void>;
    getSettings(): Promise<AppSettings>;
    setHidden(toolIds: string[]): Promise<AppSettings>;
    setTheme(mode: ThemeMode): Promise<AppSettings>;
    setCloseToTray(value: boolean): Promise<AppSettings>;
    setSoftWrap(value: boolean): Promise<AppSettings>;
    legacyStatus?(): Promise<LegacyStatus>;
    importLegacy?(): Promise<LegacyImportResult>;
    addCustom(name: string, path: string): Promise<OpResult>;
    removeCustom(id: string): Promise<AppSettings>;
    addWorkspace?(name: string, path: string): Promise<OpResult>;
    removeWorkspace?(id: string): Promise<AppSettings>;
    setHistoryLimit?(limit: number): Promise<AppSettings>;
    searchFiles?(query: string, limit?: number): Promise<{ hits: SearchHit[] }>;
    setSnapshotMeta?(
        backupPath: string,
        name: string | null,
        pinned: boolean,
    ): Promise<OpResult>;
    getSchema?(path: string): Promise<SchemaInfo | null>;
    checkConfig?(
        path: string,
        content: string,
    ): Promise<{ warnings: ConfigWarning[] }>;
    saveDraft?(
        path: string,
        content: string,
        baseRevision?: string | null,
    ): Promise<OpResult>;
    listDrafts?(): Promise<{ drafts: RecoveredDraft[] }>;
    deleteDraft?(path: string): Promise<OpResult>;
    pushRecent(path: string): Promise<void>;
    listBackups(filePath: string): Promise<{ entries: BackupEntry[] }>;
    readBackup(backupPath: string): Promise<{ content: string }>;
    deleteBackup(backupPath: string): Promise<OpResult>;
    clearBackups(filePath: string): Promise<OpResult>;
    watchFile(path: string): Promise<void>;
    watchFolder(path: string): Promise<void>;
    fileStat(path: string): Promise<FileStat | null>;
    onFileChanged(cb: (path: string) => void): () => void;
    listFolder(path: string): Promise<{ entries: DirEntry[]; exists: boolean }>;
    createFileIn(folderPath: string, name: string): Promise<OpResult>;
    createFolderIn(folderPath: string, name: string): Promise<OpResult>;
    deleteFile(path: string): Promise<OpResult>;
    deleteFolder(path: string): Promise<OpResult>;
    renameFile(path: string, newName: string): Promise<OpResult>;
    renameFolder(path: string, newName: string): Promise<OpResult>;
    onThemeChanged(cb: (dark: boolean) => void): () => void;
    onOpenFile(cb: (path: string) => void): () => void;
}
