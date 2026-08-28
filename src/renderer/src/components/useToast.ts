import { createContext, useContext } from "react";

export type Kind = "success" | "error" | "info";

export interface ToastApi {
    success: (msg: string) => void;
    error: (msg: string) => void;
    info: (msg: string) => void;
}

export const ToastCtx = createContext<ToastApi>({
    success: () => {},
    error: () => {},
    info: () => {},
});

/**
 * Returns the toast API for the current provider context.
 *
 * @returns The toast helper methods.
 */
export function useToast(): ToastApi {
    return useContext(ToastCtx);
}
