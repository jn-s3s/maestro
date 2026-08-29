export type FileLang =
    | "json"
    | "jsonc"
    | "yaml"
    | "toml"
    | "markdown"
    | "dotenv"
    | "text";

export interface ToolFile {
    id: string;
    label: string;
    path: string;
    exists: boolean;
    lang: FileLang;
    parentPath?: string;
    parentLabel?: string;
    secret?: boolean;
    note?: string;
}

export interface ToolFolder {
    id: string;
    label: string;
    path: string;
    exists: boolean;
}

export interface DirEntry {
    name: string;
    path: string;
    rel: string;
    isDir: boolean;
    mtime: number;
    size: number;
}

export type ToolGroup = "cli" | "editor" | "ext" | "custom";

export interface Tool {
    id: string;
    name: string;
    group: ToolGroup;
    subtitle?: string;
    rootPath?: string;
    files: ToolFile[];
    folders?: ToolFolder[];
}

export interface CustomEntry {
    id: string;
    name: string;
    path: string;
}

export type ThemeMode = "system" | "light" | "dark";

export interface AppSettings {
    version: number;
    theme: ThemeMode;
    closeToTray: boolean;
    historyResetDone: boolean;
    perFileHistoryResetDone: boolean;
    hiddenTools: string[];
    recentFiles: string[];
    custom: CustomEntry[];
}

export interface ReadResult {
    exists: boolean;
    content: string;
    size: number;
    mtime: number;
}

export type WriteResult =
    | { ok: true; created: boolean; backupPath: string | null }
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
}

export interface FileStat {
    size: number;
    mtime: number;
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
    if (base.startsWith(".env")) return "dotenv";
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
        default:
            return "text";
    }
}

export interface Api {
    listTools(): Promise<{ tools: Tool[] }>;
    readFile(path: string): Promise<ReadResult>;
    writeFile(path: string, content: string): Promise<WriteResult>;
    reveal(path: string): Promise<void>;
    openExternal(path: string): Promise<OpResult>;
    getSettings(): Promise<AppSettings>;
    setHidden(toolIds: string[]): Promise<AppSettings>;
    setTheme(mode: ThemeMode): Promise<AppSettings>;
    setCloseToTray(value: boolean): Promise<AppSettings>;
    addCustom(name: string, path: string): Promise<OpResult>;
    removeCustom(id: string): Promise<AppSettings>;
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
