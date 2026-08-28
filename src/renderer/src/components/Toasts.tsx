import {
    useCallback,
    useMemo,
    useRef,
    useState,
    type JSX,
    type ReactNode,
} from "react";
import { CheckCircle2, Info, XCircle } from "lucide-react";
import { ToastCtx, type Kind, type ToastApi } from "./useToast";

interface ToastItem {
    id: number;
    kind: Kind;
    msg: string;
}

interface ProviderProps {
    children: ReactNode;
}

/**
 * Provides a toast stack and its API to the component tree.
 *
 * @param children - The subtree that can raise toasts.
 */
export function ToastProvider({ children }: ProviderProps): JSX.Element {
    const [items, setItems] = useState<ToastItem[]>([]);
    const seq = useRef(0);

    const push = useCallback((kind: Kind, msg: string) => {
        const id = ++seq.current;
        setItems((prev) => [...prev.slice(-4), { id, kind, msg }]);
        window.setTimeout(() => {
            setItems((prev) => prev.filter((t) => t.id !== id));
        }, 4500);
    }, []);

    const api = useMemo<ToastApi>(
        () => ({
            success: (msg) => push("success", msg),
            error: (msg) => push("error", msg),
            info: (msg) => push("info", msg),
        }),
        [push],
    );

    const styles: Record<Kind, string> = {
        success: "border-emerald-500/40",
        error: "border-rose-500/40",
        info: "border-sky-500/40",
    };
    const icons: Record<Kind, JSX.Element> = {
        success: (
            <CheckCircle2
                size={16}
                className="mt-0.5 shrink-0 text-emerald-500"
            />
        ),
        error: <XCircle size={16} className="mt-0.5 shrink-0 text-rose-500" />,
        info: <Info size={16} className="mt-0.5 shrink-0 text-sky-500" />,
    };

    return (
        <ToastCtx.Provider value={api}>
            {children}
            <div className="pointer-events-none fixed right-4 bottom-4 z-100 flex w-80 flex-col gap-2">
                {items.map((t) => (
                    <div
                        key={t.id}
                        className={`pointer-events-auto flex items-start gap-2 rounded-xl border bg-surface px-3 py-2 text-sm shadow-xl backdrop-blur transition-colors ${styles[t.kind]}`}
                    >
                        {icons[t.kind]}
                        <span className="text-primary">{t.msg}</span>
                    </div>
                ))}
            </div>
        </ToastCtx.Provider>
    );
}
