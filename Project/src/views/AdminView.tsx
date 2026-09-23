import { ForceClockOutDialog } from "../components/ForceClockOutDialog";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { useEffect, useMemo, useState } from "react";
import { Archive, Check, DatabaseBackup, KeyRound, LockKeyhole, LogOut, Mail, RotateCcw, Search, ShieldCheck, Trash2, UserPlus, Wrench, X } from "lucide-react";

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../components/ui/Card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/Table";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Dialog, DialogClose, DialogHeader } from "../components/ui/Dialog";
import { Input } from "../components/ui/Input";
import type { Employee } from "../lib/data";
import { useToast } from "../components/ui/Toast";
import { apiFetch } from "../lib/api";
import { PaginationControls } from "../components/ui/Pagination";
import { usePagination } from "../hooks/usePagination";

const hoverScrollbarClasses = 
  "max-h-[400px] overflow-y-auto pr-2 " +
  "[scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:#cbd5e1_transparent] " +
  "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-transparent " +
  "hover:[&::-webkit-scrollbar-thumb]:bg-slate-300 [&::-webkit-scrollbar-thumb]:rounded-full transition-colors duration-300";

type ConfirmationRequest = { title: string; description: string; confirmLabel: string; destructive?: boolean; resolve: (confirmed: boolean) => void };

export function AdminView() {
  const { toast } = useToast();
  const [localEmployees, setLocalEmployees] = useState<(Employee & { banned?: boolean })[]>([]);
  const [archivedAccounts, setArchivedAccounts] = useState<{ id: string; name: string; type: "Employee"; record: Employee & { banned?: boolean; archivedAt?: string } }[]>([]);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [forceClockOutOpen, setForceClockOutOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordRetrySeconds, setPasswordRetrySeconds] = useState(0);
  const [controls, setControls] = useState({ maintenanceMode: false, registrationOpen: true, updatedAt: null as string | null });
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  const [archiveReferenceTime] = useState(() => Date.now());
  const [archiveRange, setArchiveRange] = useState<"30d" | "1y" | "5y" | "all">("all");
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [archiveSearch, setArchiveSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<(typeof archivedAccounts)[number] | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [credentialError, setCredentialError] = useState("");
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);

  function askForConfirmation(details: Omit<ConfirmationRequest, "resolve">) {
    return new Promise<boolean>((resolve) => setConfirmation({ ...details, resolve }));
  }

  function closeConfirmation(confirmed: boolean) {
    confirmation?.resolve(confirmed);
    setConfirmation(null);
  }

  const filteredEmployees = useMemo(() => {
    const query = employeeSearch.trim().toLowerCase();
    return query ? localEmployees.filter((employee) => `${employee.name} ${employee.id} ${employee.role}`.toLowerCase().includes(query)) : localEmployees;
  }, [employeeSearch, localEmployees]);
  const filteredArchivedAccounts = useMemo(() => {
    const query = archiveSearch.trim().toLowerCase();
    const matchingAccounts = query ? archivedAccounts.filter((account) => `${account.name} ${account.id} ${account.record.role}`.toLowerCase().includes(query)) : archivedAccounts;
    if (archiveRange === "all") return matchingAccounts;
    const rangeDays = archiveRange === "30d" ? 30 : archiveRange === "1y" ? 365 : 365 * 5;
    const cutoff = archiveReferenceTime - rangeDays * 86400000;
    return matchingAccounts.filter((account) => {
      const archivedAt = new Date(account.record.archivedAt ?? "").getTime();
      return Number.isFinite(archivedAt) && archivedAt >= cutoff;
    });
  }, [archiveRange, archiveReferenceTime, archivedAccounts, archiveSearch]);
  const employeePage = usePagination(filteredEmployees, employeeSearch);
  const archivePage = usePagination(filteredArchivedAccounts, `${archiveRange}|${archiveSearch}`);

  useEffect(() => {
    if (passwordRetrySeconds <= 0) return;
    const timer = window.setInterval(() => setPasswordRetrySeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [passwordRetrySeconds]);

  useEffect(() => {
    Promise.all([apiFetch('/api/employees'), apiFetch('/api/archived-employees'), apiFetch('/api/admin/system-controls'), apiFetch('/api/admin/account-security')]).then(async ([activeResponse, archivedResponse, controlsResponse, accountResponse]) => {
      if (activeResponse.ok) setLocalEmployees(await activeResponse.json());
      if (archivedResponse.ok) {
        const archived = await archivedResponse.json() as (Employee & { banned?: boolean })[];
        setArchivedAccounts(archived.map((record) => ({ id: record.id, name: record.name, type: 'Employee' as const, record })));
      }
      if (controlsResponse.ok) setControls(await controlsResponse.json());
      if (accountResponse.ok) setAdminEmail((await accountResponse.json()).email ?? "");
    }).catch(() => {});
  }, []);

  async function updateAdminCredentials(event: React.FormEvent) {
    event.preventDefault();
    setCredentialError("");
    if (!currentPassword) return setCredentialError("Enter your current administrator password.");
    if (newPassword && newPassword !== confirmPassword) return setCredentialError("The new passwords do not match.");
    const credentialChanges = [adminEmail ? "administrator email" : "", newPassword ? "administrator password" : ""].filter(Boolean).join(" and ");
    if (!await askForConfirmation({ title: "Update administrator credentials?", description: `This will update the ${credentialChanges || "administrator credentials"}. All other administrator sessions will be signed out.`, confirmLabel: "Update Credentials" })) return;
    setCredentialSaving(true);
    try {
      const response = await apiFetch('/api/admin/account-security', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: adminEmail, currentPassword, newPassword }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Administrator credentials were not updated.');
      setAdminEmail(data.email);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast({ title: "Admin credentials updated", description: `${data.revokedSessions ? `${data.revokedSessions} other active session${data.revokedSessions === 1 ? " was" : "s were"} signed out. ` : ""}Your current session remains active.`, variant: "success" });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Please try again.";
      setCredentialError(message);
      toast({ title: "Credentials were not updated", description: message, variant: "error" });
    } finally { setCredentialSaving(false); }
  }

  async function toggleBanEmployee(id: string) {
    const employee = localEmployees.find((item) => item.id === id);
    if (!employee) return;
    const banned = !employee.banned;
    if (!await askForConfirmation({ title: `${banned ? "Block" : "Restore"} employee access?`, description: `${employee.name}'s account will be ${banned ? "blocked and any active session will be signed out" : "restored so they can sign in again"}.`, confirmLabel: banned ? "Block Access" : "Restore Access", destructive: banned })) return;
    const response = await apiFetch(`/api/admin/employees/${id}/access`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ banned }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return toast({ title: "Access was not updated", description: data.error || "Please try again.", variant: "error" });
    setLocalEmployees((current) => current.map((item) => item.id === id ? { ...item, banned } : item));
    toast({ title: banned ? "Account access blocked" : "Account access restored", description: `${employee.name}'s access was updated.`, variant: banned ? "info" : "success" });
  }

  async function updateControl(key: "maintenanceMode" | "registrationOpen", value: boolean) {
    const message = key === "maintenanceMode"
      ? value ? "Turn on maintenance mode? All employee users will be locked out until it is turned off." : "Turn off maintenance mode and restore employee access?"
      : value ? "Open new employee registration?" : "Restrict new employee registration? Administrators will not be able to create employees until it is reopened.";
    if (!await askForConfirmation({ title: "Confirm system control change", description: message, confirmLabel: key === "maintenanceMode" ? value ? "Turn On Maintenance" : "Turn Off Maintenance" : value ? "Open Registration" : "Restrict Registration", destructive: (key === "maintenanceMode" && value) || (key === "registrationOpen" && !value) })) return;
    setControlBusy(key);
    try {
      const response = await apiFetch('/api/admin/system-controls', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: value }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Control was not updated');
      setControls(data);
      toast({ title: "System control updated", description: key === "maintenanceMode" ? `Maintenance mode is now ${value ? "on" : "off"}.` : `Registration is now ${value ? "open" : "restricted"}.`, variant: "success" });
    } catch (reason) { toast({ title: "Control was not updated", description: reason instanceof Error ? reason.message : "Please try again.", variant: "error" }); }
    finally { setControlBusy(null); }
  }

  async function createBackup() {
    if (!await askForConfirmation({ title: "Create a system backup?", description: "A new backup containing business records and encrypted biometric templates will be saved to the location you select.", confirmLabel: "Choose Save Location" })) return;
    const suggestedName = `workpulse-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const picker = (window as Window & { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
    let handle: Awaited<ReturnType<NonNullable<typeof picker>>> | null = null;
    if (picker) {
      try {
        handle = await picker({ suggestedName, types: [{ description: 'WORKPULSE MVL JSON backup', accept: { 'application/json': ['.json'] } }] });
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        return toast({ title: "Backup location was not selected", description: "No database data was downloaded.", variant: "info" });
      }
    }
    setControlBusy("backup");
    try {
      const response = await apiFetch('/api/admin/backup');
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Backup could not be generated'); }
      const blob = await response.blob();
      if (handle) { const writable = await handle.createWritable(); await writable.write(blob); await writable.close(); }
      else { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = suggestedName; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
      toast({ title: "Backup saved", description: "The WORKPULSE MVL business-data backup was saved to the location you approved.", variant: "success" });
    } catch (reason) { toast({ title: "Backup was not saved", description: reason instanceof Error ? reason.message : "Please try again.", variant: "error" }); }
    finally { setControlBusy(null); }
  }

  async function unlockAdminControls(event: React.FormEvent) {
    event.preventDefault();
    if (!password) { setPasswordError("Enter your admin password."); return; }
    try {
      const response = await apiFetch('/api/auth/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const contentType = response.headers.get('content-type') ?? '';
      const data = contentType.includes('application/json') ? await response.json() : null;
      if (response.status === 429) {
        const seconds = Number(data?.retryAfterSeconds || response.headers.get('Retry-After') || 0);
        setPasswordRetrySeconds(seconds);
        throw new Error(`Too many password attempts. Try again in ${seconds} seconds.`);
      }
      if (!response.ok) throw new Error(data?.error || `Password verification failed (server returned ${response.status})`);
      setPasswordPromptOpen(false);
      setAdminUnlocked(true);
      setPasswordError("");
      setPassword("");
      toast({ title: "Admin controls unlocked", description: "Protected account controls are now available.", variant: "success" });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Password verification failed'; setPasswordError(message); toast({ title: "Unable to unlock controls", description: message, variant: "error" });
    }
  }

  async function restoreAccount(id: string) {
    const account = archivedAccounts.find((item) => item.id === id);
    if (!account) return;
    if (!await askForConfirmation({ title: "Restore archived employee?", description: `${account.name} will return to the active employee directory and can be given account access again.`, confirmLabel: "Restore Employee" })) return;
    const response = await apiFetch(`/api/employees/${id}/unarchive`, { method: 'POST' });
    if (!response.ok) { toast({ title: "Account was not restored", description: "Please try again.", variant: "error" }); return; }
    const restored = await response.json();
    setLocalEmployees((current) => [...current, { ...restored, banned: false }]);
    setArchivedAccounts((current) => current.filter((item) => item.id !== id));
    toast({ title: "Account restored", description: `${account.name} returned to the employee directory.`, variant: "success" });
  }

  async function lockAdminControls() {
    if (!await askForConfirmation({ title: "Lock Admin Controls?", description: "Your administrator password will be required to open these protected controls again.", confirmLabel: "Lock Controls" })) return;
    setArchiveOpen(false);
    setAdminUnlocked(false);
    toast({ title: "Admin controls locked", description: "Protected administrative actions now require password verification again.", variant: "info" });
  }

  async function permanentlyDeleteAccount(event: React.FormEvent) {
    event.preventDefault();
    if (!deleteTarget || !deletePassword) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await apiFetch(`/api/employees/${deleteTarget.id}/permanent`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: deletePassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Permanent deletion failed");
      setArchivedAccounts((current) => current.filter((account) => account.id !== deleteTarget.id));
      toast({ title: "Employee permanently deleted", description: `${deleteTarget.name} and all linked database records were deleted.`, variant: "success" });
      setDeleteTarget(null);
      setDeletePassword("");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Permanent deletion failed";
      setDeleteError(message);
      toast({ title: "Employee was not deleted", description: message, variant: "error" });
    } finally {
      setDeleting(false);
    }
  }

  if (!adminUnlocked) return (
    <div className="space-y-6"><AdminPageHeader title="Admin Control Panel" description="Manage user access, bans, and global system configuration" icon={ShieldCheck} /><div className="flex justify-center py-6"><Card className="w-full max-w-md"><CardContent className="flex flex-col items-center p-6 text-center sm:p-8"><div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#8642ED]/10"><KeyRound className="h-7 w-7 text-[#8642ED]" /></div><h2 className="mt-4 text-xl font-bold text-slate-900">Admin Controls Locked</h2><p className="mt-1 text-sm text-slate-500">Password verification is required before accessing any administrative controls.</p><Button className="mt-5" onClick={() => { setPassword(""); setPasswordError(""); setPasswordPromptOpen(true); }}>Enter Password</Button></CardContent></Card></div>
      <Dialog open={passwordPromptOpen} onClose={() => setPasswordPromptOpen(false)} className="max-w-sm"><DialogHeader><div><h3 className="flex items-center gap-2 text-base font-bold text-slate-900"><KeyRound className="h-4 w-4 text-[#8642ED]" /> Admin Password</h3><p className="mt-1 text-xs text-slate-500">Verify your current account password to continue.</p></div><DialogClose onClose={() => setPasswordPromptOpen(false)} /></DialogHeader><form onSubmit={unlockAdminControls} className="space-y-3 px-6 pb-6 pt-3"><Input type="password" autoFocus disabled={passwordRetrySeconds > 0} value={password} onChange={(event) => { setPassword(event.target.value); setPasswordError(""); }} placeholder={passwordRetrySeconds > 0 ? `Try again in ${passwordRetrySeconds}s` : "Enter admin password"} />{passwordRetrySeconds > 0 && <p className="text-xs font-medium text-amber-600">Password attempts locked for {passwordRetrySeconds} more seconds.</p>}{passwordError && <p className="text-xs text-rose-600">{passwordError}</p>}<div className="flex justify-end gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setPasswordPromptOpen(false)}>Cancel</Button><Button type="submit" size="sm" disabled={passwordRetrySeconds > 0}>{passwordRetrySeconds > 0 ? `Wait ${passwordRetrySeconds}s` : "Unlock"}</Button></div></form></Dialog>
    </div>
  );

  return (
    <div className="space-y-6">
      <AdminPageHeader title="Admin Control Panel" description="Manage user access, bans, and global system configuration" icon={ShieldCheck} actions={<><Button className="flex-1 sm:flex-none" variant="outline" onClick={() => setArchiveOpen(true)}><Archive className="h-4 w-4" /> Archive</Button><Button className="flex-1 sm:flex-none" variant="outline" onClick={lockAdminControls}><KeyRound className="h-4 w-4" /> Lock</Button></>} />

      <div className="grid grid-cols-1 gap-6">
        {/* Ban / Unban Employees Table */}
        <Card>
          <CardHeader>
            <CardTitle>Employee Access</CardTitle>
            <CardDescription>Manage all employee accounts, including employees assigned as managers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="relative mb-4 max-w-sm"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input aria-label="Search employee access" value={employeeSearch} onChange={(event) => setEmployeeSearch(event.target.value)} placeholder="Search employee, ID, or role" className="pl-9" /></div>
            <div className={hoverScrollbarClasses}>
              <Table className="min-w-[620px]">
                <TableHeader className="sticky top-0 bg-white z-10 shadow-sm">
                  <TableRow>
                    <TableHead>Employee</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {employeePage.pageItems.map((e) => (
                    <TableRow key={e.id} className="group hover:bg-slate-50/70">
                      <TableCell>
                        <div className="font-medium text-slate-900">{e.name}</div>
                        <div className="text-xs text-slate-500">{e.id}</div>
                      </TableCell>
                      <TableCell className="capitalize text-slate-600">{e.role}</TableCell>
                      <TableCell>
                        {e.banned ? (
                          <Badge variant="danger">Banned</Badge>
                        ) : (
                          <Badge variant="success">Active</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant={e.banned ? "outline" : undefined} onClick={() => void toggleBanEmployee(e.id)}>
                          {e.banned ? (
                            <><Check className="mr-1.5 h-3.5 w-3.5" />Unban</>
                          ) : (
                            <><X className="mr-1.5 h-3.5 w-3.5" />Ban</>
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <PaginationControls {...employeePage} onPageChange={employeePage.setPage} />
          </CardContent>
        </Card>

        {/* Global Settings Table */}
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-slate-700" />
              System Settings
            </CardTitle>
            <CardDescription>Global configuration and system restrictions</CardDescription>
          </CardHeader>
          <CardContent>
            <Table className="min-w-[680px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Configuration</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-medium text-slate-900"><span className="flex items-center gap-2"><Wrench className="h-4 w-4 text-slate-400" />Maintenance Mode</span></TableCell>
                  <TableCell className="text-slate-500 text-sm">Lock out all non-admin users instantly</TableCell>
                  <TableCell><Badge variant={controls.maintenanceMode ? "warning" : "neutral"}>{controls.maintenanceMode ? "On" : "Off"}</Badge></TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="outline" disabled={controlBusy === "maintenanceMode"} onClick={() => void updateControl("maintenanceMode", !controls.maintenanceMode)}>{controls.maintenanceMode ? "Turn Off" : "Turn On"}</Button></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium text-slate-900"><span className="flex items-center gap-2"><DatabaseBackup className="h-4 w-4 text-slate-400" />Database Backup</span></TableCell>
                  <TableCell className="text-slate-500 text-sm">Save business records and encrypted biometric templates to a location you approve</TableCell>
                  <TableCell><Badge variant="info">Manual</Badge></TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="outline" disabled={controlBusy === "backup"} onClick={() => void createBackup()}>{controlBusy === "backup" ? "Saving…" : "Choose & Save"}</Button></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium text-slate-900"><span className="flex items-center gap-2"><UserPlus className="h-4 w-4 text-slate-400" />New Employee Registration</span></TableCell>
                  <TableCell className="text-slate-500 text-sm">Allow administrators to create new employee records</TableCell>
                  <TableCell><Badge variant={controls.registrationOpen ? "success" : "danger"}>{controls.registrationOpen ? "Open" : "Restricted"}</Badge></TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="outline" disabled={controlBusy === "registrationOpen"} onClick={() => void updateControl("registrationOpen", !controls.registrationOpen)}>{controls.registrationOpen ? "Restrict" : "Open"}</Button></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium text-slate-900"><span className="flex items-center gap-2"><LogOut className="h-4 w-4 text-red-500" />Force Clock Out</span></TableCell>
                  <TableCell className="text-slate-500 text-sm">Clock out everyone or an individual who clocked in today</TableCell>
                  <TableCell><Badge variant="neutral">On demand</Badge></TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="destructive" disabled={controlBusy === "clock-out"} onClick={() => setForceClockOutOpen(true)}>{controlBusy === "clock-out" ? "Clocking out…" : "Force Clock Out"}</Button></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-amber-200">
          <CardHeader className="border-b border-amber-100 bg-amber-50/60">
            <CardTitle className="flex items-center gap-2"><LockKeyhole className="h-5 w-5 text-amber-700" />Admin Account Security</CardTitle>
            <CardDescription>Use this panel if the administrator account may be compromised. Only the signed-in administrator can change these credentials.</CardDescription>
          </CardHeader>
          <CardContent className="pt-5">
            <form onSubmit={updateAdminCredentials} className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1.5 md:col-span-2"><span className="flex items-center gap-2 text-sm font-medium text-slate-700"><Mail className="h-4 w-4 text-slate-400" />Administrator email</span><Input type="email" autoComplete="email" required value={adminEmail} disabled={credentialSaving} onChange={(event) => { setAdminEmail(event.target.value); setCredentialError(""); }} /></label>
                <label className="space-y-1.5"><span className="text-sm font-medium text-slate-700">New password</span><Input type="password" autoComplete="new-password" minLength={8} maxLength={64} value={newPassword} disabled={credentialSaving} onChange={(event) => { setNewPassword(event.target.value); setCredentialError(""); }} placeholder="Leave blank to keep it" /></label>
                <label className="space-y-1.5"><span className="text-sm font-medium text-slate-700">Confirm new password</span><Input type="password" autoComplete="new-password" minLength={8} maxLength={64} value={confirmPassword} disabled={credentialSaving || !newPassword} onChange={(event) => { setConfirmPassword(event.target.value); setCredentialError(""); }} placeholder="Repeat new password" /></label>
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4"><label className="block max-w-md space-y-1.5"><span className="text-sm font-semibold text-amber-950">Current administrator password</span><Input type="password" autoComplete="current-password" required value={currentPassword} disabled={credentialSaving} onChange={(event) => { setCurrentPassword(event.target.value); setCredentialError(""); }} placeholder="Required to save changes" /></label><p className="mt-2 text-xs leading-5 text-amber-800">Saving signs out all other administrator sessions. This device stays signed in.</p></div>
              {credentialError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">{credentialError}</p>}
              <div className="flex justify-end"><Button type="submit" disabled={credentialSaving || !adminEmail || !currentPassword || Boolean(newPassword && newPassword !== confirmPassword)}><ShieldCheck className="h-4 w-4" />{credentialSaving ? "Updating..." : "Update Admin Credentials"}</Button></div>
            </form>
          </CardContent>
        </Card>
      </div>

      {archiveOpen && (
        <Card className="border-violet-200">
          <CardHeader><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div><CardTitle className="flex items-center gap-2"><Archive className="h-5 w-5 text-[#8642ED]" /> Archived Employees</CardTitle><CardDescription>Restore employees or permanently delete an individual employee and all linked database records.</CardDescription></div><div className="flex flex-col gap-2 sm:flex-row sm:items-center"><div className="flex flex-wrap rounded-xl border border-slate-200 bg-slate-50 p-1">{([['30d','30 days'],['1y','1 year'],['5y','5 years'],['all','All']] as const).map(([value,label]) => <button key={value} type="button" onClick={() => setArchiveRange(value)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${archiveRange === value ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>{label}</button>)}</div><Button className="w-full sm:w-auto" size="sm" variant="outline" onClick={() => setArchiveOpen(false)}>Close</Button></div></div></CardHeader>
          <CardContent className="p-0"><div className="border-b border-slate-100 p-4"><div className="relative max-w-sm"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><Input aria-label="Search archived employees" value={archiveSearch} onChange={(event) => setArchiveSearch(event.target.value)} placeholder="Search employee, ID, or role" className="pl-9" /></div></div><div className="overflow-x-auto"><Table className="min-w-[720px]"><TableHeader><TableRow><TableHead>Employee</TableHead><TableHead>Archived date</TableHead><TableHead>Age</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader><TableBody>
            {archivePage.pageItems.map((account) => {
              const archivedAt = account.record.archivedAt ? new Date(account.record.archivedAt) : null;
              const validDate = archivedAt && !Number.isNaN(archivedAt.getTime());
              const ageDays = validDate ? Math.max(0, Math.floor((archiveReferenceTime - archivedAt.getTime()) / 86400000)) : null;
              return <TableRow key={account.id}><TableCell><div className="font-medium text-slate-900">{account.name}</div><div className="text-xs text-slate-400">{account.id}</div></TableCell><TableCell className="text-slate-600">{validDate ? archivedAt.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unavailable'}</TableCell><TableCell><Badge variant="neutral">{ageDays == null ? 'Unknown' : ageDays === 0 ? 'Today' : `${ageDays} ${ageDays === 1 ? 'day' : 'days'}`}</Badge></TableCell><TableCell><div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => restoreAccount(account.id)}><RotateCcw className="h-3.5 w-3.5" /> Restore</Button><Button size="sm" variant="destructive" onClick={() => { setDeleteTarget(account); setDeletePassword(''); setDeleteError(''); }}><Trash2 className="h-3.5 w-3.5" /> Delete permanently</Button></div></TableCell></TableRow>;
            })}
          </TableBody></Table></div>{filteredArchivedAccounts.length === 0 && <div className="py-10 text-center text-sm text-slate-400">{archivedAccounts.length ? 'No archived employees match the selected filters.' : 'The archive is empty.'}</div>}<PaginationControls {...archivePage} onPageChange={archivePage.setPage} /></CardContent>
        </Card>
      )}

      {forceClockOutOpen && <ForceClockOutDialog onClose={() => setForceClockOutOpen(false)} />}

      <Dialog open={Boolean(confirmation)} onClose={() => closeConfirmation(false)} className="max-w-md">
        <DialogHeader><div><div className={`mb-3 grid h-10 w-10 place-items-center rounded-xl ${confirmation?.destructive ? "bg-rose-100 text-rose-700" : "bg-violet-100 text-violet-700"}`}><ShieldCheck className="h-5 w-5" /></div><h3 className="text-lg font-bold text-slate-950">{confirmation?.title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{confirmation?.description}</p></div><DialogClose onClose={() => closeConfirmation(false)} /></DialogHeader>
        <div className="flex justify-end gap-2 px-6 pb-6 pt-3"><Button type="button" variant="outline" onClick={() => closeConfirmation(false)}>Cancel</Button><Button type="button" variant={confirmation?.destructive ? "destructive" : undefined} onClick={() => closeConfirmation(true)}>{confirmation?.confirmLabel || "Confirm"}</Button></div>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onClose={() => !deleting && setDeleteTarget(null)} className="max-w-md">
        <DialogHeader><div><h3 className="flex items-center gap-2 text-base font-bold text-rose-700"><Trash2 className="h-4 w-4" /> Permanently delete employee</h3><p className="mt-1 text-xs leading-5 text-slate-500">This permanently deletes {deleteTarget?.name} and their login, fingerprint, attendance, leave, payroll, and biometric test records from MongoDB. This cannot be undone.</p></div><DialogClose onClose={() => !deleting && setDeleteTarget(null)} /></DialogHeader>
        <form onSubmit={permanentlyDeleteAccount} className="space-y-4 px-6 pb-6 pt-3">
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"><p className="font-semibold">Employee: {deleteTarget?.name}</p><p className="mt-1 text-xs">ID: {deleteTarget?.id}</p></div>
          <label className="block space-y-1.5"><span className="text-xs font-semibold text-slate-700">Confirm your administrator password</span><Input type="password" autoFocus value={deletePassword} disabled={deleting} onChange={(event) => { setDeletePassword(event.target.value); setDeleteError(''); }} placeholder="Enter admin password" /></label>
          {deleteError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">{deleteError}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button><Button type="submit" variant="destructive" disabled={deleting || !deletePassword}><Trash2 className="h-4 w-4" />{deleting ? 'Deleting…' : 'Delete permanently'}</Button></div>
        </form>
      </Dialog>

    </div>
  );
}
