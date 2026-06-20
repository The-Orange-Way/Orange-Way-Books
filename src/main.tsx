import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";

// PostHog only initializes when VITE_POSTHOG_KEY is present at build
// time. Self-hosted builds leave it unset and ship with zero
// telemetry: no init, no provider wrap, no network calls to PostHog.
// SaaS builds set the key and get cookieless analytics: memory-only
// persistence, no cookies, no localStorage tracking, no session
// recording, no person profiles. Pageview + explicit captures only.
// phc_ keys are PostHog "Project API Keys" — write-only, public-safe.
const posthogKey = import.meta.env.VITE_POSTHOG_KEY;
const telemetryEnabled = typeof posthogKey === "string" && posthogKey.length > 0;

if (telemetryEnabled) {
  posthog.init(posthogKey, {
    api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://eu.i.posthog.com",
    persistence: "memory",
    person_profiles: "never",
    capture_pageview: true,
    autocapture: false,
    disable_session_recording: true,
    respect_dnt: true,
  });
  posthog.register({ app: "orangewaybooks", brand: "orangewaybooks" });
}

const root = createRoot(document.getElementById("root")!);
root.render(
  telemetryEnabled ? (
    <PostHogProvider client={posthog}>
      <App />
    </PostHogProvider>
  ) : (
    <App />
  ),
);
