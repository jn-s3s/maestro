import { useEffect, useState, type JSX, type ReactNode } from "react";
import { ThemeCtx, type Resolved } from "./theme-context";

interface Props {
    initial: Resolved;
    children: ReactNode;
}

/**
 * Tracks and applies the current theme to the document root.
 *
 * @param initial - The starting theme.
 * @param children - The subtree to wrap.
 */
export function ThemeProvider({ initial, children }: Props): JSX.Element {
    const [mode, setMode] = useState<Resolved>(initial);

    useEffect(
        () =>
            window.api.onThemeChanged((dark) => {
                setMode(dark ? "dark" : "light");
            }),
        [],
    );

    useEffect(() => {
        document.documentElement.classList.toggle("dark", mode === "dark");
    }, [mode]);

    return <ThemeCtx.Provider value={mode}>{children}</ThemeCtx.Provider>;
}
