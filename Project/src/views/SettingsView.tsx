import { AdminPageHeader } from "../components/AdminPageHeader";
import { useEffect, useState } from "react";
import { Settings, CalendarDays, ChevronLeft, ChevronRight, Clock, Eye, EyeOff, Info, KeyRound, Save, WalletCards } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/Card";
import { Input, Label } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { apiFetch } from "../lib/api";
import { Dialog, DialogClose, DialogHeader } from "../components/ui/Dialog";

type Settings = {
  shift: { enabled: boolean; startTime: string; autoClockOutTime: string; lateGraceMinutes: number | ""; workDays: number; workWeekdays: number[]; scheduleOverrides: { date: string; working: boolean; kind?: "holiday" | "rest-day" | "workday" }[] };
  leave: { monthlyCredits: number | "" };
  payroll: { hourlyRates: { regular: number | ""; extra: number | "" } };
};

function isoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayInManila() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function monthDates(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  return {
    leading: first.getDay(),
    dates: Array.from({ length: count }, (_, index) => { const date = new Date(first); date.setDate(index + 1); return { value: isoDate(date), day: date.toLocaleDateString("en-PH", { weekday: "short" }), number: index + 1 }; }),
  };
}

const defaults: Settings = {
  shift: { enabled: true, startTime: "09:00", autoClockOutTime: "18:00", lateGraceMinutes: 0, workDays: 5, workWeekdays: [1, 2, 3, 4, 5], scheduleOverrides: [] },
  leave: { monthlyCredits: 10 },
  payroll: { hourlyRates: { regular: 50, extra: 40 } },
};

export function SettingsView() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<Settings>(defaults);
  const [saving, setSaving] = useState(false);
  const [scheduleMonth, setScheduleMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const [scheduleMode, setScheduleMode] = useState<"holiday" | "rest-day" | "workday">("holiday");
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const visibleScheduleDates = monthDates(scheduleMonth);
  const today = todayInManila();
  const specialScheduleActive = settings.shift.scheduleOverrides.some((entry) => entry.date >= today);

  useEffect(() => {
    apiFetch("/api/settings")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setSettings({
        shift: { ...defaults.shift, ...(data.shift ?? {}) },
        leave: { ...defaults.leave, ...(data.leave ?? {}) },
        payroll: { hourlyRates: { ...defaults.payroll.hourlyRates, ...(data.payroll?.hourlyRates ?? {}) } },
      }))
      .catch(() => undefined);
  }, []);

  const setShift = (value: Partial<Settings["shift"]>) => {
    setSettings((current) => ({ ...current, shift: { ...current.shift, ...value } }));
  };

  const save = async () => {
    if (!adminPassword) return;
    if (settings.shift.lateGraceMinutes === "" || settings.leave.monthlyCredits === "" || settings.payroll.hourlyRates.regular === "" || settings.payroll.hourlyRates.extra === "") {
      toast({ title: "Complete the number fields", description: "Enter the attendance, leave-credit, and hourly-rate values before saving.", variant: "error" });
      return;
    }
    setSaving(true);
    try {
      const response = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, adminPassword }),
      });
      const saved = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(saved.error || "The server could not save your settings.");
      setSettings({
        shift: { ...defaults.shift, ...(saved.shift ?? {}) },
        leave: { ...defaults.leave, ...(saved.leave ?? {}) },
        payroll: { hourlyRates: { ...defaults.payroll.hourlyRates, ...(saved.payroll?.hourlyRates ?? {}) } },
      });
      setAdminPassword("");
      setPasswordDialogOpen(false);
      toast({ title: "Settings saved", description: "The company rules are now up to date.", variant: "success" });
    } catch (reason) {
      toast({ title: "Settings not saved", description: reason instanceof Error ? reason.message : "Please try again.", variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <AdminPageHeader title="System Settings" description="Set attendance, leave, and pay rules. Save when finished." icon={Settings} />

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <Card className="overflow-hidden self-start lg:col-span-2 lg:row-span-2">
          <CardHeader className="border-b border-slate-100 bg-slate-50/70">
            <div className="flex items-start justify-between gap-4">
              <div className="flex gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-100">
                  <Clock className="h-5 w-5 text-[#8642ED]" />
                </div>
                <div>
                  <CardTitle>Work Hour Control</CardTitle>
                  <CardDescription>Set the normal work start and automatic clock-out times.</CardDescription>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 pt-5">
            <p className="text-sm text-slate-500">Work-hour rules apply automatically.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Work starts at</Label>
                <Input type="time" value={settings.shift.startTime} onChange={(event) => setShift({ startTime: event.target.value })} />
                <p className="text-xs text-slate-500">The company’s usual starting time.</p>
              </div>
              <div className="space-y-2">
                <Label>Automatic clock-out at</Label>
                <Input type="time" value={settings.shift.autoClockOutTime} onChange={(event) => setShift({ autoClockOutTime: event.target.value })} />
                <p className="text-xs text-slate-500">Open attendance sessions close automatically at this company time.</p>
              </div>
            </div>

            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4">
              <div className="flex items-start gap-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700"><Clock className="h-4 w-4" /></div>
                <div className="flex-1 space-y-3">
                  <div><p className="text-sm font-semibold text-amber-950">Late Arrival Rule</p><p className="mt-1 text-xs leading-5 text-amber-800">Add a grace period after the configured work start time.</p></div>
                  <div className="max-w-xs space-y-2"><Label>Grace period after work starts</Label><div className="relative"><Input className="no-number-arrows pr-20" type="number" min="0" max="180" step="1" value={settings.shift.lateGraceMinutes} onChange={(event) => setShift({ lateGraceMinutes: event.target.value === "" ? "" : Number(event.target.value) })} /><span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium text-slate-500">minutes</span></div><p className="text-xs text-amber-800">Example: an 08:00 AM start with 15 minutes means 08:15 is on time and 08:16 is late.</p></div>
                </div>
              </div>
            </div>

            <div className="hidden">
              <Label>Normal work days each week</Label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {[5, 6, 7].map((days) => (
                  <button key={days} type="button" disabled={specialScheduleActive} onClick={() => setShift({ workDays: days, workWeekdays: Array.from({ length: days }, (_, index) => index + 1).map((day) => day === 7 ? 0 : day) })} className={`rounded-xl border px-3 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 ${!specialScheduleActive && settings.shift.workDays === days ? "border-violet-400 bg-violet-50 text-violet-700" : "border-slate-200 bg-white text-slate-600 hover:border-violet-200"}`}>
                    {days} days
                  </button>
                ))}
              </div>
              {specialScheduleActive && <p className="text-xs text-slate-500">Normal schedule choices are paused while special dates exist.</p>}
              {!specialScheduleActive && <div className="space-y-2 pt-1"><p className="text-xs font-semibold text-slate-700">Select exactly {settings.shift.workDays} regular workdays</p><div className="grid grid-cols-4 gap-2 sm:grid-cols-7">{[[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"],[6,"Sat"],[0,"Sun"]].map(([day,label]) => {
                const selected = settings.shift.workWeekdays.includes(day as number);
                return <button key={day} type="button" aria-pressed={selected} onClick={() => setShift({ workWeekdays: selected ? settings.shift.workWeekdays.filter((value) => value !== day) : settings.shift.workWeekdays.length < settings.shift.workDays ? [...settings.shift.workWeekdays, day as number] : settings.shift.workWeekdays })} className={`rounded-lg border px-2 py-2 text-xs font-bold transition ${selected ? "border-violet-400 bg-violet-100 text-violet-800" : "border-slate-200 bg-white text-slate-500 hover:border-violet-300"}`}>{label}</button>;
              })}</div><p className={`text-xs ${settings.shift.workWeekdays.length === settings.shift.workDays ? "text-emerald-600" : "font-medium text-amber-600"}`}>{settings.shift.workWeekdays.length} of {settings.shift.workDays} days selected{settings.shift.workWeekdays.length === settings.shift.workDays ? "." : " — select the remaining days before saving."}</p></div>}
            </div>

            <div className="space-y-4 rounded-2xl border border-violet-200 bg-violet-50/50 p-4 sm:p-5">
              <div><p className="text-base font-bold text-violet-950">Holiday and Rest-Day Calendar</p><p className="mt-1 text-xs leading-5 text-violet-700">Choose a type, then select dates. Non-working dates block attendance, never create absences, and do not consume leave credits.</p></div>
              <div className="inline-flex rounded-xl border border-violet-200 bg-white p-1">{([['holiday','Holiday'],['rest-day','Rest Day'],['workday','Workday']] as const).map(([value,label])=><button key={value} type="button" onClick={()=>setScheduleMode(value)} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${scheduleMode===value?'bg-violet-600 text-white shadow-sm':'text-slate-500 hover:bg-violet-50'}`}>{label}</button>)}</div>
              <div className="flex items-center justify-between rounded-xl bg-white px-3 py-2 shadow-sm"><button type="button" aria-label="Previous month" onClick={()=>setScheduleMonth(current=>new Date(current.getFullYear(),current.getMonth()-1,1))} className="rounded-lg p-2 text-slate-500 hover:bg-violet-50"><ChevronLeft size={18}/></button><p className="text-sm font-bold text-slate-800">{scheduleMonth.toLocaleDateString('en-PH',{month:'long',year:'numeric'})}</p><button type="button" aria-label="Next month" onClick={()=>setScheduleMonth(current=>new Date(current.getFullYear(),current.getMonth()+1,1))} className="rounded-lg p-2 text-slate-500 hover:bg-violet-50"><ChevronRight size={18}/></button></div>
              <div className="grid grid-cols-7 gap-1.5 text-center">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day=><span key={day} className="py-1 text-[10px] font-bold text-slate-500">{day}</span>)}{Array.from({length:visibleScheduleDates.leading},(_,index)=><span key={`blank-${index}`}/>)}{visibleScheduleDates.dates.map(item=>{const isPast=item.value<today;const override=settings.shift.scheduleOverrides.find(entry=>entry.date===item.value);const normalWorking=settings.shift.workWeekdays.includes(new Date(`${item.value}T12:00:00`).getDay());const kind=override?.kind??(override?.working===false?'rest-day':override?.working===true?'workday':normalWorking?'workday':'rest-day');const styles=kind==='holiday'?'border-rose-300 bg-rose-50 text-rose-700':kind==='rest-day'?'border-slate-300 bg-slate-100 text-slate-600':'border-emerald-200 bg-emerald-50 text-emerald-700';return <button key={item.value} type="button" disabled={isPast} aria-disabled={isPast} aria-label={`${item.value}: ${kind}${isPast?', past date locked':''}`} title={isPast?`${item.day}, ${item.value}: past dates cannot be changed`:`${item.day}, ${item.value}: ${kind.replace('-',' ')}`} onClick={()=>{const same=override?.kind===scheduleMode;const remaining=settings.shift.scheduleOverrides.filter(entry=>entry.date!==item.value);setShift({scheduleOverrides:(same?remaining:[...remaining,{date:item.value,working:scheduleMode==='workday',kind:scheduleMode}]).sort((a,b)=>a.date.localeCompare(b.date))})}} className={`min-h-16 rounded-xl border p-1 text-center transition ${isPast?'cursor-not-allowed grayscale opacity-45':'hover:-translate-y-0.5 hover:shadow-sm'} ${styles}`}><span className="block text-xs font-bold">{item.number}</span><span className="mt-1 block truncate text-[9px] font-semibold capitalize">{isPast?'Locked':kind.replace('-',' ')}</span></button>})}</div>
              <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap gap-3 text-[10px] font-semibold"><span className="text-emerald-700">● Workday</span><span className="text-rose-700">● Holiday</span><span className="text-slate-600">● Rest day</span><span className="text-slate-400">● Past date locked</span></div>{settings.shift.scheduleOverrides.some(entry=>entry.date>=today)&&<Button type="button" size="sm" variant="ghost" onClick={()=>setShift({scheduleOverrides:settings.shift.scheduleOverrides.filter(entry=>entry.date<today)})}>Clear Editable Dates</Button>}</div>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden self-start">
          <CardHeader className="border-b border-slate-100 bg-slate-50/70">
            <div className="flex gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50">
                <CalendarDays className="h-5 w-5 text-emerald-600" />
              </div>
              <div>
                <CardTitle>Monthly Leave Credits</CardTitle>
                <CardDescription>The administrator decides how many leave credits are provided each month.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 pt-5">
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm font-semibold text-emerald-900">Monthly allowance</p>
              <p className="mt-1 text-xs text-emerald-700">The initial company setting is 10 credits. You can change it below.</p>
            </div>

            <div className="space-y-2">
              <Label>Leave credits per employee, per month</Label>
              <div className="relative max-w-xs">
                <Input className="no-number-arrows pr-20 text-lg font-semibold" type="number" min="0" max="31" step="1" value={settings.leave.monthlyCredits} onChange={(event) => setSettings((current) => ({ ...current, leave: { monthlyCredits: event.target.value === "" ? "" : Number(event.target.value) } }))} />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-400">credits</span>
              </div>
            </div>

            <div className="flex gap-2 rounded-xl bg-sky-50 p-4 text-xs leading-5 text-sky-800">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>This is a monthly company allowance. Change the number whenever management updates the leave policy.</p>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden self-start lg:col-start-3">
          <CardHeader className="border-b border-slate-100 bg-slate-50/70">
            <div className="flex gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50">
                <WalletCards className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <CardTitle>Hourly Pay Rates</CardTitle>
                <CardDescription>Set the company rate used to calculate attendance-based payroll.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 pt-5">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              New rates update future and unpaid payroll calculations. Paid payroll remains unchanged.
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label htmlFor="regular-hourly-rate">Regular employee rate</Label><div className="relative"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">₱</span><Input id="regular-hourly-rate" className="no-number-arrows pl-8 pr-16" type="number" min="1" max="10000" step="0.01" value={settings.payroll.hourlyRates.regular} onChange={(event) => setSettings((current) => ({ ...current, payroll: { hourlyRates: { ...current.payroll.hourlyRates, regular: event.target.value === "" ? "" : Number(event.target.value) } } }))} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">/ hour</span></div></div>
              <div className="space-y-2"><Label htmlFor="extra-hourly-rate">Extra employee rate</Label><div className="relative"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">₱</span><Input id="extra-hourly-rate" className="no-number-arrows pl-8 pr-16" type="number" min="1" max="10000" step="0.01" value={settings.payroll.hourlyRates.extra} onChange={(event) => setSettings((current) => ({ ...current, payroll: { hourlyRates: { ...current.payroll.hourlyRates, extra: event.target.value === "" ? "" : Number(event.target.value) } } }))} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">/ hour</span></div></div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2" role="status" aria-live="polite">
              <div className="rounded-xl border border-violet-100 bg-violet-50 p-3"><p className="text-xs font-semibold text-violet-700">Regular employee example</p><p className="mt-1 text-sm text-violet-950">8 completed hours × ₱{Number(settings.payroll.hourlyRates.regular || 0).toFixed(2)} = <strong>₱{(8 * Number(settings.payroll.hourlyRates.regular || 0)).toFixed(2)}</strong></p></div>
              <div className="rounded-xl border border-violet-100 bg-violet-50 p-3"><p className="text-xs font-semibold text-violet-700">Extra employee example</p><p className="mt-1 text-sm text-violet-950">8 completed hours × ₱{Number(settings.payroll.hourlyRates.extra || 0).toFixed(2)} = <strong>₱{(8 * Number(settings.payroll.hourlyRates.extra || 0)).toFixed(2)}</strong></p></div>
            </div>
            <p className="text-xs leading-5 text-slate-500">Payroll is calculated as completed attendance hours × the employee type’s hourly rate, plus approved additions and carried balances.</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col-reverse gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-slate-500">Changes only take effect after you select Save Settings.</p>
        <div className="flex gap-3">
          <Button onClick={() => setPasswordDialogOpen(true)} disabled={saving}><Save className="h-4 w-4" />Save Settings</Button>
        </div>
      </div>
      <Dialog open={passwordDialogOpen} onClose={() => !saving && setPasswordDialogOpen(false)}>
        <DialogHeader><div><div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-violet-100 text-violet-700"><KeyRound className="h-5 w-5" /></div><h3 className="text-lg font-bold text-slate-950">Confirm settings changes</h3><p className="mt-1 text-sm text-slate-500">Enter your administrator password before applying company rules and hourly rates.</p></div><DialogClose onClose={() => !saving && setPasswordDialogOpen(false)} /></DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-4 px-6 pb-6 pt-3">
          <div className="space-y-2"><Label htmlFor="settings-admin-password">Administrator password</Label><div className="relative"><Input id="settings-admin-password" autoFocus autoComplete="current-password" type={showAdminPassword ? "text" : "password"} required value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} className="pr-12" placeholder="Enter your password" /><button type="button" onClick={() => setShowAdminPassword((shown) => !shown)} aria-label={showAdminPassword ? "Hide password" : "Show password"} className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-slate-500 hover:bg-slate-100">{showAdminPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></div>
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={saving} onClick={() => setPasswordDialogOpen(false)}>Cancel</Button><Button type="submit" disabled={saving || !adminPassword}><Save className="h-4 w-4" />{saving ? "Saving..." : "Confirm and save"}</Button></div>
        </form>
      </Dialog>
    </div>
  );
}
