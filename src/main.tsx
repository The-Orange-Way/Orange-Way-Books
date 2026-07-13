import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import posthog from 'posthog-js';
import { PostHogProvider } from 'posthog-js/react';
import { initSentry } from './lib/observability/sentry';
import { scrubPostHogEvent } from './lib/observability/posthog-scrubber';

// Wire Sentry/GlitchTip before React mounts so the very first render
// errors are captured. No-op when VITE_SENTRY_DSN is unset, so dev
// builds and forks without a DSN stay quiet. The SDK is statically
// imported but Sentry.init is only called once; first-render captures
// before init complete are queued internally.
initSentry();

// PostHog only initializes when VITE_POSTHOG_KEY is present at build
// time. Self-hosted builds leave it unset and ship with zero
// telemetry: no init, no provider wrap, no network calls to PostHog.
// SaaS builds set the key and get cookieless analytics: memory-only
// persistence, no cookies, no localStorage tracking, no session
// recording, no person profiles. Pageview + explicit captures only.
// phc_ keys are PostHog "Project API Keys": write-only, public-safe.
const posthogKey = import.meta.env.VITE_POSTHOG_KEY;
const telemetryEnabled = typeof posthogKey === 'string' && posthogKey.length > 0;

if (telemetryEnabled) {
  posthog.init(posthogKey, {
    // Blank counts as unset: || and not ??, because ?? only falls back on
    // null or undefined and Vite hands us "" for a var that is present but
    // empty in .env. Without this, a deployer who fills in only the key
    // silently loses the EU endpoint that .env.example promises.
    api_host: import.meta.env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com',
    persistence: 'memory',
    person_profiles: 'never',
    capture_pageview: true,
    autocapture: false,
    disable_session_recording: true,
    respect_dnt: true,
    // PostHog captures URL query strings and path params on pageview, and
    // an explicit captureException can carry an error whose properties echo
    // decrypted content. The before_send hook scrubs, before the network
    // call, any url field's query string and fragment, any path segment that
    // looks like a UUID, slug, or numeric id, and any property whose key name
    // suggests decrypted accounting content. The Sentry init does the same on
    // its side. Keep the two scrubbers in shape with each other, and with the
    // Orange Way Me scrubber this is ported from.
    before_send: scrubPostHogEvent,
  });
  posthog.register({ app: 'orangewaybooks', brand: 'orangewaybooks' });
}

const root = createRoot(document.getElementById('root')!);
root.render(
  telemetryEnabled ? (
    <PostHogProvider client={posthog}>
      <App />
    </PostHogProvider>
  ) : (
    <App />
  ),
);
