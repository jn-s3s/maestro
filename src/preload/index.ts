import { contextBridge, ipcRenderer } from "electron";
import type { Api } from "../shared/types";

/**
 * Subscribes a renderer-side callback to an IPC push channel.
 *
 * @param channel - The IPC channel to listen on.
 * @param cb - The payload handler.
 * @returns A teardown function that removes the listener.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, payload: T): void =>
        cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
        ipcRenderer.removeListener(channel, listener);
    };
}

const api: Api = {
    listTools: () => ipcRenderer.invoke("tools:list"),
    readFile: (filePath) => ipcRenderer.invoke("file:read", filePath),
    writeFile: (filePath, content) =>
        ipcRenderer.invoke("file:write", filePath, content),
    reveal: (filePath) => ipcRenderer.invoke("shell:reveal", filePath),
    openExternal: (filePath) => ipcRenderer.invoke("shell:open", filePath),
    getSettings: () => ipcRenderer.invoke("settings:get"),
    setHidden: (toolIds) => ipcRenderer.invoke("settings:hidden", toolIds),
    setTheme: (mode) => ipcRenderer.invoke("settings:theme", mode),
    setCloseToTray: (value) =>
        ipcRenderer.invoke("settings:closeToTray", value),
    addCustom: (name, filePath) =>
        ipcRenderer.invoke("custom:add", name, filePath),
    removeCustom: (id) => ipcRenderer.invoke("custom:remove", id),
    pushRecent: (filePath) => ipcRenderer.invoke("recent:push", filePath),
    listBackups: (filePath) => ipcRenderer.invoke("backups:list", filePath),
    readBackup: (backupPath) => ipcRenderer.invoke("backups:read", backupPath),
    deleteBackup: (backupPath) =>
        ipcRenderer.invoke("backups:delete", backupPath),
    clearBackups: (filePath) => ipcRenderer.invoke("backups:clear", filePath),
    watchFile: (filePath) => ipcRenderer.invoke("watch:file", filePath),
    watchFolder: (folderPath) => ipcRenderer.invoke("watch:folder", folderPath),
    fileStat: (filePath) => ipcRenderer.invoke("file:stat", filePath),
    listFolder: (folderPath) => ipcRenderer.invoke("folder:list", folderPath),
    createFileIn: (folderPath, name) =>
        ipcRenderer.invoke("folder:create-file", folderPath, name),
    deleteFile: (filePath) => ipcRenderer.invoke("file:delete", filePath),
    deleteFolder: (folderPath) =>
        ipcRenderer.invoke("folder:delete", folderPath),
    onFileChanged: (cb) => subscribe("fs:changed", cb),
    onThemeChanged: (cb) => subscribe("theme:changed", cb),
    onOpenFile: (cb) => subscribe("fs:open", cb),
};

contextBridge.exposeInMainWorld("api", api);
