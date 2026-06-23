import { Link, NavLink, Outlet } from 'react-router-dom';
import { Bitcoin } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';

interface MarketingLayoutProps {
  session: Session | null;
}

/**
 * Public marketing chrome: header with primary nav, footer with sitemap.
 * Renders <Outlet /> for the active marketing page.
 *
 * Logged-in visitors see "Open app" instead of "Sign in", they can still
 * browse marketing pages without losing session state.
 */
export default function MarketingLayout({ session }: MarketingLayoutProps) {
  const navItems = [
    { to: '/features', label: 'Features' },
    { to: '/security', label: 'Security' },
    { to: '/pricing', label: 'Pricing' },
    { to: '/compare/quickbooks', label: 'Compare' },
    { to: '/docs', label: 'Docs' },
    { to: '/faq', label: 'FAQ' },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-6">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <span className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <Bitcoin className="w-5 h-5 text-primary-foreground" />
            </span>
            <span>Orange Way Books</span>
          </Link>

          <nav aria-label="Primary" className="hidden md:flex items-center gap-6 text-sm">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  isActive
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground transition-colors'
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-3 text-sm">
            {session ? (
              <Link
                to="/app"
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition"
              >
                Open app
              </Link>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  Sign in
                </Link>
                <Link
                  to="/signup"
                  className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 transition"
                >
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-border mt-16">
        <div className="max-w-6xl mx-auto px-6 py-12 grid gap-8 sm:grid-cols-2 md:grid-cols-4 text-sm">
          <div>
            <div className="flex items-center gap-2 font-semibold mb-3">
              <span className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
                <Bitcoin className="w-4 h-4 text-primary-foreground" />
              </span>
              <span>Orange Way Books</span>
            </div>
            <p className="text-muted-foreground">
              Open-source, zero-knowledge accounting for Bitcoin businesses.
            </p>
          </div>
          <FooterCol
            title="Product"
            links={[
              { to: '/features', label: 'Features' },
              { to: '/security', label: 'Security' },
              { to: '/pricing', label: 'Pricing' },
              { to: '/faq', label: 'FAQ' },
            ]}
          />
          <FooterCol
            title="Compare"
            links={[
              { to: '/compare/quickbooks', label: 'vs QuickBooks' },
              { to: '/compare/xero', label: 'vs Xero' },
              { to: '/compare/bitwave', label: 'vs Bitwave' },
              { to: '/compare/cryptio', label: 'vs Cryptio' },
              { to: '/compare/wave', label: 'vs Wave' },
              { to: '/compare/freshbooks', label: 'vs FreshBooks' },
              { to: '/compare/spreadsheets', label: 'vs Spreadsheets' },
            ]}
          />
          <FooterCol
            title="Resources"
            links={[
              { to: '/docs', label: 'Documentation' },
              { to: '/about', label: 'About' },
              { to: '/contact', label: 'Contact' },
              { to: '/privacy', label: 'Privacy' },
              {
                to: 'https://github.com/The-Orange-Way/Orange-Way-Books',
                label: 'GitHub',
                external: true,
              },
            ]}
          />
        </div>
        <div className="border-t border-border">
          <div className="max-w-6xl mx-auto px-6 py-4 text-xs text-muted-foreground flex flex-wrap justify-between gap-2">
            <span>© {new Date().getFullYear()} Orange Way Books. Apache-2.0 licensed.</span>
            <span>Built for Bitcoin businesses who own their data.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FooterCol({
  title,
  links,
}: {
  title: string;
  links: ReadonlyArray<{ to: string; label: string; external?: boolean }>;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold mb-3">{title}</h2>
      <ul className="space-y-2 text-muted-foreground">
        {links.map((l) => (
          <li key={l.to}>
            {l.external ? (
              <a
                href={l.to}
                className="hover:text-foreground transition-colors"
                rel="noopener noreferrer"
              >
                {l.label}
              </a>
            ) : (
              <Link to={l.to} className="hover:text-foreground transition-colors">
                {l.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
