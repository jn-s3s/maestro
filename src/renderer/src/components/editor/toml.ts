import { StreamLanguage } from "@codemirror/language";

/**
 * Lightweight TOML syntax for the CodeMirror stream parser.
 * Covers keys, strings (basic + literal), numbers, booleans, dates, comments and punctuation.
 *
 * @returns A CodeMirror language support for TOML.
 */
export function toml(): ReturnType<typeof StreamLanguage.define> {
    return StreamLanguage.define({
        name: "toml",
        token(stream) {
            if (stream.eatSpace()) return null;
            if (stream.sol()) {
                if (stream.match(/\[[^\]]*\]/)) return "meta";
            }
            if (stream.match(/^[ \t]*#.*/)) return "lineComment";
            if (stream.match(/^"(\\.|[^"\\])*"/)) return "string";
            if (stream.match(/^'(\\.|[^'\\])*'/)) return "string";
            if (stream.match(/^[\w-]+(?=\s*=)/)) return "propertyName";
            if (stream.match(/^(true|false)\b/)) return "bool";
            if (
                stream.match(
                    /^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?/,
                )
            ) {
                return "number";
            }
            if (stream.match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/)) return "number";
            if (stream.match(/^[{}[\],=]/)) return "punctuation";
            stream.next();
            return null;
        },
        languageData: {
            commentTokens: { line: "#" },
            closeBrackets: { brackets: ["[", "{", '"', "'"] },
        },
    });
}
