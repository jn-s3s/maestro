import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ComponentProps } from "react";

// Mock CodeMirror and heavy dependencies so the UI can render in jsdom
vi.mock("@codemirror/view", () => {
    class EditorView {
        constructor(public opts: unknown) {}
        dispatch() {}
        destroy() {}
        getStateField() {
            return { doc: { text: "test" } };
        }
        get() {
            return {
                doc: { text: "test" },
                selection: { main: { from: 0, to: 0 } },
            };
        }
        static updateListener = { of: () => ({}) };
        static lineWrapping = Symbol("lineWrapping");
    }
    return { EditorView, keymap: { of: () => [] } };
});

vi.mock("@codemirror/state", () => ({
    Compartment: class {
        of() {
            return {};
        }
    },
    EditorState: class {
        static create() {
            return { doc: { text: "test" }, field() {} };
        }
    },
    Prec: {
        high: (ext: unknown) => ext,
        keymap: (ext: unknown) => ext,
        near: (ext: unknown) => ext,
        low: (ext: unknown) => ext,
    },
}));

vi.mock("codemirror", () => ({
    basicSetup: [],
}));

vi.mock("@codemirror/lang-json", () => ({
    json: () => [],
}));

vi.mock("@shopify/lang-jsonc", () => ({
    jsonc: () => [],
}));

vi.mock("@codemirror/lang-yaml", () => ({
    yaml: () => [],
}));

vi.mock("@codemirror/lang-markdown", () => ({
    markdown: () => [],
}));

vi.mock("./editor/themes", () => ({
    editorTheme: () => [],
}));

vi.mock("./editor/toml", () => ({
    toml: () => [],
}));

vi.mock("./useToast", () => ({
    useToast: () => ({
        success: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
    }),
}));

vi.mock("lucide-react", () => {
    const icons: Record<string, unknown> = {};
    const names = [
        "ChevronLeft",
        "ExternalLink",
        "FolderOpen",
        "History",
        "Loader2",
        "RefreshCw",
        "RotateCcw",
        "Save",
        "Trash2",
        "TriangleAlert",
        "Info",
        "Wand",
    ];
    for (const name of names) {
        icons[name] = () => null;
    }
    return icons;
});

import EditorPane from "./EditorPane";

type EditorPaneProps = ComponentProps<typeof EditorPane>;

const baseProps: EditorPaneProps = {
    lang: "json",
    mode: "light",
    softWrap: true,
    initialContent: "{}",
    reloadKey: "1",
    onDirty: vi.fn(),
    onSave: vi.fn(),
    unsaved: false,
    fileExists: true,
};

describe("EditorPane component", () => {
    it("is a valid React component", () => {
        expect(EditorPane).toBeDefined();
        // forwardRef components are objects with $$typeof
        expect(typeof EditorPane).toBe("object");
        expect(EditorPane.displayName).toBe("EditorPane");
    });

    it("accepts required props", () => {
        // Compile-time check: the component type accepts the expected props
        const props: EditorPaneProps = {
            lang: "json",
            mode: "light",
            softWrap: true,
            initialContent: "{}",
            reloadKey: "1",
            onDirty: vi.fn(),
            onSave: vi.fn(),
            unsaved: false,
            fileExists: true,
        };

        expect(props.lang).toBe("json");
        expect(props.mode).toBe("light");
    });

    it("accepts optional props", () => {
        const props: EditorPaneProps = {
            lang: "yaml",
            mode: "dark",
            softWrap: false,
            initialContent: "key: value",
            reloadKey: "2",
            onDirty: vi.fn(),
            onSave: vi.fn(),
            unsaved: true,
            fileExists: false,
            fileSecret: true,
            fileNote: "Note",
            externalChange: true,
            fileSize: 2048,
            fileMtime: Date.now(),
            onFormat: vi.fn(),
            formatting: false,
            parentLabel: "Config",
            parentPath: "/path",
            filePath: "/path/file.yaml",
            onBack: vi.fn(),
            onHistoryClick: vi.fn(),
            onReloadClick: vi.fn(),
            onDelete: vi.fn(),
        };

        expect(props.lang).toBe("yaml");
        expect(props.fileSecret).toBe(true);
    });

    it("renders the editor container and status bar", () => {
        render(<EditorPane {...baseProps} />);

        // Query stable test ids so style-only refactors do not break the suite
        expect(screen.getByTestId("editor-host")).toBeInTheDocument();
        expect(screen.getByTestId("editor-statusbar")).toBeInTheDocument();
        expect(screen.getByText("JSON")).toBeInTheDocument();
    });

    it("shows save button as disabled when there are no unsaved changes", () => {
        const onSave = vi.fn();
        render(<EditorPane {...baseProps} unsaved={false} onSave={onSave} />);

        const saveBtn = screen.getByText("Save");
        expect(saveBtn).toBeDisabled();
    });

    it("shows save button as enabled when there are unsaved changes", () => {
        const onSave = vi.fn();
        render(<EditorPane {...baseProps} unsaved={true} onSave={onSave} />);

        const saveBtn = screen.getByText("Save");
        expect(saveBtn).not.toBeDisabled();
    });

    it("calls onSave when save button is clicked", () => {
        const onSave = vi.fn();
        render(<EditorPane {...baseProps} unsaved={true} onSave={onSave} />);

        const saveBtn = screen.getByText("Save");
        fireEvent.click(saveBtn);
        expect(onSave).toHaveBeenCalledTimes(1);
    });

    it("renders secret file banner when fileSecret is true", () => {
        render(<EditorPane {...baseProps} fileSecret={true} />);

        expect(
            screen.getByText(/Contains secrets\/tokens/i),
        ).toBeInTheDocument();
    });

    it("renders file-not-found banner when fileExists is false", () => {
        render(<EditorPane {...baseProps} fileExists={false} />);

        expect(
            screen.getByText(/File does not exist yet/i),
        ).toBeInTheDocument();
    });

    it("renders external change banner when externalChange is true", () => {
        render(<EditorPane {...baseProps} externalChange={true} />);

        expect(screen.getByText(/File changed on disk/i)).toBeInTheDocument();
    });

    it("renders file note when fileNote is provided", () => {
        render(
            <EditorPane {...baseProps} fileNote={"This is a custom note"} />,
        );

        expect(screen.getByText("This is a custom note")).toBeInTheDocument();
    });

    it("shows unsaved changes indicator in status bar", () => {
        render(<EditorPane {...baseProps} unsaved={true} />);

        expect(screen.getByText("unsaved changes")).toBeInTheDocument();
    });

    it("shows saved indicator in status bar when no unsaved changes", () => {
        render(<EditorPane {...baseProps} unsaved={false} />);

        expect(screen.getByText("saved")).toBeInTheDocument();
    });
});
