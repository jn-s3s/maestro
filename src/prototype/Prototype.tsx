import { useEffect, useRef, useState, type ReactElement } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Save, RotateCcw, PanelBottomClose, FlaskConical } from "lucide-react";
import FixtureEditor from "./FixtureEditor";

interface Document {
    content: string;
    revision: string;
}

const actionClass =
    "inline-flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm font-medium hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40";
const desktopRuntime = isTauri();

export default function Prototype(): ReactElement {
    const busy = useRef(false);
    const [document, setDocument] = useState<Document | null>(null);
    const [draft, setDraft] = useState("");
    const [pending, setPending] = useState(false);
    const [status, setStatus] = useState(
        desktopRuntime
            ? "Opening synthetic fixture..."
            : "Desktop runtime required",
    );
    const [error, setError] = useState<string | null>(
        desktopRuntime
            ? null
            : "Open this workbench with pnpm prototype:dev. Browser preview has no filesystem bridge.",
    );
    const [discard, setDiscard] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const dirty = document !== null && draft !== document.content;

    useEffect(() => {
        let active = true;
        if (!desktopRuntime) {
            return;
        }
        void invoke<Document>("read_fixture")
            .then((loaded) => {
                if (active) {
                    setDocument(loaded);
                    setDraft(loaded.content);
                    setStatus(
                        "Ready. Only this disposable fixture can be edited.",
                    );
                }
            })
            .catch((cause: unknown) => {
                if (active) {
                    setError(String(cause));
                    setStatus("Could not open fixture");
                }
            });
        return () => {
            active = false;
        };
    }, []);

    async function save(): Promise<void> {
        if (!document || busy.current || !dirty) {
            return;
        }
        busy.current = true;
        setPending(true);
        setError(null);
        const content = draft;
        try {
            const saved = await invoke<Document>("save_fixture", {
                content,
                expectedRevision: document.revision,
            });
            setDocument(saved);
            setDraft(saved.content);
            setStatus("Saved to the synthetic fixture on disk.");
        } catch (cause) {
            setError(String(cause));
            setStatus("Save failed. Your draft is still in the editor.");
        } finally {
            busy.current = false;
            setPending(false);
        }
    }

    async function reload(): Promise<void> {
        if (busy.current) {
            return;
        }
        busy.current = true;
        setPending(true);
        setError(null);
        setDiscard(false);
        try {
            const loaded = await invoke<Document>("read_fixture");
            setDocument(loaded);
            setDraft(loaded.content);
            setReloadKey((key) => key + 1);
            setStatus("Reloaded the saved fixture from disk.");
        } catch (cause) {
            setError(String(cause));
        } finally {
            busy.current = false;
            setPending(false);
        }
    }

    async function hide(): Promise<void> {
        try {
            await invoke("hide_to_tray");
        } catch (cause) {
            setError(String(cause));
        }
    }

    return (
        <main className="flex h-screen flex-col bg-app text-primary">
            <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-5">
                <div>
                    <p className="mb-1 font-mono text-xs tracking-widest text-accent">
                        MAESTRO / ENGINEERING PREVIEW
                    </p>
                    <h1 className="text-xl font-semibold tracking-tight">
                        Configuration workbench.
                    </h1>
                </div>
                <span className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 font-mono text-xs text-secondary">
                    <FlaskConical size={14} /> PHASE 01
                </span>
            </header>
            <section className="flex min-h-0 flex-1 flex-col">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-6 py-3">
                    <div className="font-mono text-sm">
                        fixture.json{" "}
                        <span className="ml-3 text-xs text-secondary">
                            {dirty ? "Unsaved changes" : "Saved"}
                        </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            className={actionClass}
                            disabled={!document || pending}
                            onClick={() => {
                                if (dirty) {
                                    setDiscard(true);
                                } else {
                                    void reload();
                                }
                            }}
                        >
                            <RotateCcw size={15} /> Reload
                        </button>
                        <button
                            type="button"
                            className={actionClass}
                            disabled={!document || pending || !dirty}
                            onClick={() => {
                                void save();
                            }}
                        >
                            <Save size={15} />{" "}
                            {pending ? "Working..." : "Save fixture"}
                        </button>
                        <button
                            type="button"
                            className={actionClass}
                            disabled={!document || pending}
                            onClick={() => {
                                void hide();
                            }}
                        >
                            <PanelBottomClose size={15} /> Hide to tray
                        </button>
                    </div>
                </div>
                {discard && (
                    <div
                        role="alert"
                        className="flex items-center justify-between gap-3 border-b border-line px-6 py-3 text-sm"
                    >
                        <span>Discard unsaved changes and reload?</span>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                className={actionClass}
                                onClick={() => {
                                    setDiscard(false);
                                }}
                            >
                                Keep editing
                            </button>
                            <button
                                type="button"
                                className={actionClass}
                                onClick={() => {
                                    void reload();
                                }}
                            >
                                Discard and reload
                            </button>
                        </div>
                    </div>
                )}
                {error && (
                    <p
                        role="alert"
                        className="border-b border-line px-6 py-3 text-sm text-red-700 dark:text-red-300"
                    >
                        {error}
                    </p>
                )}
                <div className="min-h-0 flex-1" inert={pending}>
                    {document && (
                        <FixtureEditor
                            content={document.content}
                            reloadKey={reloadKey}
                            onChange={setDraft}
                            onSave={() => {
                                void save();
                            }}
                        />
                    )}
                </div>
            </section>
            <footer className="border-t border-line bg-surface px-6 py-4">
                <p role="status" className="text-sm">
                    {status}
                </p>
                <p className="mt-1 text-xs text-secondary">
                    Rust + Tauri 2 + CodeMirror. Close hides to tray; use its
                    menu to reopen or quit. Quitting removes the fixture. Real
                    configurations and Maestro history are never opened.
                </p>
            </footer>
        </main>
    );
}
