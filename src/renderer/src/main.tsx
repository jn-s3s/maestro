import "@fontsource-variable/inter";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./assets/main.css";

const params = new URLSearchParams(window.location.search);
const initialDark = params.get("theme") !== "light";
document.documentElement.classList.toggle("dark", initialDark);

createRoot(document.getElementById("root")!).render(
    <App initialDark={initialDark} />,
);
