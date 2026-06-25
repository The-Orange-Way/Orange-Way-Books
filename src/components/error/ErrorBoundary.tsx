import { Component, type ErrorInfo, type ReactNode } from 'react';
import { logBoundaryError } from './logError';

interface Props {
  children: ReactNode;
  source: string;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * React Error Boundary. Catches render-time errors anywhere in its subtree,
 * logs them through `logBoundaryError` (console + PostHog + Sentry, all
 * best-effort), and shows a fallback UI instead of an unmounted blank page.
 *
 * Why this exists:
 *   1. `window.onerror` does not fire for errors thrown during React render.
 *      Without a boundary, the offending component subtree unmounts and the
 *      page goes blank with no signal in any telemetry channel.
 *   2. The default browser console message ("Error: ...") is uncaptureable
 *      after-the-fact. This component routes the same error into a logger
 *      that has agency.
 *
 * Why the `source` prop:
 *   So a captured event in GlitchTip is tagged with which subtree boundary
 *   caught it (`source: 'app-root'`, `source: 'onboarding'`, etc.). Makes
 *   triage faster than reading the React stack alone.
 *
 * Fallback UI is intentionally generic + recoverable. No customer data
 * appears in the rendered output, only a short message and a reset button.
 * Reset re-tries the subtree; if the root cause is still present the
 * boundary catches again.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    logBoundaryError(error, this.props.source);
  }

  reset = () => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      // "Team has been notified" is conditional on a configured Sentry/GlitchTip
      // DSN. Self-hosted forks without VITE_SENTRY_DSN run initSentry() as a
      // no-op and the captureException call silently drops the event. Showing
      // a definite "notified" claim there would be misleading.
      const telemetryConfigured =
        typeof import.meta.env.VITE_SENTRY_DSN === 'string' &&
        import.meta.env.VITE_SENTRY_DSN.length > 0;
      return (
        <div
          role="alert"
          aria-live="assertive"
          className="min-h-screen flex items-center justify-center bg-background p-6"
        >
          <div className="max-w-md w-full bg-card border border-border rounded-lg p-6 shadow-sm">
            <h2 className="text-base font-semibold text-card-foreground mb-2">
              Something went wrong
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              Orange Way Books hit an unexpected error. Your data has not been touched.{' '}
              {telemetryConfigured
                ? 'The team has been notified.'
                : 'If this keeps happening, please copy the message in your browser console and contact support.'}
            </p>
            <button
              type="button"
              onClick={this.reset}
              className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
