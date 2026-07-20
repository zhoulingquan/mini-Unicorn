import { Component, type ErrorInfo, type ReactNode } from "react";

import i18n from "@/i18n";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback renderer; receives the thrown error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Called when an error is caught (logging, telemetry, etc.). */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Generic React error boundary. Catches render-time errors in its subtree and
 * renders a fallback UI instead of unmounting the whole app. A top-level
 * instance wraps the entire shell; view-level instances isolate failures so a
 * crash in (e.g.) Settings does not take down the chat.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
    // Keep the log so failures surface during development without extra wiring.
    console.error("[ErrorBoundary] caught error:", error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <DefaultErrorFallback error={error} onReset={this.reset} />;
  }
}

function DefaultErrorFallback({
  error,
  onReset,
}: {
  error: Error;
  onReset: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center"
    >
      <p className="text-sm font-semibold text-foreground">
        {i18n.t("common.errorBoundary.title", { defaultValue: "Something went wrong" })}
      </p>
      <p className="max-w-md text-xs text-muted-foreground">
        {error.message || String(error)}
      </p>
      <button
        type="button"
        onClick={onReset}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
      >
        {i18n.t("common.errorBoundary.retry", { defaultValue: "Try again" })}
      </button>
    </div>
  );
}
