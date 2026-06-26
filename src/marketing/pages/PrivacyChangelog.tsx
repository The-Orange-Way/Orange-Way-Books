import { Link } from 'react-router-dom';
import { Seo } from '../Seo';
import { breadcrumbJsonLd } from '../seo';

export default function PrivacyChangelog() {
  return (
    <>
      <Seo
        title="Privacy Policy — Change Log"
        description="One-line summary of every change to the Orange Way Books privacy policy. Bumped on every sub-processor change with a 30-day pre-change notice."
        path="/privacy-changelog"
        jsonLd={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Privacy', path: '/privacy' },
          { name: 'Change log', path: '/privacy-changelog' },
        ])}
      />

      <article className="max-w-3xl mx-auto px-6 py-16 prose-invert">
        <header className="mb-10">
          <h1 className="text-4xl font-bold mb-4">Privacy Policy — Change Log</h1>
          <p className="text-muted-foreground">
            One-line summary of every change to the{' '}
            <Link to="/privacy" className="underline">
              Privacy Policy
            </Link>
            . The page Version anchor bumps to the date of each entry.
          </p>
        </header>

        <section className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Version 2026.06.26</h2>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground mt-2">
              <li>Added Cross-border data transfers section (SCC + DPF + Quebec Law 25 §17).</li>
              <li>
                Added Changes to sub-processors section (30-day pre-change notice, version anchor,
                this change log).
              </li>
              <li>Added DPA links per US vendor (Supabase, Cloudflare, Resend, PostHog).</li>
              <li>
                Clarified PostHog scope: enabled on <code>books.orangeway.app</code>, disabled by
                default on self-hosted.
              </li>
              <li>Replaced “Last updated” date with a “Version: YYYY.MM.DD” anchor.</li>
            </ul>
          </div>

          <div>
            <h2 className="text-xl font-semibold">Version 2026.06.26 (earlier)</h2>
            <ul className="list-disc pl-6 space-y-1 text-muted-foreground mt-2">
              <li>
                Restructured the Sub-processors section from a 7-item bullet list into 8 per-vendor
                sub-sections with what-they-see and retention windows.
              </li>
              <li>
                Added Cloudflare (hosting + captcha) and GlitchTip (error reports) as explicit
                sub-processors.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-xl font-semibold">Version 2026.06.21 and earlier</h2>
            <p className="text-muted-foreground mt-2">
              Pre-change-log history. Track via the git history of{' '}
              <a
                href="https://github.com/The-Orange-Way/Orange-Way-Books/commits/dev/src/marketing/pages/Privacy.tsx"
                className="underline"
                rel="noopener noreferrer"
                target="_blank"
              >
                src/marketing/pages/Privacy.tsx
              </a>
              .
            </p>
          </div>
        </section>
      </article>
    </>
  );
}
