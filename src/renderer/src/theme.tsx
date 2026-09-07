import {
    useEffect,
    useLayoutEffect,
    useState,
    type JSX,
    type ReactNode,
} from "react";
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

    useEffect(() => {
        return window.api.onThemeChanged((dark) => {
            setMode(dark ? "dark" : "light");
        });
    }, []);

    // Layout effect so the root class flips before paint and before any
    // child's passive effect reads theme CSS variables; children effects run
    // before parent effects, so a passive toggle here would race them.
    useLayoutEffect(() => {
        document.documentElement.classList.toggle("dark", mode === "dark");
    }, [mode]);

    return <ThemeCtx.Provider value={mode}>{children}</ThemeCtx.Provider>;
}
