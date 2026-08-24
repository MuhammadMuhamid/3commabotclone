import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The application had no error boundary.
 *
 * React unmounts the entire tree when a render throws, so any component error —
 * a malformed API response, a number formatter meeting `undefined`, a chart
 * value that is `NaN` — replaced the dashboard with a blank page. On the
 * interface that shows whether bots are running and holds the only controls
 * for closing a position, a blank page is the worst available failure: the
 * user cannot see their trades and cannot act on them, and nothing says why.
 *
 * A class component because that is still the only way to catch a render
 * error in React.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // There is no error-reporting service in this deployment, and adding one
    // would be a production change. The console is where this goes.
    console.error("[render error]", error, info.componentStack);
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh", display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: "1rem",
          padding: "1rem", textAlign: "center",
          background: "var(--color-bg, #0b0f14)", color: "var(--color-text, #dde4ee)",
        }}
      >
        <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>
          The dashboard stopped rendering
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--color-muted, #6b7a90)", margin: 0, maxWidth: "34rem" }}>
          This is a display failure in the browser. Your bots are unaffected — they run on the
          server and keep running whether or not this page is open. No order was placed or
          cancelled by this error.
        </p>
        <pre style={{
          maxWidth: "34rem", maxHeight: "10rem", overflow: "auto", textAlign: "left",
          background: "var(--color-panel-2, #192030)", border: "1px solid var(--color-border, #243044)",
          borderRadius: "0.5rem", padding: "0.5rem 0.75rem", fontSize: "0.75rem",
          color: "var(--color-muted, #6b7a90)",
        }}>
          {error.message || "Unknown error"}
        </pre>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "center" }}>
          <button
            onClick={this.reset}
            style={{
              background: "var(--color-accent, #00d1c1)", color: "#000", border: 0,
              borderRadius: "0.5rem", padding: "0.5rem 1rem", fontSize: "0.875rem",
              fontWeight: 600, cursor: "pointer",
            }}
          >
            Try again
          </button>
          <a
            href="/"
            style={{
              border: "1px solid var(--color-border, #243044)", borderRadius: "0.5rem",
              padding: "0.5rem 1rem", fontSize: "0.875rem", color: "inherit",
              textDecoration: "none",
            }}
          >
            Reload the dashboard
          </a>
        </div>
      </div>
    );
  }
}
