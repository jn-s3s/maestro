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
    const [mode, setMode] = useState<ThemeMode>("system");

    useEffect(() => {
        void window.api
            .getSettings()
            .then((result) => setMode(result.theme))
            .catch(() => {});
    }, []);

    const pick = (nextMode: ThemeMode): void => {
        setMode(nextMode);
        void window.api.setTheme(nextMode).catch(() => {});
    };

    return (
        <div className="no-drag flex items-center gap-0.5 rounded-lg border border-line bg-raised p-0.5">
            {OPTIONS.map((option) => {
                const Icon = option.icon;
                const active = mode === option.id;
                return (
                    <button
                        key={option.id}
                        type="button"
                        title={`${option.label} theme`}
                        onClick={() => pick(option.id)}
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
