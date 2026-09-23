import { AdminPageHeader } from "../components/AdminPageHeader";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, BrainCircuit, CalendarDays, ChevronRight,
  Clock3, Flag, RefreshCw, ShieldCheck, Sparkles, TrendingUp, Users,
} from "lucide-react";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { FingerprintEvaluation, type EvaluationSummary } from "../components/biometric/FingerprintEvaluation";
import { apiFetch } from "../lib/api";
import { cn } from "../lib/util";
import { PaginationControls } from "../components/ui/Pagination";
import { usePagination } from "../hooks/usePagination";

type Readiness = "ready" | "limited";
type InsightKey = "forecast" | "risk" | "anomaly" | "verification";
type ForecastDay = { date: string; expectedPresent: number; attendanceRate: number; weekdayAverage: number; weekdaySamples: number; trendDirection: "stable" | "increasing" | "decreasing"; explanation: string };
type RiskEmployee = { employeeId: string; name: string; tier: "green" | "orange" | "red"; absenceDays: number; absenceDates: string[]; lateDays: number };
type Anomaly = { employeeId: string; name: string; date: string; time: string; score: number; deviationMinutes: number };
type Scanner = { deviceUid: string; scans: number; averageScore: number; health: number; status: "healthy" | "attention" | "critical" };
type RecentMatch = { employeeId: string | null; name: string; action: "time-in" | "time-out" | "daily-limit" | "recognized" | "no-match"; eventTime: string | null; scannedAt: string | null; deviceUid: string; score: number | null; matchStrength: number | null; accepted: boolean; responseTimeMs: number | null };
type Insights = {
  generatedAt: string;
  forecast: { version: string; status: Readiness; sampleDays: number; clockInDays: number; activeEmployees: number; latestDataDate: string | null; dataStale: boolean; summary: string; forecast: ForecastDay[] };
  risk: { version: string; status: Readiness; periodStart: string; periodEnd: string; employeesAnalyzed: number; flagged: number; summary: string; employees: RiskEmployee[] };
  anomaly: { version: string; status: Readiness; sampleScans: number; medianTime: string; madMinutes: number; scaleMinutes: number; summary: string; anomalies: Anomaly[] };
  verification: { version: string; status: Readiness; matchesAnalyzed: number; threshold: number; averageHealth: number; summary: string; scanners: Scanner[]; recentMatches: RecentMatch[]; evaluation: EvaluationSummary };
  disclaimer: string;
};

const modelMeta = {
  forecast: { title: "Expected Attendance", label: "Attendance outlook", icon: TrendingUp, accent: "violet", formula: "Uses recent attendance patterns", description: "Shows an estimate of how many employees may be present during the next seven days." },
  risk: { title: "Attendance Flags", label: "30-day review", icon: Users, accent: "amber", formula: "Counts absences without approved leave", description: "Uses clear Green, Orange, and Red flags based on absences during the last 30 days." },
  anomaly: { title: "Arrival Time Review", label: "Arrival review", icon: Clock3, accent: "sky", formula: "Compares arrivals with the usual time", description: "Shows clock-ins that are much earlier or later than the usual arrival time for review." },
  verification: { title: "Fingerprint Scanner Status", label: "Scanner status", icon: ShieldCheck, accent: "emerald", formula: "Checks recognition results and reader performance", description: "Shows whether fingerprint readers are working normally or may need attention." },
} as const;

const accents = {
  violet: { border: "border-violet-300", wash: "from-violet-600 to-fuchsia-500", pale: "bg-violet-50", text: "text-violet-700", ring: "ring-violet-200", bar: "bg-violet-500" },
  amber: { border: "border-amber-300", wash: "from-amber-500 to-orange-500", pale: "bg-amber-50", text: "text-amber-700", ring: "ring-amber-200", bar: "bg-amber-500" },
  sky: { border: "border-sky-300", wash: "from-sky-500 to-cyan-500", pale: "bg-sky-50", text: "text-sky-700", ring: "ring-sky-200", bar: "bg-sky-500" },
  emerald: { border: "border-emerald-300", wash: "from-emerald-500 to-teal-500", pale: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200", bar: "bg-emerald-500" },
} as const;

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00Z`));
}

function ReadinessBadge({ status }: { status: Readiness }) {
  return <Badge variant={status === "ready" ? "success" : "warning"}>{status === "ready" ? "Ready" : "Limited data"}</Badge>;
}

function MetricCard({ modelKey, selected, insights, onSelect }: { modelKey: InsightKey; selected: boolean; insights: Insights; onSelect: () => void }) {
  const meta = modelMeta[modelKey];
  const style = accents[meta.accent];
  const Icon = meta.icon;
  const value = modelKey === "forecast" ? `${insights.forecast.forecast[0]?.attendanceRate ?? 0}%`
    : modelKey === "risk" ? insights.risk.flagged
    : modelKey === "anomaly" ? insights.anomaly.anomalies.length
    : scannerOverallLabel(insights.verification.scanners);
  const caption = modelKey === "forecast" ? "tomorrow's expected rate"
    : modelKey === "risk" ? "employees to review"
    : modelKey === "anomaly" ? "unusual arrivals"
    : "overall reader condition";
  return (
    <button type="button" data-guide={`ai-${modelKey}`} onClick={onSelect} aria-pressed={selected} aria-label={`${meta.title}: ${value} ${caption}`}
      className={cn("group relative overflow-hidden rounded-2xl border bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md", selected ? `${style.border} ring-4 ${style.ring}` : "border-slate-200")}>
      <div className={cn("absolute inset-x-0 top-0 h-1 bg-gradient-to-r", style.wash)} />
      <div className="flex items-start justify-between gap-3">
        <span className={cn("grid h-11 w-11 place-items-center rounded-xl", style.pale, style.text)}><Icon size={21} /></span>
        <ReadinessBadge status={insights[modelKey].status} />
      </div>
      <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">{meta.label}</p>
      <div className="mt-1 flex items-end justify-between gap-3">
        <div><p className={cn("font-bold tracking-tight text-slate-950", modelKey === "verification" ? "text-xl" : "text-3xl")}>{value}</p><p className="mt-1 text-xs text-slate-500">{caption}</p></div>
        <ChevronRight className={cn("mb-2 transition group-hover:translate-x-1", style.text)} size={18} />
      </div>
    </button>
  );
}

function ForecastPanel({ data }: { data: Insights["forecast"] }) {
  return <div className="space-y-5">
    <div className="flex gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm leading-6 text-violet-950"><TrendingUp className="mt-0.5 shrink-0 text-violet-600" size={17} aria-hidden="true" /><p><strong>This is an estimate, not a final result.</strong> It uses recent attendance patterns and may change when new records are added.</p></div>
    {data.dataStale && <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"><AlertTriangle className="mt-0.5 shrink-0 text-amber-600" size={17} aria-hidden="true" /><p><strong>Attendance data is not current.</strong> {data.latestDataDate ? <>The newest attendance record is from {shortDate(data.latestDataDate)}.</> : <>No attendance records are available.</>} The projection starts tomorrow, but it will remain limited until newer clock-ins are recorded.</p></div>}
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Clock-in history" value={`${data.clockInDays} days`} />
      <Stat label="Active workforce" value={String(data.activeEmployees)} />
      <Stat label="Tomorrow" value={`${data.forecast[0]?.expectedPresent ?? 0} expected`} />
      <Stat label="7-day average" value={`${Math.round(data.forecast.reduce((sum, item) => sum + item.attendanceRate, 0) / Math.max(1, data.forecast.length))}%`} />
    </div>
    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-700"><CalendarDays size={16} className="text-violet-600" /> Seven-day projection</div>
      <div className="grid grid-cols-7 gap-2" role="list" aria-label="Expected attendance for the next seven days">
        {data.forecast.map((day) => <div key={day.date} role="listitem" tabIndex={0} aria-label={`${shortDate(day.date)}: ${day.expectedPresent} employees expected, ${day.attendanceRate} percent. ${day.explanation}`} className="group relative flex min-w-0 flex-col items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
          <div aria-hidden="true" className="flex h-28 w-full items-end overflow-hidden rounded-lg bg-white ring-1 ring-slate-200"><div className="w-full rounded-t-md bg-gradient-to-t from-violet-600 to-fuchsia-400 transition-all" style={{ height: `${Math.max(5, day.attendanceRate)}%` }} /></div>
          <span className="mt-2 text-[10px] font-semibold text-slate-600 sm:text-xs">{shortDate(day.date).split(",")[0]}</span>
          <span className="text-[10px] text-slate-400">{day.expectedPresent}</span>
          <div role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-64 -translate-x-1/2 rounded-xl bg-slate-950 p-3 text-left text-xs leading-5 text-white shadow-xl group-hover:block group-focus:block"><strong>Why this estimate?</strong><span className="mt-1 block text-slate-200">{day.explanation}</span></div>
        </div>)}
      </div>
    </div>
  </div>;
}

function flagLabel(tier: RiskEmployee["tier"]) { return tier === "green" ? "Green flag" : tier === "orange" ? "Orange flag" : "Red flag"; }
function AttendanceFlagIcon({ tier, size = 25 }: { tier: RiskEmployee["tier"]; size?: number }) {
  const color = tier === "green" ? "text-emerald-500" : tier === "orange" ? "text-orange-500" : "text-red-600";
  return <span className={cn("inline-grid place-items-center", color)} role="img" aria-label={flagLabel(tier)} title={flagLabel(tier)}><Flag size={size} fill="currentColor" strokeWidth={2.2} aria-hidden="true" /></span>;
}
function RiskPanel({ data }: { data: Insights["risk"] }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | RiskEmployee["tier"] | "late">("all");
  const visibleEmployees = useMemo(() => data.employees.filter(employee => employee.name.toLowerCase().includes(search.trim().toLowerCase()) && (filter === "all" || filter === "late" ? filter === "all" || employee.lateDays > 0 : employee.tier === filter)), [data.employees, filter, search]);
  const riskPage = usePagination(visibleEmployees, `${data.periodStart}-${data.periodEnd}-${search}-${filter}`, 10);
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-3">
      <FlagLegend color="green" title="Green flag" range="0–15 absences" note="Within the selected monthly rule" />
      <FlagLegend color="orange" title="Orange flag" range="16–25 absences" note="Review the attendance record" />
      <FlagLegend color="red" title="Red flag" range="26–30 absences" note="Needs prompt human review" />
    </div>
    <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"><AlertTriangle className="mt-0.5 shrink-0 text-amber-600" size={17} aria-hidden="true" /><p><strong>Simple 30-day rule:</strong> The flag counts absences without approved leave from {shortDate(data.periodStart)} to {shortDate(data.periodEnd)}. Review the employee's schedule and circumstances before making a decision.</p></div>
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center"><input type="search" aria-label="Search employees in attendance flags" placeholder="Search employee name..." value={search} onChange={event=>setSearch(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-500"/><div className="flex flex-wrap gap-1">{([['all','All'],['green','Green'],['orange','Orange'],['red','Red'],['late','With late arrivals']] as const).map(([value,label])=><button key={value} type="button" onClick={()=>setFilter(value)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${filter===value?'bg-violet-600 text-white':'bg-slate-100 text-slate-600'}`}>{label}</button>)}</div></div>
    <div className="overflow-hidden rounded-2xl border border-slate-200">
      <div className="grid grid-cols-[1fr_auto] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500 sm:grid-cols-[1fr_120px_180px]">
        <span>Employee</span><span>Flag</span><span className="hidden sm:block">Last 30 days</span>
      </div>
      {visibleEmployees.length ? riskPage.pageItems.map((employee) => <div key={employee.employeeId} className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0 sm:grid-cols-[1fr_120px_180px]">
        <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{employee.name}</p><p className="mt-0.5 text-xs text-slate-500">{employee.absenceDays} {employee.absenceDays === 1 ? "absence" : "absences"} without approved leave</p></div>
        <div className="flex justify-center"><AttendanceFlagIcon tier={employee.tier} /></div>
        <span className="hidden text-xs text-slate-500 sm:block">{employee.absenceDays} absent · {employee.lateDays} late</span>
      </div>) : <Empty text="No employee data is available yet." />}
      <PaginationControls {...riskPage} onPageChange={riskPage.setPage} />
    </div>
  </div>;
}

function FlagLegend({ color, title, range, note }: { color: "green" | "orange" | "red"; title: string; range: string; note: string }) {
  const styles = color === "green" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : color === "orange" ? "border-orange-200 bg-orange-50 text-orange-800" : "border-red-200 bg-red-50 text-red-800";
  return <div className={cn("rounded-xl border p-4", styles)}><div className="flex items-center gap-2"><AttendanceFlagIcon tier={color} size={20} /><p className="text-sm font-bold">{title}</p></div><p className="mt-2 text-sm font-semibold">{range}</p><p className="mt-1 text-xs opacity-80">{note}</p></div>;
}

function AnomalyPanel({ data }: { data: Insights["anomaly"] }) {
  const months = useMemo(() => [...new Set(data.anomalies.map((item) => item.date.slice(0, 7)))].sort().reverse(), [data.anomalies]);
  const [selectedMonth, setSelectedMonth] = useState("all");
  const visibleAnomalies = selectedMonth === "all" ? data.anomalies : data.anomalies.filter((item) => item.date.startsWith(selectedMonth));
  const anomalyPage = usePagination(visibleAnomalies, selectedMonth);
  return <div className="space-y-4">
    <div className="flex gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3"><Clock3 className="mt-0.5 shrink-0 text-sky-600" size={17} aria-hidden="true" /><div><p className="text-sm font-semibold text-sky-950">What does this show?</p><p className="mt-1 text-sm leading-6 text-sky-900/80">It shows clock-ins that are much earlier or later than the usual time. A different shift, approved schedule, transport issue, or incorrect record may explain the difference. Always check the details with the employee.</p></div></div>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><Stat label="Usual arrival time" value={data.medianTime} /><Stat label="Clock-ins checked" value={String(data.sampleScans)} /><div className="hidden sm:block"><Stat label="Visible unusual arrivals" value={String(visibleAnomalies.length)} /></div></div>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"><div><label htmlFor="arrival-month" className="text-sm font-semibold text-slate-800">Show records for</label><p className="text-xs text-slate-500">Choose a month so older records do not remain mixed with recent ones.</p></div><select id="arrival-month" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-200"><option value="all">All available months</option>{months.map((month) => <option key={month} value={month}>{monthLabel(month)}</option>)}</select></div>
    <div className="overflow-hidden rounded-2xl border border-slate-200">
      {visibleAnomalies.length ? anomalyPage.pageItems.map((item) => <div key={`${item.employeeId}-${item.date}`} className="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-3 last:border-0">
        <div className="flex min-w-0 items-center gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sky-50 text-sky-600"><Clock3 size={17} /></span><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{item.name}</p><p className="text-xs text-slate-400">{shortDate(item.date)} · {item.time}</p></div></div>
        <Badge variant="info">{arrivalDifference(item.deviationMinutes)}</Badge>
      </div>) : <Empty text={selectedMonth === "all" ? "No unusual arrival times were detected." : `No unusual arrival times were found in ${monthLabel(selectedMonth)}.`} />}
      <PaginationControls {...anomalyPage} onPageChange={anomalyPage.setPage} />
    </div>
  </div>;
}

function monthLabel(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function arrivalDifference(minutes: number) {
  const absolute = Math.abs(Math.round(minutes));
  const direction = minutes < 0 ? "earlier" : "later";
  if (absolute < 60) return `${absolute} ${absolute === 1 ? "minute" : "minutes"} ${direction}`;
  const hours = Math.floor(absolute / 60);
  const remainingMinutes = absolute % 60;
  const hourText = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const minuteText = remainingMinutes ? ` ${remainingMinutes} ${remainingMinutes === 1 ? "minute" : "minutes"}` : "";
  return `${hourText}${minuteText} ${direction}`;
}

function scannerStatusLabel(status: Scanner["status"]) {
  return status === "healthy" ? "Working normally" : status === "attention" ? "Needs attention" : "Critical issue";
}

function scannerOverallLabel(scanners: Scanner[]) {
  if (!scanners.length) return "No data";
  if (scanners.some((scanner) => scanner.status === "critical")) return "Critical issue";
  if (scanners.some((scanner) => scanner.status === "attention")) return "Needs attention";
  return "Working normally";
}

function VerificationPanel({ data, onTrialSaved }: { data: Insights["verification"]; onTrialSaved: () => void }) {
  const overallStatus = scannerOverallLabel(data.scanners);
  return <div className="space-y-5">
    <div className="rounded-2xl bg-gradient-to-br from-emerald-700 to-teal-700 p-5 text-white shadow-lg shadow-emerald-100">
      <div className="flex items-start justify-between gap-4"><div><p className="text-sm text-emerald-100">Overall scanner status</p><p className="mt-1 text-2xl font-bold">{overallStatus}</p><p className="mt-2 text-sm text-emerald-50">Based on {data.matchesAnalyzed} recent fingerprint results.</p></div><ShieldCheck size={32} className="shrink-0 text-emerald-100" aria-hidden="true" /></div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/25"><div className="h-full rounded-full bg-white" style={{ width: `${data.averageHealth}%` }} /></div>
      <p className="mt-3 text-xs text-emerald-100">If a scan fails, let the employee try again or use the approved backup attendance method.</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">{data.scanners.length ? data.scanners.map((scanner) => <div key={scanner.deviceUid} className="rounded-xl border border-slate-200 p-4">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{scanner.deviceUid}</p><p className="mt-1 text-xs text-slate-500">{scanner.scans} recent scans</p></div><Badge variant={scanner.status === "healthy" ? "success" : scanner.status === "attention" ? "warning" : "danger"}>{scannerStatusLabel(scanner.status)}</Badge></div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className={cn("h-full rounded-full", scanner.status === "healthy" ? "bg-emerald-500" : scanner.status === "attention" ? "bg-amber-500" : "bg-red-500")} style={{ width: `${scanner.health}%` }} /></div>
      <details className="mt-3 text-xs text-slate-500"><summary className="cursor-pointer font-medium text-slate-600">Technical details</summary><p className="mt-2">Reader health {scanner.health}% · average system score {scanner.averageScore}</p></details>
    </div>) : <div className="sm:col-span-2"><Empty text="No fingerprint match results are available yet." /></div>}</div>
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/80 px-5 py-4">
        <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">Live verification</p><h3 className="mt-1 text-base font-bold text-slate-900">Recent fingerprint scans</h3></div>
        <Badge variant="success"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Updates automatically</Badge>
      </div>
      <div className="divide-y divide-slate-100">
        {data.recentMatches?.length ? data.recentMatches.map((match, index) => <div key={`${match.employeeId}-${match.scannedAt}-${index}`} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3"><span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl", match.accepted ? "bg-emerald-50 text-emerald-600" : "bg-red-50 text-red-500")}>{match.accepted ? <ShieldCheck size={18} /> : <AlertTriangle size={18} />}</span><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-900">{match.name}</p><p className="mt-0.5 text-xs text-slate-400">{match.action === "time-in" ? "Time in" : match.action === "time-out" ? "Time out" : match.action === "daily-limit" ? "Recognized — daily limit reached" : match.accepted ? "Fingerprint recognized" : "No match"} · {match.eventTime || formatScanTime(match.scannedAt)} · {match.deviceUid}{match.responseTimeMs ? ` · ${(match.responseTimeMs / 1000).toFixed(2)}s` : ""}</p></div></div>
          <div className="flex items-center gap-3 pl-[52px] sm:pl-0"><div className="text-right"><p className={cn("text-lg font-bold", match.matchStrength != null && match.matchStrength >= 95 ? "text-emerald-700" : "text-red-600")}>{match.matchStrength != null ? `${Math.min(99, match.matchStrength)}%` : "No match"}</p><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{match.matchStrength != null && match.matchStrength >= 95 ? "Accepted" : "Needs attention"}</p></div>{match.matchStrength != null && <div className="h-9 w-1.5 overflow-hidden rounded-full bg-slate-100"><div className={cn("w-full rounded-full", match.matchStrength >= 95 ? "bg-emerald-500" : "bg-red-500")} style={{ height: `${match.matchStrength}%`, marginTop: `${100 - match.matchStrength}%` }} /></div>}</div>
        </div>) : <Empty text="Successful kiosk scans will appear here automatically." />}
      </div>
      <div className="border-t border-slate-100 bg-slate-50 px-5 py-3 text-sm leading-6 text-slate-600"><strong>If a result needs attention:</strong> clean the reader, ask the employee to place the same finger flat and try again, or confirm that the finger is enrolled. A failed scan does not mean the employee did anything wrong.</div>
    </div>
    <FingerprintEvaluation data={data.evaluation} onTrialSaved={onTrialSaved} />
  </div>;
}

function formatScanTime(value: string | null) {
  if (!value) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 text-lg font-bold text-slate-900">{value}</p></div>; }
function Empty({ text }: { text: string }) { return <div className="px-5 py-10 text-center text-sm text-slate-500">{text}</div>; }

export function AIInsightsView() {
  const [insights, setInsights] = useState<Insights | null>(null);
  const [selected, setSelected] = useState<InsightKey>("forecast");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadInsights = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await apiFetch(manual ? "/api/ai-insights?refresh=1" : "/api/ai-insights");
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Unable to load AI insights.");
      setInsights(body as Insights); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load AI insights."); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void loadInsights(), 0);
    return () => window.clearTimeout(initial);
  }, [loadInsights]);
  const meta = modelMeta[selected];
  const generated = useMemo(() => insights ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }).format(new Date(insights.generatedAt)) : null, [insights]);

  if (loading) return <div className="grid min-h-[420px] place-items-center" role="status" aria-live="polite"><div className="text-center"><BrainCircuit className="mx-auto animate-pulse text-violet-600" size={38} aria-hidden="true" /><p className="mt-3 text-sm font-medium text-slate-600">Preparing workforce insights…</p></div></div>;
  if (!insights) return <Card className="mx-auto mt-12 max-w-lg p-8 text-center" role="alert"><AlertTriangle className="mx-auto text-red-500" aria-hidden="true" /><h2 className="mt-3 font-semibold text-slate-900">Workforce insights could not load</h2><p className="mt-2 text-sm text-slate-500">{error}</p><Button className="mt-5" onClick={() => void loadInsights(true)}>Try again</Button></Card>;

  return <div className="space-y-6 pb-8">
    <AdminPageHeader data-guide="ai-heading" title="AI Workforce Analytics" description="Review attendance patterns and fingerprint scanner performance." icon={Sparkles} badge={<Badge className="border-emerald-200 bg-emerald-50 text-emerald-700"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Live data</Badge>} actions={<><span className="text-xs text-slate-500">Updated {generated}</span><Button variant="outline" className="border-violet-200 bg-white text-[#8642ED] hover:bg-violet-50" onClick={() => void loadInsights(true)} disabled={refreshing}><RefreshCw size={15} className={refreshing ? "animate-spin" : ""} /> Refresh</Button></>} />

    {error && <div role="alert" className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><AlertTriangle size={16} aria-hidden="true" /> Latest refresh failed: {error}. Showing the last successful result.</div>}
    <section data-guide="ai-models" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{(Object.keys(modelMeta) as InsightKey[]).map((key) => <MetricCard key={key} modelKey={key} selected={selected === key} insights={insights} onSelect={() => setSelected(key)} />)}</section>

    <div className="space-y-4">
      <Card className="overflow-hidden">
        <div className="border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white px-5 py-4 sm:px-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Summary</p><h2 className="mt-1 text-xl font-bold text-slate-900">{meta.title}</h2></div><ReadinessBadge status={insights[selected].status} /></div><p className="mt-2 text-sm text-slate-600">{insights[selected].summary}</p><p className="mt-1 text-xs text-slate-500">{meta.description} {meta.formula}.</p></div>
        <CardContent className="p-5 pt-5 sm:p-6 sm:pt-6">{selected === "forecast" ? <ForecastPanel data={insights.forecast} /> : selected === "risk" ? <RiskPanel data={insights.risk} /> : selected === "anomaly" ? <AnomalyPanel data={insights.anomaly} /> : <VerificationPanel data={insights.verification} onTrialSaved={() => void loadInsights()} />}</CardContent>
      </Card>
      <div data-guide="responsible-ai" className="flex gap-3 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3"><Activity className="mt-0.5 shrink-0 text-violet-600" size={17} /><p className="text-xs leading-5 text-violet-900"><strong>Reminder:</strong> Use these summaries as a guide and review the employee records before making a decision. A “Limited data” result may change as more records are collected.</p></div>
    </div>
  </div>;
}
