import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { initSentry } from './lib/observability/sentry';

// Wire Sentry/GlitchTip before React mounts so the very first render
// errors are captured. No-op when VITE_SENTRY_DSN is unset, so dev
// builds and forks without a DSN stay quiet. The SDK is statically
// imported but Sentry.init is only called once; first-render captures
// before init complete are queued internally.
initSentry();

// PostHog initialisation has moved to src/App.tsx (AnalyticsGate).
// It is now deferred until the user first lands on a marketing route,
// so the SDK is never initialised at all inside the authenticated app.
// See src/lib/observability/analytics-surface.ts for the allowlist.

createRoot(document.getElementById('root')!).render(<App />);
