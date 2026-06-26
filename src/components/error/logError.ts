import posthog from 'posthog-js';
import { captureException as sentryCapture } from '@/lib/observability/sentry';

/**
 * Centralized error logger for React ErrorBoundary onError handlers and any
 * top-level try/catch that needs to record a failure.
 *
 * Logs ONLY the error object and a string source tag. Never the React props,
 * never component state, never decrypted customer data. Keeping the ZKA
 * invariant (server side cannot read plaintext) means our telemetry side
 * cannot either.
 *
 * All captures are best-effort. A logger failure must never throw and
 * re-trigger the boundary that called it.
 */
export function logBoundaryError(error: Error, source: string): void {
  console.error(`[orangewaybooks:${source}] render error`, error);
  try {
    posthog.captureException?.(error, { source });
  } catch {
    // PostHog not initialized in this build (no VITE_POSTHOG_KEY) , swallow.
  }
  try {
    sentryCapture(error, { tags: { source } });
  } catch {
    // Sentry/GlitchTip not initialized (no VITE_SENTRY_DSN) , swallow.
    // console.error above remains the primary signal in that case.
  }
}
