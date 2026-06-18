import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";

// Cookieless PostHog — privacy stance for the Orange Way Books family.
// Memory-only persistence, no cookies, no localStorage tracking,
// no session recording, no person profiles. Each page load is a
// fresh anonymous event stream. Pageview + explicit captures only.
// phc_ keys are PostHog "Project API Keys" — write-only, public-safe.
posthog.init(import.meta.env.VITE_POSTHOG_KEY ?? "", {
  api_host: import.meta.env.VITE_POSTHOG_HOST ?? "https://eu.i.posthog.com",
  persistence: "memory",
  person_profiles: "never",
  capture_pageview: true,
  autocapture: false,
  disable_session_recording: true,
  respect_dnt: true,
});
posthog.register({ app: "orangewaybooks", brand: "orangewaybooks" });

createRoot(document.getElementById("root")!).render(
  <PostHogProvider client={posthog}>
    <App />
  </PostHogProvider>,
);
