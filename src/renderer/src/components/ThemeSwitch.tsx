import { useEffect, useState, type JSX } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import type { ThemeMode } from "../../../shared/types";

const OPTIONS: { id: ThemeMode; icon: typeof Sun; label: string }[] = [
    { id: "light", icon: Sun, label: "Light" },
    { id: "system", icon: Monitor, label: "System" },
    { id: "dark", icon: Moon, label: "Dark" },
];

/**
 * Segmented control that switches between light, system and dark themes.
 */
export default function ThemeSwitch(): JSX.Element {
    const [sel, setSel] = useState<ThemeMode>("system");

    useEffect(() => {
        void window.api
            .getSettings()
            .then((s) => setSel(s.theme))
            .catch(() => {});
    }, []);

    const pick = (m: ThemeMode): void => {
        setSel(m);
        void window.api.setTheme(m).catch(() => {});
    };

    return (
        <div className="no-drag flex items-center gap-0.5 rounded-lg border border-line bg-raised p-0.5">
            {OPTIONS.map((o) => {
                const Icon = o.icon;
                const active = sel === o.id;
                return (
                    <button
                        key={o.id}
                        type="button"
                        title={`${o.label} theme`}
                        onClick={() => pick(o.id)}
                        className={`rounded-[7px] p-1.5 transition-colors ${
                            active
                                ? "bg-surface text-accent shadow-sm"
                                : "text-faint hover:text-secondary"
                        }`}
                    >
                        <Icon size={14} />
                    </button>
                );
            })}
        </div>
    );
}
