import type { JSX } from "react";
import { TriangleAlert } from "lucide-react";

interface Props {
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * Modal confirmation dialog for destructive actions.
 *
 * @param title - The dialog heading.
 * @param message - The descriptive body text.
 * @param confirmLabel - Label for the confirm button.
 * @param onConfirm - Callback when the action is confirmed.
 * @param onCancel - Callback when the dialog is dismissed.
 */
export default function ConfirmDialog({
    title,
    message,
    confirmLabel = "Delete",
    onConfirm,
    onCancel,
}: Props): JSX.Element {
    return (
        <div
            className="fixed inset-0 z-60 grid place-items-center bg-black/50 backdrop-blur-sm"
            onMouseDown={onCancel}
        >
            <div
                className="w-100 max-w-[92vw] rounded-2xl border border-line bg-surface p-5 shadow-2xl"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div className="flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-rose-500/10 text-rose-500">
                        <TriangleAlert size={17} />
                    </span>
                    <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-primary">
                            {title}
                        </h3>
                        <p className="mt-1 wrap-break-word text-xs leading-relaxed text-secondary">
                            {message}
                        </p>
                    </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="rounded-xl bg-raised px-4 py-2 text-sm text-primary transition-colors hover:bg-line"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-rose-500"
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
