import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

/**
 * Relaxes the renderer CSP for the Vite dev server only so the HMR
 * websocket to localhost stays allowed. The packaged build serves the
 * strict policy baked into index.html unchanged.
 *
 * @returns The Vite plugin performing the dev-only HTML rewrite.
 */
function devCspRelax(): Plugin {
    return {
        name: "maestro-dev-csp-relax",
        transformIndexHtml: {
            order: "pre",
            handler(html, ctx) {
                if (!ctx.server) return html;
                return html.replace(
                    "connect-src 'self'",
                    "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
                );
            },
        },
    };
}

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
    },
    renderer: {
        plugins: [react(), tailwindcss(), devCspRelax()],
    },
});
