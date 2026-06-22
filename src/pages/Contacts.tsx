import { useEffect, useMemo, useState } from 'react';
import { Plus, Search, Pencil, Trash2, Loader2, Download } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { format } from 'date-fns';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';
import { exportToCsv } from '@/lib/exports/csv';
import { encryptContact, decryptContact } from '@/lib/crypto-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

type ContactKind = 'CUSTOMER' | 'VENDOR' | 'EMPLOYEE' | 'OTHER';

interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  type: string | null;
}

const KIND_OPTIONS: { value: ContactKind; label: string }[] = [
  { value: 'CUSTOMER', label: 'Customer' },
  { value: 'VENDOR', label: 'Vendor' },
  { value: 'EMPLOYEE', label: 'Employee' },
  { value: 'OTHER', label: 'Other' },
];

function blankForm(): ContactRow & { id: '' } {
  return {
    id: '',
    name: '',
    email: null,
    phone: null,
    city: null,
    country: null,
    type: 'CUSTOMER',
  };
}

export default function ContactsPage() {
  const { orgId, loading: orgLoading } = useUserOrg();
  const { encryptText, decryptText } = useVault();
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | ContactKind>('all');
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<ContactRow>(blankForm());
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const fetchRows = async () => {
    if (!orgId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('contacts')
      .select('id, name, email, phone, city, country, type, key_version')
      .eq('org_id', orgId);
    if (error) {
      toast.error(`Could not load contacts: ${error.message}`);
      setLoading(false);
      return;
    }
    const decrypted = await Promise.all(
      ((data as any[]) ?? []).map(async (r) => {
        try {
          const f = await decryptContact(r as any, decryptText);
          return {
            id: r.id as string,
            name: f.name,
            email: f.email,
            phone: f.phone,
            city: f.city,
            country: f.country,
            type: f.type,
          };
        } catch {
          return {
            id: r.id as string,
            name: '[Encrypted]',
            email: null,
            phone: null,
            city: null,
            country: null,
            type: r.type ?? null,
          };
        }
      }),
    );
    setRows(decrypted);
    setLoading(false);
  };

  useEffect(() => {
    if (!orgId) {
      if (!orgLoading) setLoading(false);
      return;
    }
    fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, orgLoading]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows
      .filter((r) => (typeFilter === 'all') | ((r.type | 'OTHER').toUpperCase() === typeFilter))
      .filter((r) => {
        if (!term) return true;
        return (
          r.name.toLowerCase().includes(term) ||
          (r.email ?? '').toLowerCase().includes(term) ||
          (r.phone ?? '').toLowerCase().includes(term) ||
          (r.city ?? '').toLowerCase().includes(term)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, search, typeFilter]);

  const countByKind = useMemo(() => {
    const acc: Record<string, number> = { CUSTOMER: 0, VENDOR: 0, EMPLOYEE: 0, OTHER: 0 };
    for (const r of rows) {
      const k = (r.type | 'OTHER').toUpperCase();
      acc[k] = (acc[k] ?? 0) + 1;
    }
    return acc;
  }, [rows]);

  const openCreate = () => {
    setForm(blankForm());
    setEditOpen(true);
  };
  const openEdit = (row: ContactRow) => {
    setForm({ ...row });
    setEditOpen(true);
  };

  const save = async () => {
    if (!orgId) return;
    const trimmed = form.name.trim();
    if (!trimmed) {
      toast.error('Name is required.');
      return;
    }
    setSaving(true);
    try {
      const enc = await encryptContact(
        {
          name: trimmed,
          street: null,
          city: form.city | null,
          state: null,
          zip: null,
          country: form.country | null,
          email: form.email | null,
          phone: form.phone | null,
          type: form.type | 'OTHER',
        },
        encryptText,
      );
      if (form.id) {
        const { error } = await supabase
          .from('contacts')
          .update(enc as any)
          .eq('id', form.id);
        if (error) throw error;
        toast.success(`Updated "${trimmed}".`);
      } else {
        const { error } = await supabase.from('contacts').insert({ org_id: orgId, ...enc } as any);
        if (error) throw error;
        toast.success(`Created "${trimmed}".`);
      }
      setEditOpen(false);
      await fetchRows();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string, name: string) => {
    if (
      !confirm(
        `Delete contact "${name}"? Transactions and journal entries already linked to this contact stay intact and just lose the link.`,
      )
    )
      return;
    setDeletingId(id);
    const { error } = await supabase.from('contacts').delete().eq('id', id);
    setDeletingId(null);
    if (error) {
      toast.error(`Delete failed: ${error.message}`);
      return;
    }
    toast.success(`Deleted "${name}".`);
    setRows((prev) => prev.filter((r) => r.id !== id));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const toggleOne = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const toggleAll = (on: boolean) =>
    setSelected(on ? new Set(filtered.map((r) => r.id)) : new Set());

  const bulkDelete = async () => {
    if (selected.size === 0) return;
    if (
      !confirm(
        `Delete ${selected.size} selected contact${selected.size === 1 ? '' : 's'}? Existing transactions and journal entries stay intact and just lose the link.`,
      )
    )
      return;
    setBulkDeleting(true);
    const ids = Array.from(selected);
    const { error } = await supabase.from('contacts').delete().in('id', ids);
    setBulkDeleting(false);
    if (error) {
      toast.error(`Bulk delete failed: ${error.message}`);
      return;
    }
    toast.success(`Deleted ${ids.length} contact${ids.length === 1 ? '' : 's'}.`);
    setRows((prev) => prev.filter((r) => !selected.has(r.id)));
    setSelected(new Set());
  };

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Customers, vendors, employees. Search, edit, and create — encrypted client-side, same as
            transactions.
          </p>
        </div>
        <div className="flex gap-2 sm:self-end">
          <Button
            variant="outline"
            onClick={() => {
              const scope =
                selected.size > 0 ? filtered.filter((r) => selected.has(r.id)) : filtered;
              const headers = ['Name', 'Type', 'Email', 'Phone', 'City', 'Country'];
              const rows = scope.map((c) => [
                c.name,
                (c.type ?? 'OTHER').toString(),
                c.email ?? '',
                c.phone ?? '',
                c.city ?? '',
                c.country ?? '',
              ]);
              exportToCsv(`owb-contacts-${format(new Date(), 'yyyy-MM-dd')}.csv`, headers, rows);
              toast.success(`Exported ${scope.length} contact${scope.length === 1 ? '' : 's'}.`);
            }}
            disabled={filtered.length === 0}
            data-testid="contacts-export-csv"
          >
            <Download className="w-4 h-4 mr-1.5" />
            Export {selected.size > 0 ? `selected (${selected.size})` : 'CSV'}
          </Button>
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4 mr-1.5" />
            New contact
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5">
          All: {rows.length}
        </span>
        <span className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5">
          Customers: {countByKind.CUSTOMER}
        </span>
        <span className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5">
          Vendors: {countByKind.VENDOR}
        </span>
        <span className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5">
          Employees: {countByKind.EMPLOYEE}
        </span>
        <span className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5">
          Other: {countByKind.OTHER}
        </span>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by name, email, phone, city"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="contacts-search"
          />
        </div>
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {KIND_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading contacts…
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card border border-border rounded-lg p-12 text-center text-muted-foreground text-sm">
          {rows.length === 0 ? (
            'No contacts yet — add one to use it on transactions, journal entries, and payments.'
          ) : (
            <>
              <p>No contacts match the current filter.</p>
              <p className="mt-1 text-xs">Clear the search or change the type filter.</p>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="bg-card border border-border rounded-lg overflow-x-auto hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={filtered.length > 0 && selected.size === filtered.length}
                      onCheckedChange={(v) => toggleAll(!!v)}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((c) => (
                  <TableRow key={c.id} data-state={selected.has(c.id) ? 'selected' : undefined}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(c.id)}
                        onCheckedChange={(v) => toggleOne(c.id, !!v)}
                        aria-label={`Select ${c.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-xs uppercase tracking-wide text-muted-foreground">
                      {c.type ?? 'OTHER'}
                    </TableCell>
                    <TableCell className="text-sm">{c.email ?? '—'}</TableCell>
                    <TableCell className="text-sm">{c.phone ?? '—'}</TableCell>
                    <TableCell className="text-sm">{c.city ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={deletingId === c.id}
                        onClick={() => remove(c.id, c.name)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="grid gap-2 md:hidden">
            {filtered.map((c) => (
              <div
                key={c.id}
                className="bg-card border border-border rounded-lg p-3"
                data-state={selected.has(c.id) ? 'selected' : undefined}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <Checkbox
                      checked={selected.has(c.id)}
                      onCheckedChange={(v) => toggleOne(c.id, !!v)}
                      aria-label={`Select ${c.name}`}
                      className="mt-1"
                    />
                    <div className="min-w-0">
                      <p className="font-medium truncate">{c.name}</p>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">
                        {c.type ?? 'OTHER'}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={deletingId === c.id}
                      onClick={() => remove(c.id, c.name)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                {c.email | c.phone | c.city && (
                  <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                    {c.email && <p>{c.email}</p>}
                    {c.phone && <p>{c.phone}</p>}
                    {c.city && <p>{c.city}</p>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {selected.size > 0 && (
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-card border border-border rounded-lg px-5 py-3 flex items-center gap-3 z-50"
          style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}
          data-testid="contacts-bulk-bar"
        >
          <span className="text-sm font-medium">{selected.size} selected</span>
          <div className="w-px h-6 bg-border" />
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            onClick={bulkDelete}
            disabled={bulkDeleting}
            data-testid="contacts-bulk-delete"
          >
            {bulkDeleting ? (
              <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
            ) : (
              <Trash2 className="w-4 h-4 mr-1.5" />
            )}
            Delete selected
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
            disabled={bulkDeleting}
          >
            Cancel
          </Button>
        </div>
      )}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit contact' : 'New contact'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <label className="block text-sm">
              <span className="text-muted-foreground text-xs">Name *</span>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                autoFocus
              />
            </label>
            <label className="block text-sm">
              <span className="text-muted-foreground text-xs">Type</span>
              <Select
                value={(form.type | 'OTHER').toUpperCase()}
                onValueChange={(v) => setForm({ ...form, type: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-sm">
                <span className="text-muted-foreground text-xs">Email</span>
                <Input
                  value={form.email ?? ''}
                  onChange={(e) => setForm({ ...form, email: e.target.value | null })}
                />
              </label>
              <label className="block text-sm">
                <span className="text-muted-foreground text-xs">Phone</span>
                <Input
                  value={form.phone ?? ''}
                  onChange={(e) => setForm({ ...form, phone: e.target.value | null })}
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-sm">
                <span className="text-muted-foreground text-xs">City</span>
                <Input
                  value={form.city ?? ''}
                  onChange={(e) => setForm({ ...form, city: e.target.value | null })}
                />
              </label>
              <label className="block text-sm">
                <span className="text-muted-foreground text-xs">Country</span>
                <Input
                  value={form.country ?? ''}
                  onChange={(e) => setForm({ ...form, country: e.target.value | null })}
                />
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
              {form.id ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
