import { createContext, useContext } from "react";

export type Kind = "success" | "error" | "info";

/**
 * Public surface for dispatching toast notifications.
 */
export interface ToastApi {
    success: (msg: string) => void;
    error: (msg: string) => void;
    info: (msg: string) => void;
}

const missingProviderWarn = (kind: string, msg: string): void => {
    console.warn(`[Toast] ${kind} called outside ToastProvider: ${msg}`);
};

export const ToastCtx = createContext<ToastApi>({
    success: (msg) => missingProviderWarn("success", msg),
    error: (msg) => missingProviderWarn("error", msg),
    info: (msg) => missingProviderWarn("info", msg),
});

/**
 * Returns the toast API for the current provider context.
 *
 * @returns The toast helper methods.
 */
export function useToast(): ToastApi {
    return useContext(ToastCtx);
}
