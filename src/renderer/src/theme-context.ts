import { createContext, useContext } from "react";

export type Resolved = "light" | "dark";

export const ThemeCtx = createContext<Resolved>("dark");

/**
 * Returns the resolved light or dark theme.
 *
 * @returns The resolved theme name.
 */
export function useThemeMode(): Resolved {
    return useContext(ThemeCtx);
}
