import type { JSX } from "react";
import { X } from "lucide-react";

export interface TabInfo {
    id: string;
    label: string;
    path: string;
    dirty: boolean;
    external: boolean;
}

interface Props {
    tabs: TabInfo[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
}

/**
 * Horizontal tab strip for open configuration files.
 *
 * @param tabs - The open tabs in display order.
 * @param activeId - The active tab id, or null while browsing a folder.
 * @param onSelect - Activates a tab.
 * @param onClose - Requests closing a tab.
 */
export default function TabBar({
    tabs,
    activeId,
    onSelect,
    onClose,
}: Props): JSX.Element {
    return (
        <div
            role="tablist"
            aria-label="Open configuration files"
            className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-surface"
        >
            {tabs.map((tab) => {
                const active = tab.id === activeId;
                return (
                    <div
                        key={tab.id}
                        className={`group flex max-w-56 min-w-28 shrink-0 items-stretch border-r border-line ${
                            active ? "bg-app" : "bg-surface hover:bg-raised"
                        }`}
                    >
                        <button
                            type="button"
                            role="tab"
                            aria-selected={active}
                            title={tab.path}
                            onClick={() => onSelect(tab.id)}
                            onAuxClick={(event) => {
                                if (event.button === 1) {
                                    event.preventDefault();
                                    onClose(tab.id);
                                }
                            }}
                            className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                                active
                                    ? "border-b-2 border-accent font-medium text-primary"
                                    : "text-secondary"
                            }`}
                        >
                            {(tab.dirty || tab.external) && (
                                <span
                                    className={`size-1.5 shrink-0 rounded-full ${
                                        tab.external
                                            ? "bg-sky-500"
                                            : "bg-amber-500"
                                    }`}
                                />
                            )}
                            <span className="truncate">{tab.label}</span>
                        </button>
                        <button
                            type="button"
                            title="Close tab"
                            aria-label={`Close ${tab.label}`}
                            onClick={() => onClose(tab.id)}
                            className="my-1.5 mr-1 rounded p-0.5 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-raised hover:text-primary focus:opacity-100"
                        >
                            <X size={12} />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
