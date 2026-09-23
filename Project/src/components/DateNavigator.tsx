import { useRef } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

export function DateNavigator({ label, value, onChange, navigation = "day" }: { label: string; value: string; onChange: (value: string) => void; navigation?: "day" | "semi-monthly" }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const moveDay = (amount: number) => {
    const date = new Date(`${value}T12:00:00`);
    if (navigation === "semi-monthly") {
      const secondHalf = date.getDate() >= 16;
      if (amount < 0) {
        if (secondHalf) date.setDate(1);
        else { date.setMonth(date.getMonth() - 1); date.setDate(16); }
      } else if (secondHalf) {
        date.setMonth(date.getMonth() + 1); date.setDate(1);
      } else date.setDate(16);
    } else date.setDate(date.getDate() + amount);
    onChange(date.toISOString().slice(0, 10));
  };
  const formatted = new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const openCalendar = () => {
    const input = inputRef.current;
    if (!input) return;
    if (typeof input.showPicker === "function") input.showPicker();
    else {
      input.focus();
      input.click();
    }
  };

  return (
    <div className="relative flex w-full max-w-full items-stretch sm:w-auto overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <button type="button" onClick={() => moveDay(-1)} aria-label={navigation === "semi-monthly" ? "Previous payroll period" : "Previous day"} className="flex min-h-11 w-10 shrink-0 items-center justify-center border-r border-slate-200 text-slate-400 transition-colors hover:bg-violet-50 hover:text-[#8642ED]">
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button type="button" onClick={openCalendar} aria-label={`Open ${label} calendar`} className="relative flex min-w-0 flex-1 sm:min-w-[210px] cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-violet-50">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#8642ED]/10 text-[#8642ED]"><Calendar className="h-4 w-4" /></span>
        <span className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
          <span className="block whitespace-nowrap text-xs font-semibold text-slate-700">{formatted}</span>
        </span>
        <span className="ml-auto hidden text-[10px] font-semibold sm:inline text-[#8642ED]">Choose</span>
      </button>
      <input ref={inputRef} aria-label={label} type="date" value={value} onChange={(event) => onChange(event.target.value)} className="pointer-events-none absolute h-px w-px opacity-0" />
      <button type="button" onClick={() => moveDay(1)} aria-label={navigation === "semi-monthly" ? "Next payroll period" : "Next day"} className="flex min-h-11 w-10 shrink-0 items-center justify-center border-l border-slate-200 text-slate-400 transition-colors hover:bg-violet-50 hover:text-[#8642ED]">
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
