import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import PreviewPane from "./PreviewPane";

afterEach(() => {
    cleanup();
    // PreviewPane reads the global bridge directly; remove the test double
    // so it cannot leak into other suites.
    delete (window as unknown as { api?: unknown }).api;
});

describe("PreviewPane component", () => {
    it("is a valid React component", () => {
        expect(PreviewPane).toBeDefined();
        expect(typeof PreviewPane).toBe("function");
    });

    it("accepts required props", () => {
        const props = {
            content: "test content",
            lang: "markdown" as const,
        };

        expect(props.lang).toBe("markdown");
        expect(props.content).toBe("test content");
    });

    it("renders markdown heading content", () => {
        render(<PreviewPane content="# Hello World" lang="markdown" />);
        expect(screen.getByText("Hello World")).toBeInTheDocument();
    });

    it("renders markdown paragraph content", () => {
        const { container } = render(
            <PreviewPane
                content={"This is a paragraph with **bold** text."}
                lang="markdown"
            />,
        );
        // Text is split across multiple DOM nodes by react-markdown
        expect(container.textContent).toContain("This is a paragraph with");
        expect(container.textContent).toContain("bold");
        expect(container.textContent).toContain("text.");
    });

    it("renders markdown lists", () => {
        render(
            <PreviewPane
                content={"- Item 1\n- Item 2\n- Item 3"}
                lang="markdown"
            />,
        );
        expect(screen.getByText("Item 1")).toBeInTheDocument();
        expect(screen.getByText("Item 2")).toBeInTheDocument();
        expect(screen.getByText("Item 3")).toBeInTheDocument();
    });

    it("handles empty content", () => {
        const { container } = render(
            <PreviewPane content="" lang="markdown" />,
        );
        expect(
            container.querySelector(".markdown-preview"),
        ).toBeInTheDocument();
    });

    it("renders non-markdown content through the markdown renderer", () => {
        const { container } = render(
            <PreviewPane content={"key: value"} lang="yaml" />,
        );

        expect(container.textContent).toContain("key: value");
    });

    it("renders JSON content as text", () => {
        const { container } = render(
            <PreviewPane content={'{"key": "value"}'} lang="json" />,
        );

        expect(container.textContent).toContain("value");
    });

    it("opens external markdown links through the IPC bridge", () => {
        const openExternal = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(window, "api", {
            value: { openExternal },
            configurable: true,
        });

        render(
            <PreviewPane
                content={"[docs](https://example.com/guide)"}
                lang="markdown"
            />,
        );

        const link = screen.getByRole("link", { name: "docs" });
        fireEvent.click(link);

        expect(openExternal).toHaveBeenCalledWith("https://example.com/guide");
    });

    it("keeps in-page anchors as native links", () => {
        const openExternal = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(window, "api", {
            value: { openExternal },
            configurable: true,
        });

        render(<PreviewPane content={"[jump](#section)"} lang="markdown" />);

        expect(screen.getByRole("link", { name: "jump" })).toHaveAttribute(
            "href",
            "#section",
        );
        expect(openExternal).not.toHaveBeenCalled();
    });
});
