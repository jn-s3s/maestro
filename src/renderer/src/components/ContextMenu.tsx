import { useEffect, useRef, type JSX } from "react";
import { createPortal } from "react-dom";

/**
 * Represents a single item rendered in a context menu.
 */
export interface ContextMenuItem {
    id?: string;
    label: string;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
}

interface Props {
    x: number;
    y: number;
    items: ContextMenuItem[];
    onClose: () => void;
}

/**
 * Portal-based context menu anchored to click coordinates. Closes on
 * outside click, Escape, or scroll. Items can be marked dangerous
 * (rose-colored on hover) or disabled.
 *
 * @param x - Viewport X coordinate for the menu anchor.
 * @param y - Viewport Y coordinate for the menu anchor.
 * @param items - Menu items to render.
 * @param onClose - Closes the menu.
 */
export default function ContextMenu({
    x,
    y,
    items,
    onClose,
}: Props): JSX.Element | null {
    const ref = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const onMouseDown = (e: MouseEvent): void => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === "Escape") onClose();
        };
        const onScroll = (): void => onClose();
        document.addEventListener("mousedown", onMouseDown);
        document.addEventListener("keydown", onKey);
        document.addEventListener("scroll", onScroll, true);
        return () => {
            document.removeEventListener("mousedown", onMouseDown);
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("scroll", onScroll, true);
        };
    }, [onClose]);

    const adjustedX = Math.min(x, window.innerWidth - 200);
    const adjustedY = Math.min(y, window.innerHeight - items.length * 32 - 16);

    return createPortal(
        <div
            ref={ref}
            role="menu"
            style={{ left: adjustedX, top: adjustedY }}
            className="fixed z-200 min-w-45 rounded-xl border border-line bg-surface py-1 shadow-2xl"
        >
            {items.map((item, i) => (
                <button
                    key={item.id ?? `ctx-item-${i}`}
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => {
                        item.onClick();
                        onClose();
                    }}
                    className={`flex w-full items-center px-3 py-1.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-40 ${
                        item.danger
                            ? "text-secondary hover:bg-rose-500/10 hover:text-rose-500"
                            : "text-secondary hover:bg-raised hover:text-primary"
                    }`}
                >
                    {item.label}
                </button>
            ))}
        </div>,
        document.body,
    );
}
