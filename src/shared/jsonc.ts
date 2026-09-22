/**
 * Removes line and block comments from a JSONC string.
 *
 * @param src - The raw JSONC source.
 * @returns The source with comments removed, strings preserved.
 */
export function stripJsonComments(src: string): string {
    let out = "";
    let i = 0;
    let inStr = false;
    let inLine = false;
    let inBlock = false;
    while (i < src.length) {
        const ch = src[i];
        const next = src[i + 1];
        if (inLine) {
            if (ch === "\n") {
                inLine = false;
                out += ch;
            }
            i++;
            continue;
        }
        if (inBlock) {
            if (ch === "*" && next === "/") {
                inBlock = false;
                i += 2;
            } else {
                i++;
            }
            continue;
        }
        if (inStr) {
            out += ch;
            if (ch === "\\") {
                out += next ?? "";
                i += 2;
                continue;
            }
            if (ch === '"') {
                inStr = false;
            }
            i++;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === "/" && next === "/") {
            inLine = true;
            i += 2;
            continue;
        }
        if (ch === "/" && next === "*") {
            inBlock = true;
            i += 2;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

/**
 * Removes trailing commas that precede a closing brace or bracket.
 *
 * @param src - The raw source text.
 * @returns The source with trailing commas removed.
 */
export function stripTrailingCommas(src: string): string {
    let out = "";
    let i = 0;
    let inStr = false;
    while (i < src.length) {
        const ch = src[i];
        if (inStr) {
            out += ch;
            if (ch === "\\") {
                out += src[i + 1] ?? "";
                i += 2;
                continue;
            }
            if (ch === '"') {
                inStr = false;
            }
            i++;
            continue;
        }
        if (ch === '"') {
            inStr = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === ",") {
            let j = i + 1;
            while (j < src.length && /\s/.test(src[j])) {
                j++;
            }
            if (src[j] === "}" || src[j] === "]") {
                i++;
                continue;
            }
        }
        out += ch;
        i++;
    }
    return out;
}

/**
 * Prepares JSONC source for JSON parsing by stripping comments and trailing commas.
 *
 * @param src - The raw JSONC source.
 * @returns The source reduced to plain JSON.
 */
export function prepareJsoncForFormat(src: string): string {
    return stripTrailingCommas(stripJsonComments(src));
}
