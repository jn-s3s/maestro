import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "../renderer/src/components/ErrorBoundary";
import Prototype from "./Prototype";
import "../renderer/src/assets/main.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <ErrorBoundary>
            <Prototype />
        </ErrorBoundary>
    </StrictMode>,
);
