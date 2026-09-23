import { useEffect, useState } from 'react';
import { LogOut, RefreshCw, Search } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { Dialog, DialogClose, DialogHeader } from './ui/Dialog';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Badge } from './ui/Badge';
import { useToast } from './ui/Toast';

type ClockedEmployee = { employeeId: string; name: string; checkIn: string; lastCheckIn: string; checkOut: string | null; clockedIn: boolean };
type Selection = { scope: 'all' | 'individual'; employeeIds: string[]; date: string; name?: string };

export function ForceClockOutDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [employees, setEmployees] = useState<ClockedEmployee[]>([]);
  const [date, setDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch('/api/admin/force-clock-out');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load attendance');
      setEmployees(data.employees);
      setDate(data.date);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load attendance'); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/admin/force-clock-out').then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load attendance');
      if (!cancelled) { setEmployees(data.employees); setDate(data.date); }
    }).catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load attendance'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function confirmClockOut() {
    if (!selection || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/admin/force-clock-out', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to clock out');
      toast({ title: data.clockedOut ? 'Force clock out complete' : 'No employees clocked out', description: `${data.clockedOut} employee${data.clockedOut === 1 ? '' : 's'} clocked out at ${data.time}.${data.skipped ? ` ${data.skipped} already closed or changed; refresh and review.` : ''}${data.failed ? ` ${data.failed} failed; review before retrying.` : ''}`, variant: data.failed ? 'error' : data.clockedOut ? 'success' : 'info' });
      setSelection(null);
      await refresh();
    } catch (reason) {
      setSelection(null);
      setError(reason instanceof Error ? reason.message : 'Unable to clock out. Refresh before retrying.');
    } finally { setBusy(false); }
  }

  const active = employees.filter((employee) => employee.clockedIn);
  const query = search.trim().toLowerCase();
  const filtered = employees.filter((employee) => `${employee.name} ${employee.employeeId}`.toLowerCase().includes(query))
    .sort((a, b) => Number(b.clockedIn) - Number(a.clockedIn) || a.name.localeCompare(b.name));
  const close = () => { if (!busy) onClose(); };
  return <Dialog open onClose={close} className="max-w-2xl">
    <div role="dialog" aria-modal="true" aria-labelledby="force-clock-out-title" onKeyDown={(event) => { if (event.key === 'Escape') { if (selection && !busy) setSelection(null); else close(); } }}>
      <DialogHeader><div><h2 id="force-clock-out-title" className="text-lg font-bold text-slate-950">Force clock out</h2><p className="mt-1 text-sm text-slate-600">Employees who clocked in today{date ? ` · ${new Date(`${date}T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' })}` : ''}.</p></div><DialogClose onClose={close} /></DialogHeader>
      <div className="space-y-4 px-4 pb-4 pt-3 sm:px-6 sm:pb-6">
        {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error}</p>}
        {selection ? <div className="space-y-4 rounded-xl border border-rose-200 bg-rose-50 p-4">
          <h3 className="font-semibold text-slate-900">{selection.scope === 'all' ? `Clock out all ${selection.employeeIds.length} employees?` : `Clock out ${selection.name}?`}</h3>
          <p className="text-sm text-slate-600">This closes {selection.scope === 'all' ? 'their open sessions' : 'their open session'} for today using the current time. Completed sessions stay unchanged.</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button autoFocus variant="outline" disabled={busy} onClick={() => setSelection(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void confirmClockOut()}><LogOut className="h-4 w-4" />{busy ? 'Clocking out...' : 'Confirm clock out'}</Button></div>
        </div> : <>
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-slate-600">{loading ? 'Loading attendance...' : `${active.length} still clocked in · ${employees.length} attended today`}</p><Button variant="outline" size="sm" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" />Refresh</Button></div>
          <Button className="w-full" variant="destructive" disabled={loading || busy || Boolean(error) || active.length === 0} onClick={() => setSelection({ scope: 'all', employeeIds: active.map((employee) => employee.employeeId), date })}><LogOut className="h-4 w-4" />Force clock out all ({active.length})</Button>
          <p className="text-xs text-slate-500">“All” includes everyone still clocked in, even if hidden by your search. To clock out one person, use their button below.</p>
          <div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input aria-label="Search today's attendance" placeholder="Search employee or ID" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" /></div>
          <div className="max-h-[45dvh] space-y-2 overflow-y-auto overscroll-contain">
            {!loading && !filtered.length && <p className="py-6 text-center text-sm text-slate-500">{employees.length ? 'No matching employees.' : 'No employees have clocked in today.'}</p>}
            {filtered.map((employee) => <div key={employee.employeeId} className="flex flex-col gap-3 rounded-xl border border-slate-200 p-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="break-words text-sm font-semibold text-slate-900">{employee.name}</p><p className="mt-1 text-xs text-slate-500">{employee.employeeId} · Last time-in: {employee.lastCheckIn}</p><div className="mt-2"><Badge variant={employee.clockedIn ? 'success' : 'neutral'}>{employee.clockedIn ? 'Clocked in' : `Clocked out${employee.checkOut ? ` · ${employee.checkOut}` : ''}`}</Badge></div></div><Button className="shrink-0" size="sm" variant="outline" disabled={!employee.clockedIn || loading || busy || Boolean(error)} onClick={() => setSelection({ scope: 'individual', employeeIds: [employee.employeeId], date, name: employee.name })}>Clock out</Button></div>)}
          </div>
          <div className="flex justify-end"><Button variant="outline" className="w-full sm:w-auto" onClick={close}>Close</Button></div>
        </>}
      </div>
    </div>
  </Dialog>;
}
