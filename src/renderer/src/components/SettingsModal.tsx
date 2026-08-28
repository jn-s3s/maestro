import { useEffect, useState, type JSX } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { AppSettings, Tool } from "../../../shared/types";
import { useToast } from "./useToast";

interface Props {
    tools: Tool[];
    hidden: string[];
    onClose: () => void;
    onChanged: () => Promise<void>;
}

/**
 * Modal to toggle behavior, hide tools and register custom config files.
 *
 * @param tools - The current tool registry.
 * @param hidden - IDs of the hidden tools.
 * @param onClose - Closes the modal.
 * @param onChanged - Refresh hook fired after any change.
 */
export default function SettingsModal({
    tools,
    hidden,
    onClose,
    onChanged,
}: Props): JSX.Element {
    const toast = useToast();
    const [hiddenSet, setHiddenSet] = useState<Set<string>>(new Set(hidden));
    const [closeToTray, setCloseToTray] = useState(false);
    const [name, setName] = useState("");
    const [path, setPath] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void window.api
            .getSettings()
            .then((s: AppSettings) => setCloseToTray(s.closeToTray))
            .catch((err) =>
                toast.error(err instanceof Error ? err.message : String(err)),
            );
    }, [toast]);

    const toggleHidden = async (id: string): Promise<void> => {
        const next = new Set(hiddenSet);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setHiddenSet(next);
        try {
            await window.api.setHidden([...next]);
            await onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const toggleTray = async (): Promise<void> => {
        const next = !closeToTray;
        setCloseToTray(next);
        try {
            await window.api.setCloseToTray(next);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const addCustom = async (): Promise<void> => {
        setError(null);
        try {
            const res = await window.api.addCustom(name, path);
            if (!res.ok) {
                setError(res.error ?? "Failed to add");
                return;
            }
            setName("");
            setPath("");
            await onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    const removeCustom = async (id: string): Promise<void> => {
        try {
            await window.api.removeCustom(id);
            await onChanged();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm"
            onMouseDown={onClose}
        >
            <div
                className="flex max-h-[82vh] w-150 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
                    <h2 className="text-sm font-semibold text-primary">
                        Settings
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg p-1 text-faint transition-colors hover:bg-raised hover:text-primary"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
                    <section>
                        <p className="mb-2 text-xs font-medium text-secondary">
                            Behavior
                        </p>
                        <label className="flex cursor-pointer items-center justify-between rounded-xl border border-line px-3.5 py-3 transition-colors hover:bg-raised">
                            <span>
                                <span className="block text-sm text-primary">
                                    Minimize to tray
                                </span>
                                <span className="block text-xs text-faint">
                                    Closing the window keeps the app running in
                                    the tray
                                </span>
                            </span>
                            <input
                                type="checkbox"
                                className="size-4 accent-accent"
                                checked={closeToTray}
                                onChange={() => void toggleTray()}
                            />
                        </label>
                    </section>

                    <section className="border-t border-line pt-4">
                        <p className="mb-2 text-xs font-medium text-secondary">
                            Visible tools
                        </p>
                        <ul className="space-y-1">
                            {tools.map((tool) => (
                                <li
                                    key={tool.id}
                                    className="flex items-center justify-between rounded-xl px-3 py-2 transition-colors hover:bg-raised"
                                >
                                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                                        <input
                                            type="checkbox"
                                            className="size-4 accent-accent"
                                            checked={!hiddenSet.has(tool.id)}
                                            onChange={() =>
                                                void toggleHidden(tool.id)
                                            }
                                        />
                                        <span className="min-w-0">
                                            <span className="block truncate text-sm text-primary">
                                                {tool.name}
                                            </span>
                                            {tool.subtitle && (
                                                <span className="block truncate text-xs text-faint">
                                                    {tool.subtitle}
                                                </span>
                                            )}
                                        </span>
                                    </label>
                                    {tool.group === "custom" && (
                                        <button
                                            type="button"
                                            title="Remove custom entry"
                                            className="rounded-lg p-1.5 text-faint transition-colors hover:bg-rose-500/10 hover:text-rose-500"
                                            onClick={() =>
                                                void removeCustom(tool.id)
                                            }
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>

                    <section className="border-t border-line pt-4">
                        <p className="mb-2 text-xs font-medium text-secondary">
                            Add config file
                        </p>
                        <p className="mb-2.5 text-xs text-faint">
                            Point at any other config file or a whole folder
                            (absolute path) - folders become browsable like the
                            built-in ones.
                        </p>
                        <div className="space-y-2">
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Display name (e.g. Cursor MCP)"
                                className="w-full rounded-xl border border-line bg-app px-3 py-2 text-sm text-primary outline-none transition-colors placeholder:text-faint focus:border-accent"
                            />
                            <input
                                value={path}
                                onChange={(e) => setPath(e.target.value)}
                                spellCheck={false}
                                placeholder="C:\Users\you\.some-tool\config.json"
                                className="w-full rounded-xl border border-line bg-app px-3 py-2 font-mono text-xs text-primary outline-none transition-colors placeholder:text-faint focus:border-accent"
                            />
                            {error && (
                                <p className="text-xs text-rose-500">{error}</p>
                            )}
                            <button
                                type="button"
                                onClick={() => void addCustom()}
                                disabled={!name.trim() || !path.trim()}
                                className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-accent2 disabled:pointer-events-none disabled:opacity-40"
                            >
                                <Plus size={13} />
                                Add config file
                            </button>
                        </div>
                    </section>
                </div>

                <div className="flex justify-end border-t border-line px-5 py-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-xl bg-raised px-4 py-2 text-sm text-primary transition-colors hover:bg-line"
                    >
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}
