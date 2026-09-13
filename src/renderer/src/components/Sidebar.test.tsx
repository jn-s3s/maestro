import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import Sidebar from "./Sidebar";

describe("Sidebar empty state", () => {
    it("renders onboarding text when no tools are detected", () => {
        render(
            <Sidebar
                tools={[]}
                selectedId={null}
                selectedFolderId={null}
                onSelect={() => {}}
                onSelectFolder={() => {}}
                onManage={() => {}}
                collapsed={false}
                onToggle={() => {}}
            />,
        );

        expect(screen.getByTestId("sidebar-tool-count")).toHaveTextContent(
            "0 tools",
        );
        expect(screen.getByTestId("sidebar-empty")).toBeInTheDocument();
    });
});
