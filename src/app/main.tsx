import "@fontsource-variable/inter";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../renderer/src/App";
import "../renderer/src/assets/main.css";
import { installTauriBridge } from "./bridge";

async function start(): Promise<void> {
    const host = document.getElementById("root");
    if (!host) {
        throw new Error("Application root is missing");
    }
    const root = createRoot(host);
    try {
        const initialDark = await installTauriBridge();
        document.documentElement.classList.toggle("dark", initialDark);
        root.render(
            <StrictMode>
                <App initialDark={initialDark} />
            </StrictMode>,
        );
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        root.render(
            <main className="grid h-screen place-items-center bg-app px-6 text-center">
                <div className="max-w-md">
                    <h1 className="text-lg font-semibold text-primary">
                        Maestro could not start
                    </h1>
                    <p
                        role="alert"
                        className="mt-2 text-sm leading-relaxed text-secondary"
                    >
                        {detail}
                    </p>
                </div>
            </main>,
        );
    }
}

void start();
