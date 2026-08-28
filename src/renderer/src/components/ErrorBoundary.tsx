import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
    error: Error | null;
}

/**
 * Class component that catches render errors and shows a fallback screen.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
    override state: State = { error: null };

    /**
     * Captures the thrown error into component state.
     *
     * @param error - Error thrown by a descendant.
     */
    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    /**
     * Logs the caught error details to the console.
     *
     * @param error - The error that was raised.
     * @param info - React component stack information.
     */
    override componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error("[boundary]", error.message, info.componentStack);
    }

    /**
     * Renders the error fallback or the wrapped children.
     */
    override render(): ReactNode {
        if (this.state.error) {
            return (
                <div className="grid h-screen place-items-center bg-app p-8">
                    <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 text-center shadow-xl">
                        <h2 className="text-sm font-semibold text-primary">
                            Something went wrong
                        </h2>
                        <p className="mt-2 max-h-32 overflow-auto break-all font-mono text-xs text-secondary">
                            {this.state.error.message}
                        </p>
                        <button
                            type="button"
                            onClick={() => location.reload()}
                            className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent2"
                        >
                            Reload
                        </button>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}
