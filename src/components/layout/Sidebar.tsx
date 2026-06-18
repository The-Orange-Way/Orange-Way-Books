import { useLocation, Link, useNavigate } from 'react-router-dom';
import { useVault } from '@/context/VaultContext';
import { supabase } from '@/lib/supabase';
import { decryptOrganization } from '@/lib/crypto-fields';
import { useEffect, useState, useRef } from 'react';
import {
  Home,
  Wallet,
  ArrowLeftRight,
  BookOpen,
  BarChart3,
  Settings,
  Lock,
  LockOpen,
  LogOut,
  ChevronDown,
  ChevronUp,
  Loader2,
  User,
  CreditCard,
  FileText,
  Star,
  Zap,
  Shield,
  UsersRound,
  TrendingUp,
} from 'lucide-react';

type NavItem = {
  title: string;
  path: string;
  icon: typeof Home;
  exact: boolean;
  children?: NavItem[];
};

const navItems: NavItem[] = [
  // App is mounted at /app/*; all sidebar paths must be absolute under /app.
  // Path /app/wallets is retained for URL stability — the visible label is "Accounts".
  { title: 'Insights', path: '/app', icon: Home, exact: true },
  { title: 'Accounts', path: '/app/accounts', icon: Account, exact: false },
  {
    title: 'Transactions',
    path: '/app/transactions',
    icon: ArrowLeftRight,
    exact: false,
    children: [
      { title: 'Journal Entries', path: '/app/journal', icon: BookOpen, exact: false },
    ],
  },
  { title: 'Cash flow', path: '/app/cash-flow', icon: TrendingUp, exact: false },
  { title: 'Reports', path: '/app/reports', icon: BarChart3, exact: false },
  { title: 'Invoices', path: '/app/invoices', icon: FileText, exact: false },
  { title: 'Payments', path: '/app/payments', icon: CreditCard, exact: false },
  { title: 'Contacts', path: '/app/contacts', icon: UsersRound, exact: false },
  { title: 'Connections', path: '/app/connections', icon: Zap, exact: false },
  { title: 'Admin', path: '/app/admin', icon: Settings, exact: false },
];

export interface SidebarProps {
  /** Optional callback fired whenever the user activates a nav item.
   * Used by AppShell's mobile drawer to auto-close after navigation.
   * Desktop renders the sidebar without this prop. */
  onNavigate?: () => void;
}

export default function Sidebar({ onNavigate }: SidebarProps = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isUnlocked, lock, decryptText } = useVault();
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let isActive = true;

    const fetchOrgs = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { if (isActive) setLoading(false); return; }

        if (isActive) {
          setUserEmail(user.email | '');
          const meta = user.user_metadata;
          setUserName(meta?.full_name | meta?.name | user.email?.split('@')[0] | '');
        }

        // Load all user org memberships
        const { data: memberships, error } = await supabase
          .from('org_members')
          .select('org_id')
          .eq('user_id', user.id);
        if (error | !memberships?.length) { if (isActive) setLoading(false); return; }

        const orgIds = memberships.map(m => m.org_id);

        // Load all org records
        const { data: orgRows } = await supabase
          .from('organizations')
          .select('id, name, key_version')
          .in('id', orgIds);

        if (orgRows && isActive) {
          const decrypted = await Promise.all(
            orgRows.map(async (org) => {
              const dec = await decryptOrganization(org, decryptText);
              return { id: org.id, name: dec.name };
            })
          );
          setOrgs(decrypted);

          // Determine active org
          const stored = localStorage.getItem('owb_active_org');
          const validStored = stored && decrypted.some(o => o.id === stored);
          setActiveOrgId(validStored ? stored : (decrypted[0]?.id ?? null));
        }
      } catch (error) {
        console.error('Failed to load organizations:', error);
      } finally {
        if (isActive) setLoading(false);
      }
    };

    void fetchOrgs();
    return () => { isActive = false; };
  }, []);

  // Close profile dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleLogout = async () => {
    lock();
    await supabase.auth.signOut();
  };

  const getInitials = (name: string) => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return (parts[0]?.[0] | '?').toUpperCase();
  };

  const isActive = (item: NavItem) => {
    if (item.exact) return location.pathname === item.path;
    return location.pathname.startsWith(item.path);
  };

  return (
    <aside
      className="flex flex-col sticky top-0 min-h-screen bg-white"
      style={{ width: 230, borderRight: '1px solid var(--color-border)', fontSize: 13, fontWeight: 500 }}
    >
      {/* Logo */}
      <div style={{ padding: '16px 18px 14px', borderBottom: '1px solid var(--color-border)' }}>
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--color-brand-orange)', fontSize: 18 }}>🔒</span>
          <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 15, fontWeight: 700, color: 'var(--color-gray-900)' }}>
            Orange Way Books
          </span>
        </div>
      </div>

      {/* Org selector */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--color-border)' }}>
        {loading ? (
          <div className="flex items-center justify-center py-2">
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-gray-400)' }} />
          </div>
        ) : (
          <select
            className="w-full bg-white outline-none cursor-pointer"
            style={{
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
              padding: '7px 10px',
            }}
            value={activeOrgId | ''}
            onChange={(e) => {
              const newOrgId = e.target.value;
              if (newOrgId && newOrgId !== activeOrgId) {
                localStorage.setItem('owb_active_org', newOrgId);
                window.location.reload();
              }
            }}
          >
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>{org.name}</option>
            ))}
            {orgs.length === 0 && <option value="">No organizations</option>}
          </select>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1" style={{ padding: '6px 0' }}>
        {navItems.map((item) => {
          const renderItem = (it: NavItem, indented: boolean) => {
            const a = isActive(it);
            return (
              <Link
                key={it.path}
                to={it.path}
                onClick={() => onNavigate?.()}
                className="flex items-center gap-3 transition-colors"
                style={{
                  padding: indented ? '8px 18px 8px 42px' : '10px 18px',
                  fontSize: indented ? 12.5 : 13,
                  fontWeight: a ? 700 : 500,
                  color: a ? 'var(--color-gray-900)' : 'var(--color-gray-600)',
                  background: a ? 'var(--color-brand-orange-light)' : 'transparent',
                  borderLeft: `3px solid ${a ? 'var(--color-brand-orange)' : 'transparent'}`,
                }}
                onMouseEnter={(e) => {
                  if (!a) e.currentTarget.style.background = 'var(--color-gray-50)';
                }}
                onMouseLeave={(e) => {
                  if (!a) e.currentTarget.style.background = 'transparent';
                }}
              >
                <it.icon className="w-4 h-4" />
                {it.title}
              </Link>
            );
          };
          return (
            <div key={item.path}>
              {renderItem(item, false)}
              {item.children?.map((child) => renderItem(child, true))}
            </div>
          );
        })}
      </nav>

      {/* Vault status */}
      <div style={{ borderTop: '1px solid var(--color-border)', padding: '10px 18px' }}>
        <div className="flex items-center gap-2">
          {isUnlocked ? (
            <LockOpen className="w-4 h-4 text-vault-unlocked" />
          ) : (
            <Lock className="w-4 h-4 text-vault-locked" />
          )}
          <span className={`text-xs font-medium ${isUnlocked ? 'text-vault-unlocked' : 'text-vault-locked'}`}>
            Vault {isUnlocked ? 'Unlocked' : 'Locked'}
          </span>
        </div>
      </div>

      {/* Profile section */}
      <div ref={profileRef} className="relative" style={{ borderTop: '1px solid var(--color-border)', padding: '10px 12px' }}>
        <button
          className="w-full flex items-center gap-2.5"
          onClick={() => setProfileOpen(!profileOpen)}
          style={{ padding: '4px 6px' }}
        >
          {/* Avatar */}
          <div
            className="flex items-center justify-center flex-shrink-0"
            style={{
              width: 36, height: 36, borderRadius: '50%',
              background: 'var(--color-gray-300)', color: 'var(--color-gray-700)',
              fontSize: 13, fontWeight: 700,
            }}
          >
            {getInitials(userName)}
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="truncate" style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-gray-700)' }}>
              {userName | 'User'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-gray-400)' }}>Member</div>
          </div>
          {profileOpen ? (
            <ChevronUp className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-gray-400)' }} />
          ) : (
            <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-gray-400)' }} />
          )}
        </button>

        {/* Profile dropdown — opens upward */}
        {profileOpen && (
          <div
            className="absolute left-3 right-3 bg-white overflow-hidden z-50"
            style={{
              bottom: '100%',
              marginBottom: 4,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--color-border)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            {[
              { label: 'My Profile', icon: User },
              { label: 'Billing', icon: CreditCard, path: '/app/billing' },
              { label: 'Manage Plan', icon: Star, path: '/app/billing' },
              { label: 'Security', icon: Shield, path: '/app/settings/security' },
            ].map((item) => (
              <button
                key={item.label}
                className="w-full flex items-center gap-2 transition-colors"
                style={{ padding: '8px 12px', fontSize: 13 }}
                onClick={() => {
                  if ('path' in item && item.path) {
                    setProfileOpen(false);
                    navigate(item.path);
                    onNavigate?.();
                  }
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-brand-orange)';
                  e.currentTarget.style.color = 'white';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'inherit';
                }}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </button>
            ))}
            <button
              className="w-full flex items-center gap-2 transition-colors"
              style={{ padding: '8px 12px', fontSize: 13, borderTop: '1px solid var(--color-border)' }}
              onClick={handleLogout}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--color-brand-orange)';
                e.currentTarget.style.color = 'white';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'inherit';
              }}
            >
              <LogOut className="w-4 h-4" />
              Log Out
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
