import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  CalendarDays, CheckCircle2, ChevronRight, Clock3, Fingerprint, LayoutDashboard, LogOut,
  AlertTriangle, Eye, Mail, MapPin, Menu, Pencil, Phone, Printer, RefreshCw, Save, Send, ShieldCheck, UserRound, WalletCards, X,
} from 'lucide-react'
import { apiFetch, clearSession } from '../lib/api'
import { useToast } from '../components/ui/Toast'
import { DateNavigator } from '../components/DateNavigator'
import { LeaveDatePicker } from '../components/LeaveDatePicker'
import { Dialog, DialogClose, DialogHeader } from '../components/ui/Dialog'
import { Button } from '../components/ui/Button'

type EmployeeProfile = {
  id: string; name: string; email?: string; phone?: string; address?: string; createdAt?: string;
  role: 'regular' | 'extra'; status: string; biometricStatus: string;
  monthlyLeaveCredits?: { month: string; total: number; used: number; remaining: number };
  hourlyRate?: number; grossSalary?: number;
}
type AttendanceSession = { checkIn: string; checkOut?: string | null; autoClockedOut?: boolean }
type Attendance = { date: string; checkIn?: string; checkOut?: string; sessions?: AttendanceSession[]; status: string; autoClockedOut?: boolean }
type Leave = { id: string; leaveType: string; startDate: string; endDate: string; requestedDates?: string[]; approvedDates?: string[]; totalDays: number; reason: string; status: string }
type Payroll = { id: string; amount?: number; grossAmount?: number; currentAmount?: number; carryOverAmount?: number; additions?: { label: string; value: number }[]; hoursWorked?: number; hourlyRate?: number; status: string; periodStart?: string; paidAt?: string; warnings?: string[] }
type AttendanceFlag = { tier: 'green' | 'orange' | 'red'; absenceDays: number; lateDays: number; periodStart: string; periodEnd: string }
type WorkSchedule = { workWeekdays: number[]; scheduleOverrides: { date: string; working: boolean; kind?: string }[]; startTime?: string; autoClockOutTime?: string }
type Workspace = { profile: EmployeeProfile; attendance: Attendance[]; leaveRequests: Leave[]; payroll: Payroll[]; attendanceFlag: AttendanceFlag; workSchedule: WorkSchedule }
type Section = 'overview' | 'attendance' | 'leave' | 'payroll' | 'profile'

const money = (value: number | undefined) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(Number(value || 0))
const formatDate = (value?: string) => value ? new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const formatTime = (value?: string | null) => value || '—'

function manilaToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function attendanceSessions(record: Attendance) {
  if (record.sessions?.length) return record.sessions.slice(0, 3)
  return record.checkIn ? [{ checkIn: record.checkIn, checkOut: record.checkOut }] : []
}

const sectionCopy: Record<Section, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: 'Employee workspace', title: 'Overview', description: 'A simple summary of your attendance, leave, payroll, and account.' },
  attendance: { eyebrow: 'Time records', title: 'My Attendance', description: 'Review all three possible time-in and time-out sessions for each workday.' },
  leave: { eyebrow: 'Time away', title: 'Leave Requests', description: 'Check your available credits and send a request to your administrator.' },
  payroll: { eyebrow: 'Pay records', title: 'My Payroll', description: 'See your prepared payouts, carried balances, and payment status.' },
  profile: { eyebrow: 'Personal record', title: 'My Profile', description: 'Review the employee information connected to your account.' },
}

export function EmployeePortal() {
  const { toast } = useToast()
  const [section, setSection] = useState<Section>('overview')
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const [attendanceDate, setAttendanceDate] = useState(manilaToday)
  const [leaveDraft, setLeaveDraft] = useState({ leaveType: 'Annual Leave', requestedDates: [] as string[], reason: '' })
  const [editingContact, setEditingContact] = useState(false)
  const [savingContact, setSavingContact] = useState(false)
  const [contactDraft, setContactDraft] = useState({ phone: '', address: '' })
  const [selectedPayrollId, setSelectedPayrollId] = useState<string | null>(null)
  const [cancelLeaveTarget, setCancelLeaveTarget] = useState<Leave | null>(null)
  const [cancellingLeave, setCancellingLeave] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')

  const loadWorkspace = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    try {
      const response = await apiFetch('/api/employee/me')
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to load your workspace')
      setWorkspace(data); setContactDraft(current => current.phone || current.address ? current : { phone: data.profile?.phone || '', address: data.profile?.address || '' }); setLastUpdated(new Date()); setRefreshError('')
    } catch (reason) { setRefreshError(reason instanceof Error ? reason.message : 'Unable to refresh your workspace') }
    finally { setLoading(false); setRefreshing(false) }
  }, [])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => { void loadWorkspace() }, 0)
    return () => window.clearTimeout(initialLoad)
  }, [loadWorkspace])
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void loadWorkspace() }
    const timer = window.setInterval(refresh, 60_000)
    const visibility = () => { if (document.visibilityState === 'visible') void loadWorkspace() }
    document.addEventListener('visibilitychange', visibility)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [loadWorkspace])
  const attendanceSummary = useMemo(() => {
    const records = workspace?.attendance ?? []
    return {
      present: records.filter((item) => item.status === 'Present').length,
      late: records.filter((item) => item.status === 'Late').length,
      total: records.length,
      sessions: records.reduce((total, record) => total + attendanceSessions(record).length, 0),
    }
  }, [workspace])

  async function submitLeave(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    try {
      const response = await apiFetch('/api/employee/me/leave-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leaveDraft) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Unable to submit leave request')
      setWorkspace((current) => current ? { ...current, leaveRequests: [data, ...current.leaveRequests] } : current)
      setLeaveDraft({ leaveType: 'Annual Leave', requestedDates: [], reason: '' })
      toast({ title: 'Leave request submitted', description: 'Your request is now waiting for administrator review.', variant: 'success' })
      await loadWorkspace()
    } catch (reason) {
      toast({ title: 'Request not submitted', description: reason instanceof Error ? reason.message : 'Please try again.', variant: 'error' })
    } finally { setSubmitting(false) }
  }

  async function cancelLeave(request: Leave) {
    setCancellingLeave(true)
    try {
      const response = await apiFetch(`/api/employee/me/leave-requests/${request.id}/cancel`, { method: 'PATCH' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Leave request could not be cancelled')
      setWorkspace((current) => current ? { ...current, leaveRequests: current.leaveRequests.map((item) => item.id === request.id ? { ...item, ...data } : item) } : current)
      toast({ title: 'Leave request cancelled', description: 'The request was removed from the administrator approval queue.', variant: 'success' })
      await loadWorkspace()
      setCancelLeaveTarget(null)
    } catch (reason) { toast({ title: 'Request was not cancelled', description: reason instanceof Error ? reason.message : 'Please try again.', variant: 'error' }) }
    finally { setCancellingLeave(false) }
  }

  async function saveContactInformation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSavingContact(true)
    try {
      const response = await apiFetch('/api/employee/me/contact', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(contactDraft) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Unable to update your contact information')
      setWorkspace((current) => current ? { ...current, profile: { ...current.profile, phone: data.phone, address: data.address } } : current)
      setContactDraft({ phone: data.phone, address: data.address })
      setEditingContact(false)
      toast({ title: 'Contact information updated', description: 'Your phone number and address were saved.', variant: 'success' })
    } catch (reason) {
      toast({ title: 'Changes not saved', description: reason instanceof Error ? reason.message : 'Please try again.', variant: 'error' })
    } finally { setSavingContact(false) }
  }

  function cancelContactEditing() {
    if (!workspace) return
    setContactDraft({ phone: workspace.profile.phone || '', address: workspace.profile.address || '' })
    setEditingContact(false)
  }

  async function logout() {
    try { await apiFetch('/api/auth/logout', { method: 'POST' }) } finally { clearSession(); window.location.replace('/') }
  }

  if (loading) return <div className="grid min-h-screen place-items-center bg-slate-100/70"><div className="text-center"><div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-4 border-violet-100 border-t-[#8642ED]" /><p className="text-sm font-medium text-slate-500">Loading your secure workspace...</p></div></div>
  if (!workspace) return <div className="grid min-h-screen place-items-center bg-slate-100/70"><button onClick={() => { clearSession(); window.location.replace('/') }} className="rounded-xl bg-[#8642ED] px-5 py-3 text-sm font-semibold text-white">Return to sign in</button></div>

  const { profile } = workspace
  const selectedPayroll = workspace.payroll.find((item) => item.id === selectedPayrollId) ?? null
  const initials = profile.name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
  const nav = [
    { key: 'overview' as const, label: 'Overview', icon: LayoutDashboard },
    { key: 'attendance' as const, label: 'My Attendance', icon: Clock3 },
    { key: 'leave' as const, label: 'Leave Requests', icon: CalendarDays },
    { key: 'payroll' as const, label: 'My Payroll', icon: WalletCards },
    { key: 'profile' as const, label: 'My Profile', icon: UserRound },
  ]
  const page = sectionCopy[section]
  const selectedAttendance = workspace.attendance.filter((record) => record.date === attendanceDate)

  return <div className="flex min-h-screen w-full bg-slate-100/70 text-slate-900">
    <button aria-label="Close navigation" onClick={() => setMobileNavigationOpen(false)} className={`fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-sm transition-opacity lg:hidden ${mobileNavigationOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'}`} />
    <aside className={`fixed inset-y-0 left-0 z-50 flex w-[min(19rem,86vw)] flex-col border-r border-slate-200/80 bg-white shadow-2xl transition-transform duration-200 lg:sticky lg:top-0 lg:z-20 lg:h-screen lg:w-64 lg:translate-x-0 lg:shadow-none ${mobileNavigationOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="flex h-16 items-center gap-3 border-b border-slate-200/80 px-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#8642ED] shadow-md shadow-[#8642ED]/25"><Fingerprint className="h-[18px] w-[18px] text-white" /></div>
        <div className="min-w-0"><h2 className="text-[13px] font-bold leading-tight tracking-tight text-slate-900"><span className="font-extrabold">WORK</span><span className="font-extrabold text-[#8642ED]">PULSE</span><span className="font-extrabold"> MVL</span></h2><p className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-400">Employee</p></div>
        <button onClick={() => setMobileNavigationOpen(false)} aria-label="Close navigation" className="ml-auto rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 lg:hidden"><X className="h-5 w-5" /></button>
      </div>
      <nav className="scrollbar-thin flex-1 space-y-1 overflow-y-auto p-3">
        <p className="mb-2 px-3 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Workspace</p>
        {nav.map(({ key, label, icon: Icon }) => { const active = section === key; return <button key={key} onClick={() => { setSection(key); setMobileNavigationOpen(false); }} className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition-all ${active ? 'bg-violet-600 text-white shadow-sm shadow-violet-600/20' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'}`}><Icon className={`h-[18px] w-[18px] shrink-0 transition-colors ${active ? 'text-white' : 'text-slate-400 group-hover:text-slate-700'}`} />{label}{active && <ChevronRight className="ml-auto h-3.5 w-3.5 text-white/80" />}</button> })}
      </nav>
      <div className="border-t border-slate-200/80 p-3"><div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-2.5"><div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#8642ED] text-[13px] font-bold text-white">{initials}</div><div className="min-w-0 flex-1"><p className="truncate text-[13px] font-semibold text-slate-900">{profile.name}</p><div className="flex items-center gap-1.5"><span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Online</span><span className="truncate text-[10px] capitalize text-slate-400">{profile.role}</span></div></div><button onClick={logout} aria-label="Log out" className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"><LogOut className="h-4 w-4" /></button></div></div>
    </aside>

    <div className="min-w-0 flex-1">
      <header className="sticky top-0 z-30 flex h-16 items-center border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
        <button onClick={() => setMobileNavigationOpen(true)} aria-label="Open navigation" className="mr-3 rounded-xl border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 lg:hidden"><Menu className="h-5 w-5" /></button>
        <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-violet-600">Employee workspace</p><h1 className="truncate text-base font-bold text-slate-900 sm:text-lg">{page.title}</h1></div>
        <div className="ml-auto hidden items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 sm:flex"><span className="h-2 w-2 rounded-full bg-emerald-500" />Account active</div>
      </header>
      <main className="min-w-0 overflow-x-hidden px-3 py-4 sm:px-5 sm:py-6 lg:px-8 lg:py-8"><div className="mx-auto w-full max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div><p className="text-[11px] font-bold uppercase tracking-[.18em] text-[#8642ED]">{page.eyebrow}</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{page.title}</h1><p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">{page.description}</p></div>
          <div className="flex items-center gap-3"><span className="text-xs text-slate-500">{lastUpdated?`Updated ${lastUpdated.toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit'})}`:'Not updated'}</span><Button size="sm" variant="outline" disabled={refreshing} onClick={()=>void loadWorkspace(true)}><RefreshCw className={`h-4 w-4 ${refreshing?'animate-spin':''}`}/>Refresh</Button></div>
        </div>
        {refreshError&&workspace&&<div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">Latest refresh failed: {refreshError}. Showing the last successful information.</div>}

        {section === 'overview' && <div className="space-y-5">
          <section className="relative overflow-hidden rounded-3xl border border-violet-200 bg-gradient-to-br from-white via-violet-50 to-purple-100 px-6 py-7 text-slate-900 shadow-sm sm:px-8">
            <div className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-[#8642ED]/10 blur-3xl" />
            <div className="relative flex flex-col justify-between gap-6 md:flex-row md:items-end"><div><p className="text-sm font-semibold text-[#8642ED]">Welcome back,</p><h2 className="mt-1 break-words text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">{profile.name}</h2><p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">Your attendance, leave, and pay in one place.</p><div className="mt-5 flex flex-wrap gap-2"><span className="rounded-full bg-violet-100 px-3 py-1 text-xs capitalize text-violet-800 ring-1 ring-violet-200">{profile.role}</span><span className="rounded-full bg-emerald-50 px-3 py-1 text-xs capitalize text-emerald-700 ring-1 ring-emerald-200">{profile.status}</span><span className="rounded-full bg-white px-3 py-1 text-xs text-slate-700 ring-1 ring-violet-200">ID {profile.id}</span></div></div><div className="rounded-2xl border border-violet-200 bg-white/80 p-4 shadow-sm"><p className="text-[10px] font-bold uppercase tracking-wider text-violet-500">Fingerprint attendance</p><div className="mt-2 flex items-center gap-2"><Fingerprint className="h-5 w-5 text-[#8642ED]" /><span className="text-sm font-semibold capitalize text-slate-800">{profile.biometricStatus}</span></div></div></div>
          </section>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard icon={Clock3} label="Attendance records" value={`${attendanceSummary.present}/${attendanceSummary.total}`} note={`${attendanceSummary.sessions} sessions recorded`} tone="violet" />
            <MetricCard icon={CalendarDays} label="Leave credits" value={String(profile.monthlyLeaveCredits?.remaining ?? 0)} note={`Available for ${profile.monthlyLeaveCredits?.month ?? 'this month'}`} tone="emerald" />
            <MetricCard icon={CheckCircle2} label="Pending leave" value={String(workspace.leaveRequests.filter((item) => item.status === 'pending').length)} note="Waiting for admin review" tone="amber" />
            <MetricCard icon={WalletCards} label="Latest payroll" value={workspace.payroll[0] ? money(workspace.payroll[0].amount) : 'No record'} note={workspace.payroll[0]?.status ?? 'Nothing prepared yet'} tone="blue" />
          </section>
          <AttendanceFlagCard flag={workspace.attendanceFlag} />
          <div className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
            <Panel title="Recent attendance" subtitle="Your latest time records"><AttendanceRows records={workspace.attendance.slice(0, 4)} /></Panel>
            <Panel title="Account summary" subtitle="Information connected to your login"><div className="grid gap-3"><ProfileItem icon={Mail} label="Email" value={profile.email || 'Not provided'} /><ProfileItem icon={Phone} label="Phone" value={profile.phone || 'Not provided'} /><ProfileItem icon={ShieldCheck} label="Biometric access" value={profile.biometricStatus} /></div></Panel>
          </div>
        </div>}

        {section === 'attendance' && <div className="space-y-5">
          <div className="flex justify-end"><DateNavigator label="Attendance date" value={attendanceDate} onChange={setAttendanceDate} /></div>
          <Panel title={formatDate(attendanceDate)} subtitle="Up to three complete time-in and time-out sessions per day"><AttendanceRows records={selectedAttendance} showDate={false} /></Panel>
        </div>}

        {section === 'payroll' && <Panel title="Payroll history" subtitle="Open any pay period to view or print your personal payslip"><DataTable headers={['Pay period', 'Current pay', 'Carried balance', 'Total payout', 'Status', 'Summary']} rows={workspace.payroll.map((item) => [formatDate(item.periodStart), money(item.currentAmount), money(item.carryOverAmount), <strong key={`${item.id}-amount`} className="text-slate-900">{money(item.amount)}</strong>, <Status key={`${item.id}-status`} value={item.status} />, <button key={`${item.id}-view`} type="button" onClick={() => setSelectedPayrollId(item.id)} className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg border border-violet-200 bg-violet-50 px-3 text-xs font-semibold text-violet-700 hover:bg-violet-100 focus:outline-none focus:ring-4 focus:ring-violet-200"><Eye className="h-4 w-4" />View summary</button>])} empty="No payroll records yet." /></Panel>}

        {section === 'leave' && <div className="grid gap-5 xl:grid-cols-[.82fr_1.18fr]">
          <Panel title="Request leave" subtitle="Your administrator will review the dates you select"><MonthlyLeaveBalance balance={profile.monthlyLeaveCredits} /><form onSubmit={submitLeave} className="mt-5 space-y-4"><Field label="Leave type"><select value={leaveDraft.leaveType} onChange={(event) => setLeaveDraft((current) => ({ ...current, leaveType: event.target.value }))} className="input"><option>Annual Leave</option><option>Sick Leave</option><option>Personal Leave</option><option>Maternity Leave</option></select></Field><LeaveDatePicker selected={leaveDraft.requestedDates} workSchedule={workspace.workSchedule} onChange={(requestedDates)=>setLeaveDraft(current=>({...current,requestedDates}))}/><Field label="Reason"><textarea required minLength={5} maxLength={500} rows={4} value={leaveDraft.reason} onChange={(event) => setLeaveDraft((current) => ({ ...current, reason: event.target.value }))} className="input h-auto py-3" placeholder="Briefly explain your request" /></Field><button disabled={submitting||leaveDraft.requestedDates.length===0} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#8642ED] text-sm font-semibold text-white shadow-lg shadow-violet-600/15 hover:bg-violet-700 disabled:opacity-60"><Send className="h-4 w-4" />{submitting ? 'Submitting...' : `Submit ${leaveDraft.requestedDates.length} ${leaveDraft.requestedDates.length===1?'date':'dates'}`}</button></form></Panel>
          <Panel title="Request history" subtitle="Updates and decisions from your administrator"><DataTable headers={['Leave type', 'Dates', 'Days', 'Status']} rows={workspace.leaveRequests.map((item) => [item.leaveType, (item.approvedDates?.length?item.approvedDates:item.requestedDates)?.map(formatDate).join(', ')||`${formatDate(item.startDate)} – ${formatDate(item.endDate)}`, String(item.totalDays), <div key={item.id} className="flex flex-wrap items-center gap-2"><Status value={item.status} />{item.status==='pending'&&<button type="button" onClick={()=>setCancelLeaveTarget(item)} className="rounded-lg border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-300">Cancel</button>}</div>])} empty="No leave requests yet." /></Panel>
        </div>}

        {section === 'profile' && <div className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
          <div className="space-y-5"><Panel title="Employee information" subtitle="Contact an administrator to change protected information"><div className="grid gap-3 sm:grid-cols-2"><ProfileItem icon={UserRound} label="Employee ID" value={profile.id} /><ProfileItem icon={CalendarDays} label="Account created" value={profile.createdAt ? new Date(profile.createdAt).toLocaleString('en-PH') : 'Not recorded'} /><ProfileItem icon={WalletCards} label="Employment type" value={profile.role} /><ProfileItem icon={Mail} label="Email" value={profile.email || 'Not provided'} /></div></Panel>
          <Panel title="Contact information" subtitle="You can update your own phone number and address">{editingContact ? <form onSubmit={saveContactInformation} className="space-y-4"><Field label="Phone number"><input type="tel" autoComplete="tel" minLength={7} maxLength={30} required value={contactDraft.phone} onChange={(event) => setContactDraft((current) => ({ ...current, phone: event.target.value }))} className="input" placeholder="Enter your phone number" /></Field><Field label="Home address"><textarea autoComplete="street-address" minLength={5} maxLength={200} rows={3} required value={contactDraft.address} onChange={(event) => setContactDraft((current) => ({ ...current, address: event.target.value }))} className="input h-auto py-3" placeholder="Enter your current address" /></Field><div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={savingContact} onClick={cancelContactEditing} className="h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button><button type="submit" disabled={savingContact} className="flex h-11 items-center gap-2 rounded-xl bg-[#8642ED] px-4 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"><Save className="h-4 w-4" />{savingContact ? 'Saving...' : 'Save changes'}</button></div></form> : <div><div className="grid gap-3 sm:grid-cols-2"><ProfileItem icon={Phone} label="Phone" value={profile.phone || 'Not provided'} /><ProfileItem icon={MapPin} label="Address" value={profile.address || 'Not provided'} /></div><button type="button" onClick={() => setEditingContact(true)} className="mt-4 flex h-11 items-center gap-2 rounded-xl bg-[#8642ED] px-4 text-sm font-semibold text-white hover:bg-violet-700 focus:outline-none focus:ring-4 focus:ring-violet-300"><Pencil className="h-4 w-4" />Edit contact information</button></div>}</Panel></div>
          <div className="space-y-5"><Panel title="Attendance access" subtitle="Fingerprint registration status"><div className="flex items-center gap-4 rounded-2xl border border-violet-100 bg-violet-50 p-4"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-white text-[#8642ED] shadow-sm"><Fingerprint className="h-6 w-6" /></span><div><p className="text-xs text-violet-600">Biometric status</p><p className="font-bold capitalize text-violet-950">{profile.biometricStatus}</p></div></div></Panel><MonthlyLeaveBalance balance={profile.monthlyLeaveCredits} /></div>
        </div>}
      </div></main>
    </div>
    {selectedPayroll && <EmployeePayslip profile={profile} payroll={selectedPayroll} onClose={() => setSelectedPayrollId(null)} />}
    <Dialog open={Boolean(cancelLeaveTarget)} onClose={() => !cancellingLeave && setCancelLeaveTarget(null)} className="max-w-md"><DialogHeader><div><h2 className="text-base font-bold text-rose-700">Cancel leave request?</h2><p className="mt-1 text-sm leading-6 text-slate-600">This removes the pending request from the administrator's review list.</p></div><DialogClose onClose={() => !cancellingLeave && setCancelLeaveTarget(null)} /></DialogHeader><div className="space-y-4 px-6 pb-6 pt-3">{cancelLeaveTarget&&<div className="rounded-xl border border-slate-200 p-4"><p className="font-semibold text-slate-900">{cancelLeaveTarget.leaveType}</p><p className="mt-1 text-sm text-slate-600">{(cancelLeaveTarget.requestedDates?.length?cancelLeaveTarget.requestedDates:[cancelLeaveTarget.startDate,cancelLeaveTarget.endDate]).map(formatDate).join(', ')}</p></div>}<p className="text-sm leading-6 text-slate-600">You can submit a new request later if you still need leave.</p><div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={cancellingLeave} onClick={()=>setCancelLeaveTarget(null)}>Keep Request</Button><Button type="button" variant="destructive" disabled={cancellingLeave} onClick={()=>cancelLeaveTarget&&void cancelLeave(cancelLeaveTarget)}>{cancellingLeave?'Cancelling...':'Cancel Request'}</Button></div></div></Dialog>
  </div>
}

function AttendanceFlagCard({ flag }: { flag: AttendanceFlag }) {
  const styles = {
    green: { border: 'border-emerald-200', background: 'bg-emerald-50', text: 'text-emerald-900', icon: 'bg-emerald-100 text-emerald-700', label: 'Green — Regular monitoring' },
    orange: { border: 'border-amber-200', background: 'bg-amber-50', text: 'text-amber-950', icon: 'bg-amber-100 text-amber-700', label: 'Orange — Attendance review' },
    red: { border: 'border-red-200', background: 'bg-red-50', text: 'text-red-950', icon: 'bg-red-100 text-red-700', label: 'Red — Immediate attendance review' },
  }[flag.tier]
  return <section className={`rounded-2xl border p-5 ${styles.border} ${styles.background}`}>
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex gap-3"><span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${styles.icon}`}><AlertTriangle className="h-5 w-5" /></span><div><p className={`font-bold ${styles.text}`}>Your attendance status: {styles.label}</p><p className="mt-1 text-sm leading-6 text-slate-600">Automatically calculated from {formatDate(flag.periodStart)} to {formatDate(flag.periodEnd)}. Approved leave is not counted as an absence.</p></div></div>
      <span className={`w-fit rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${styles.icon}`}>{flag.tier}</span>
    </div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-white/80 bg-white/70 p-3"><p className="text-xs font-medium text-slate-500">Unapproved absences</p><p className="mt-1 text-2xl font-bold text-slate-950">{flag.absenceDays}</p></div><div className="rounded-xl border border-white/80 bg-white/70 p-3"><p className="text-xs font-medium text-slate-500">Late arrivals</p><p className="mt-1 text-2xl font-bold text-slate-950">{flag.lateDays}</p></div></div>
    <p className="mt-3 text-xs leading-5 text-slate-500">This status supports awareness and human review. Contact your administrator if a record appears incorrect.</p>
  </section>
}

function EmployeePayslip({ profile, payroll, onClose }: { profile: EmployeeProfile; payroll: Payroll; onClose: () => void }) {
  const additions = payroll.additions ?? []
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm print:static print:block print:bg-white print:p-0">
    <section role="dialog" aria-modal="true" aria-labelledby="employee-payslip-title" className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white shadow-2xl print:max-h-none print:max-w-none print:overflow-visible print:rounded-none print:shadow-none">
      <div className="print-payslip">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5 sm:px-8">
          <div><p className="text-xs font-bold uppercase tracking-[.18em] text-violet-600">WORKPULSE MVL</p><h2 id="employee-payslip-title" className="mt-1 text-2xl font-bold text-slate-950">Employee payslip</h2><p className="mt-1 text-sm text-slate-500">Pay period beginning {formatDate(payroll.periodStart)}</p></div>
          <button type="button" onClick={onClose} aria-label="Close payslip" className="no-print grid h-10 w-10 place-items-center rounded-xl text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        </header>
        <div className="space-y-5 px-6 py-6 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-violet-200 bg-violet-50 p-4"><div><p className="font-bold text-slate-950">{profile.name}</p><p className="mt-0.5 text-sm text-slate-600">Employee ID: {profile.id}</p></div><Status value={payroll.status} /></div>
          {payroll.warnings?.length ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4"><p className="font-semibold text-amber-900">Attendance reminder</p>{payroll.warnings.map((warning) => <p key={warning} className="mt-1 text-sm text-amber-800">• {warning}</p>)}</div> : null}
          <div className="grid gap-3 sm:grid-cols-3"><PayslipStat label="Hours worked" value={`${Number(payroll.hoursWorked || 0).toFixed(2)} hours`} /><PayslipStat label="Hourly rate" value={money(payroll.hourlyRate)} /><PayslipStat label="Current earnings" value={money(payroll.currentAmount)} /></div>
          <div className="overflow-hidden rounded-2xl border border-slate-200"><PayslipMoney label="Attendance-based pay" value={Number(payroll.grossAmount || 0)} />{additions.map((item, index) => <PayslipMoney key={`${item.label}-${index}`} label={item.label} value={item.value} plus />)}{Number(payroll.carryOverAmount || 0) > 0 && <PayslipMoney label="Carried unpaid balance" value={Number(payroll.carryOverAmount)} plus />}<div className="flex items-center justify-between gap-4 bg-emerald-50 px-4 py-5"><span className="font-bold text-emerald-950">Total payout</span><span className="text-2xl font-bold text-emerald-700">{money(payroll.amount)}</span></div></div>
          <div className="grid gap-2 text-sm text-slate-600 sm:grid-cols-2"><p><span className="font-semibold text-slate-800">Payroll status:</span> <span className="capitalize">{payroll.status.replace('_', ' ')}</span></p><p><span className="font-semibold text-slate-800">Payment date:</span> {payroll.paidAt ? new Date(payroll.paidAt).toLocaleString('en-PH') : 'Not paid yet'}</p></div>
          <div className="no-print flex flex-wrap justify-end gap-2"><button type="button" onClick={onClose} className="h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Close</button><button type="button" onClick={() => window.print()} className="flex h-11 items-center gap-2 rounded-xl bg-[#8642ED] px-4 text-sm font-semibold text-white hover:bg-violet-700"><Printer className="h-4 w-4" />Print payslip</button></div>
        </div>
      </div>
    </section>
  </div>
}

function PayslipStat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p><p className="mt-1 font-bold text-slate-950">{value}</p></div>
}

function PayslipMoney({ label, value, plus = false }: { label: string; value: number; plus?: boolean }) {
  return <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-4 py-3 text-sm"><span className="text-slate-600">{label}</span><span className="font-semibold text-slate-900">{plus ? '+' : ''}{money(value)}</span></div>
}

function AttendanceRows({ records, showDate = true }: { records: Attendance[]; showDate?: boolean }) {
  if (!records.length) return <EmptyState icon={Clock3} text="No attendance record was found for this date." />
  return <div className="space-y-3">{records.map((record) => {
    const sessions = attendanceSessions(record)
    return <div key={record.date} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div>{showDate && <p className="text-sm font-bold text-slate-900">{formatDate(record.date)}</p>}<p className="text-xs text-slate-500">{record.status === 'On Leave' ? 'Approved leave — no time-in required' : `${sessions.length} of 3 attendance sessions used`}</p></div><Status value={record.status} /></div>{record.status !== 'On Leave' && <div className="mt-3 grid gap-2 sm:grid-cols-3">{[0, 1, 2].map((index) => { const session = sessions[index]; return <div key={`${record.date}-${index}`} className={`rounded-xl border px-3 py-3 ${session ? 'border-violet-100 bg-white' : 'border-dashed border-slate-200 bg-slate-50'}`}><p className={`text-[10px] font-bold uppercase tracking-wider ${session ? 'text-[#8642ED]' : 'text-slate-400'}`}>Session {index + 1}</p>{session ? <p className="mt-1 text-xs font-semibold text-slate-700">{formatTime(session.checkIn)} <span className="mx-1 text-slate-300">→</span> {session.checkOut ? formatTime(session.checkOut) : <span className="text-amber-600">Currently clocked in</span>}</p> : <p className="mt-1 text-xs text-slate-400">Not used</p>}</div> })}</div>}</div>
  })}</div>
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 px-5 py-4 sm:px-6"><h2 className="text-lg font-bold text-slate-950">{title}</h2><p className="mt-0.5 text-sm text-slate-500">{subtitle}</p></div><div className="p-5 sm:p-6">{children}</div></section>
}

function MetricCard({ icon: Icon, label, value, note, tone }: { icon: typeof Clock3; label: string; value: string; note: string; tone: 'violet' | 'emerald' | 'amber' | 'blue' }) {
  const colors = { violet: 'bg-violet-50 text-[#8642ED]', emerald: 'bg-emerald-50 text-emerald-600', amber: 'bg-amber-50 text-amber-600', blue: 'bg-sky-50 text-sky-600' }[tone]
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className={`grid h-10 w-10 place-items-center rounded-xl ${colors}`}><Icon className="h-5 w-5" /></div><p className="mt-4 text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 truncate text-2xl font-bold text-slate-950">{value}</p><p className="mt-1 text-xs capitalize text-slate-500">{note}</p></div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700">{label}</span>{children}</label>
}

function Status({ value }: { value: string }) {
  const good = ['approved', 'paid', 'Present', 'active'].includes(value)
  const bad = ['rejected', 'Absent'].includes(value)
  const label = value === 'processing' ? 'Ready to pay' : value === 'rejected' ? 'Payment on hold' : value === 'carried_over' ? 'Carried to next period' : value
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${good ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : bad ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-200' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'}`}>{label}</span>
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: React.ReactNode[][]; empty: string }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead><tr className="border-b border-slate-200 bg-slate-50/70">{headers.map((header) => <th key={header} className="px-4 py-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} className="border-b border-slate-100 transition last:border-0 hover:bg-slate-50/70">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-4 py-4 text-slate-600">{cell}</td>)}</tr>)}</tbody></table>{!rows.length && <EmptyState icon={WalletCards} text={empty} />}</div>
}

function EmptyState({ icon: Icon, text }: { icon: typeof Clock3; text: string }) {
  return <div className="py-12 text-center"><span className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-slate-100 text-slate-400"><Icon className="h-5 w-5" /></span><p className="mt-3 text-sm text-slate-400">{text}</p></div>
}

function ProfileItem({ icon: Icon, label, value }: { icon: typeof UserRound; label: string; value: string }) {
  return <div className="flex min-w-0 items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-4"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white text-[#8642ED] shadow-sm"><Icon className="h-4 w-4" /></span><div className="min-w-0"><p className="text-xs text-slate-400">{label}</p><p className="mt-0.5 break-words font-semibold capitalize text-slate-800">{value}</p></div></div>
}

function MonthlyLeaveBalance({ balance }: { balance?: { month: string; total: number; used: number; remaining: number } }) {
  const total = Math.max(0, Number(balance?.total || 0))
  const remaining = Math.max(0, Number(balance?.remaining || 0))
  const percent = total ? Math.min(100, remaining / total * 100) : 0
  return <div className="rounded-2xl border border-violet-100 bg-violet-50/70 p-5"><div className="flex items-center gap-2 text-sm font-semibold text-violet-950"><CheckCircle2 className="h-4 w-4 text-[#8642ED]" />Monthly leave credits</div><div className="mt-4 flex items-end justify-between gap-3"><p className="text-3xl font-bold text-[#8642ED]">{remaining}</p><p className="pb-1 text-xs text-violet-600">of {total} remaining</p></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-violet-100"><div className="h-full rounded-full bg-[#8642ED]" style={{ width: `${percent}%` }} /></div><p className="mt-2 text-xs text-violet-600">{balance?.used ?? 0} used for {balance?.month ?? 'this month'}</p></div>
}
