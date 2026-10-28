import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    root: path.resolve("src/app"),
    plugins: [react(), tailwindcss()],
    server: { host: "127.0.0.1", port: 1420, strictPort: true },
    build: {
        outDir: path.resolve("out/app"),
        emptyOutDir: true,
    },
});
