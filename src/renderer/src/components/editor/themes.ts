import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * Reads the current value of a CSS custom property from the document root.
 *
 * @param name - The CSS variable name (with leading dashes).
 * @param fallback - The value returned when the variable is not set.
 * @returns The trimmed variable value, or the fallback.
 */
function readCssVar(name: string, fallback: string): string {
    if (typeof document === "undefined") return fallback;
    const raw = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
    return raw || fallback;
}

/**
 * Converts a hex color into an rgba() string with the given alpha.
 *
 * @param hex - The 3 or 6 digit hex color (with or without leading "#").
 * @param alpha - The alpha channel between 0 and 1.
 * @returns The rgba() representation, or the input on parse failure.
 */
function withAlpha(hex: string, alpha: number): string {
    let h = hex.trim();
    if (h.startsWith("#")) h = h.slice(1);
    if (h.length === 3) {
        h = h
            .split("")
            .map((c) => c + c)
            .join("");
    }
    if (h.length !== 6) return hex;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Builds a CodeMirror chrome theme that reads colors from CSS custom properties.
 *
 * @param accent - The accent color used for caret, selection, active line and matching brackets.
 * @param isDark - Whether the host UI is currently in dark mode.
 * @returns The CodeMirror theme extension.
 */
function chromeTheme(accent: string, isDark: boolean): Extension {
    const line = readCssVar("--line", isDark ? "#232329" : "#e4e4e7");
    const surface = readCssVar("--surface", isDark ? "#111113" : "#ffffff");
    const txt2 = readCssVar("--txt2", isDark ? "#a1a1aa" : "#52525b");
    const app = readCssVar("--app", isDark ? "#09090b" : "#fafafa");
    const gutterTint = isDark
        ? withAlpha(txt2, 0.04)
        : withAlpha(txt2, 0.06);
    const activeLine = withAlpha(accent, isDark ? 0.12 : 0.07);
    const selection = withAlpha(accent, isDark ? 0.28 : 0.2);
    const selectionInactive = withAlpha(accent, isDark ? 0.18 : 0.12);
    const matchBg = withAlpha(accent, isDark ? 0.32 : 0.18);
    return EditorView.theme(
        {
            "&": {
                height: "100%",
                fontSize: "13px",
                backgroundColor: "transparent",
                color: "inherit",
            },
            ".cm-content": {
                caretColor: accent,
                fontFamily:
                    'ui-monospace, "Cascadia Code", Consolas, monospace',
            },
            ".cm-scroller": {
                lineHeight: "1.55",
                fontFamily: "inherit",
            },
            "&.cm-focused .cm-cursor, .cm-cursor": {
                borderLeftColor: accent,
                borderLeftWidth: "2px",
            },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground":
                {
                    backgroundColor: selection,
                },
            "&:not(.cm-focused) .cm-selectionBackground": {
                backgroundColor: selectionInactive,
            },
            "&.cm-focused ::selection": {
                backgroundColor: selection,
            },
            ".cm-activeLine": {
                backgroundColor: activeLine,
            },
            ".cm-activeLineGutter": {
                backgroundColor: activeLine,
                color: "inherit",
            },
            ".cm-gutters": {
                backgroundColor: gutterTint,
                color: txt2,
                border: "none",
                borderRight: `1px solid ${line}`,
            },
            ".cm-foldPlaceholder": {
                backgroundColor: surface,
                color: txt2,
                border: `1px solid ${line}`,
                borderRadius: "4px",
                padding: "0 4px",
            },
            ".cm-matchingBracket, .cm-nonmatchingBracket": {
                backgroundColor: matchBg,
                outline: `1px solid ${accent}`,
                borderRadius: "2px",
            },
            ".cm-searchMatch": {
                backgroundColor: matchBg,
                outline: `1px solid ${accent}`,
                borderRadius: "2px",
            },
            ".cm-searchMatch.cm-searchMatch-selected": {
                backgroundColor: withAlpha(accent, isDark ? 0.45 : 0.3),
            },
            ".cm-panels": {
                backgroundColor: surface,
                color: "inherit",
            },
            ".cm-panels.cm-panels-top": {
                borderBottom: `1px solid ${line}`,
            },
            ".cm-panels.cm-panels-bottom": {
                borderTop: `1px solid ${line}`,
            },
            ".cm-tooltip": {
                backgroundColor: surface,
                color: "inherit",
                border: `1px solid ${line}`,
                borderRadius: "6px",
            },
            ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
                backgroundColor: withAlpha(accent, isDark ? 0.28 : 0.18),
                color: "inherit",
            },
            ".cm-scroller::-webkit-scrollbar-track": {
                backgroundColor: app,
            },
        },
        { dark: isDark },
    );
}

const basePalette = {
    light: {
        keyword: "#7c3aed",
        string: "#15803d",
        number: "#b45309",
        bool: "#b45309",
        atom: "#b45309",
        property: "#0e7490",
        variable: "#1f2937",
        comment: "#a1a1aa",
        punctuation: "#52525b",
        heading: "#7c3aed",
        link: "#0e7490",
        emphasis: "#7c3aed",
        strong: "#1f2937",
        meta: "#71717a",
        invalid: "#b91c1c",
        escape: "#be185d",
    },
    dark: {
        keyword: "#a78bfa",
        string: "#86efac",
        number: "#fcd34d",
        bool: "#fcd34d",
        atom: "#fcd34d",
        property: "#67e8f9",
        variable: "#e4e4e7",
        comment: "#6d6d76",
        punctuation: "#a1a1aa",
        heading: "#a78bfa",
        link: "#67e8f9",
        emphasis: "#a78bfa",
        strong: "#fafafa",
        meta: "#9ca3af",
        invalid: "#fca5a5",
        escape: "#f0abfc",
    },
} as const;

/**
 * Builds the highlight style for one of the two resolved UI modes.
 *
 * @param isDark - Whether the host UI is in dark mode.
 * @returns A CodeMirror HighlightStyle instance scoped to that mode.
 */
function highlightFor(isDark: boolean): HighlightStyle {
    const p = isDark ? basePalette.dark : basePalette.light;
    return HighlightStyle.define([
        { tag: t.keyword, color: p.keyword, fontWeight: "600" },
        { tag: [t.string, t.special(t.string)], color: p.string },
        { tag: t.number, color: p.number },
        { tag: [t.bool, t.atom, t.null], color: p.bool },
        { tag: t.propertyName, color: p.property },
        {
            tag: [t.variableName, t.attributeName],
            color: p.variable,
        },
        {
            tag: t.comment,
            color: p.comment,
            fontStyle: "italic",
        },
        { tag: [t.punctuation, t.bracket, t.operator], color: p.punctuation },
        { tag: t.heading, color: p.heading, fontWeight: "700" },
        { tag: t.link, color: p.link, textDecoration: "underline" },
        { tag: t.emphasis, color: p.emphasis, fontStyle: "italic" },
        { tag: t.strong, color: p.strong, fontWeight: "700" },
        { tag: t.meta, color: p.meta },
        { tag: t.invalid, color: p.invalid, textDecoration: "underline wavy" },
        { tag: t.escape, color: p.escape },
    ]);
}

/**
 * Returns the full editor theme (chrome + syntax highlighting) for a given mode.
 *
 * @param mode - The resolved UI mode to render against.
 * @param accent - Optional override for the accent color; defaults to the app's --color-accent token.
 * @returns The combined CodeMirror extensions for that mode.
 */
export function editorTheme(
    mode: "light" | "dark",
    accent?: string,
): Extension[] {
    const isDark = mode === "dark";
    const resolvedAccent = (
        accent ?? readCssVar("--color-accent", "#8b5cf6")
    ).trim();
    return [
        chromeTheme(resolvedAccent || "#8b5cf6", isDark),
        syntaxHighlighting(highlightFor(isDark)),
    ];
}
