import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
    test: {
        projects: [
            {
                extends: true,
                test: {
                    name: "main",
                    environment: "node",
                    include: ["src/main/**/*.test.ts"],
                    globals: true,
                },
            },
            {
                extends: true,
                test: {
                    name: "renderer",
                    environment: "jsdom",
                    include: ["src/renderer/**/*.test.tsx"],
                    globals: true,
                    setupFiles: ["./vitest.setup.ts"],
                },
            },
        ],
    },
    plugins: [react()],
});
