import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

function isoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

type WorkSchedule = { workWeekdays: number[]; scheduleOverrides: { date: string; working: boolean; kind?: string }[] };

export function LeaveDatePicker({ selected, onChange, allowedDates, workSchedule }: { selected: string[]; onChange: (dates: string[]) => void; allowedDates?: string[]; workSchedule?: WorkSchedule }) {
  const [range, setRange] = useState<7 | 30 | "month">(7);
  const [month, setMonth] = useState(() => { const date = new Date(); return new Date(date.getFullYear(), date.getMonth(), 1); });
  const allowed = useMemo(() => allowedDates ? new Set(allowedDates) : null, [allowedDates]);
  const dates = useMemo(() => {
    const start = range === "month" ? new Date(month) : new Date();
    start.setHours(12, 0, 0, 0);
    const count = range === "month" ? new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate() : range;
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(start);
      date.setDate(range === "month" ? index + 1 : start.getDate() + index);
      return { value: isoDate(date), day: date.toLocaleDateString("en-PH", { weekday: "short" }), label: date.toLocaleDateString("en-PH", { month: "short", day: "numeric" }) };
    });
  }, [month, range]);
  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((date) => date !== value) : [...selected, value].sort());

  if (allowedDates) {
    const requested = [...new Set(allowedDates)].sort();
    return <div className="space-y-3 rounded-2xl border border-violet-200 bg-violet-50/50 p-4">
      <div><p className="text-sm font-semibold text-violet-950">Requested leave dates</p><p className="mt-1 text-xs leading-5 text-violet-700">Only the dates selected by the employee are shown. Click a date only if you need to exclude it from approval.</p></div>
      <div className="grid gap-2 sm:grid-cols-2">
        {requested.map((value) => {
          const active = selected.includes(value);
          const date = new Date(`${value}T00:00:00Z`);
          const label = date.toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
          return <button key={value} type="button" aria-pressed={active} onClick={() => toggle(value)} className={`flex min-h-12 items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-sm transition focus:outline-none focus:ring-2 focus:ring-violet-400 ${active ? "border-violet-500 bg-violet-600 text-white" : "border-slate-300 bg-white text-slate-600"}`}><span className="font-semibold">{label}</span><span className={`shrink-0 text-xs font-bold ${active ? "text-violet-100" : "text-slate-500"}`}>{active ? "Included" : "Excluded"}</span></button>;
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs font-medium text-slate-700">{selected.length} of {requested.length} requested {requested.length === 1 ? "date" : "dates"} included</p><div className="flex gap-3">{selected.length !== requested.length&&<button type="button" onClick={()=>onChange(requested)} className="text-xs font-semibold text-violet-700 hover:underline">Include all</button>}{selected.length>0&&<button type="button" onClick={()=>onChange([])} className="text-xs font-semibold text-slate-600 hover:underline">Exclude all</button>}</div></div>
    </div>;
  }

  return <div className="space-y-3 rounded-2xl border border-violet-200 bg-violet-50/50 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold text-violet-950">Choose leave dates</p><p className="mt-1 text-xs text-violet-700">Select each date separately. Dates do not need to be consecutive.</p></div><div className="flex rounded-lg border border-violet-200 bg-white p-1">{([[7,"7 Days"],[30,"30 Days"],["month","Months"]] as const).map(([value,label])=><button key={value} type="button" onClick={()=>setRange(value)} className={`rounded-md px-2 py-1 text-[11px] font-semibold ${range===value?"bg-violet-600 text-white":"text-slate-500"}`}>{label}</button>)}</div></div>
    {range === "month" && <div className="flex items-center justify-between rounded-lg bg-white px-2 py-1.5"><button type="button" aria-label="Previous month" onClick={()=>setMonth(current=>new Date(current.getFullYear(),current.getMonth()-1,1))} className="rounded-md p-1 text-slate-500 hover:bg-violet-50"><ChevronLeft size={16}/></button><p className="text-xs font-bold text-slate-700">{month.toLocaleDateString("en-PH",{month:"long",year:"numeric"})}</p><button type="button" aria-label="Next month" onClick={()=>setMonth(current=>new Date(current.getFullYear(),current.getMonth()+1,1))} className="rounded-md p-1 text-slate-500 hover:bg-violet-50"><ChevronRight size={16}/></button></div>}
    <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">{dates.map(item=>{const active=selected.includes(item.value);const override=workSchedule?.scheduleOverrides.find(entry=>entry.date===item.value);const scheduled=override?.working??(!workSchedule||workSchedule.workWeekdays.includes(new Date(`${item.value}T12:00:00`).getDay()));const available=(!allowed||allowed.has(item.value))&&scheduled;const reason=override?.kind==='holiday'?'Holiday':override?.kind==='rest-day'||!scheduled?'Rest day':'Available';return <button key={item.value} type="button" disabled={!available} title={`${item.label}: ${reason}`} onClick={()=>toggle(item.value)} className={`min-w-0 rounded-lg border px-1 py-2 text-center transition disabled:cursor-not-allowed ${!available?'border-slate-200 bg-slate-100 text-slate-400 opacity-70':active?'border-violet-500 bg-violet-600 text-white':'border-slate-200 bg-white text-slate-600 hover:border-violet-300'}`}><span className="block text-[10px] font-bold">{item.day}</span><span className="block truncate text-[9px]">{item.label}</span>{!available&&<span className="mt-1 block truncate text-[8px] font-semibold">{reason}</span>}</button>})}</div>
    <div className="flex items-center justify-between gap-3"><p className="text-xs font-medium text-slate-600">{selected.length} {selected.length===1?"date":"dates"} selected</p>{selected.length>0&&<button type="button" onClick={()=>onChange([])} className="text-xs font-semibold text-violet-700 hover:underline">Clear dates</button>}</div>
  </div>;
}
