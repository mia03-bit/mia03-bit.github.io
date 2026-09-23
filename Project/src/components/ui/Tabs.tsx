import { cn } from "../../lib/util";

interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  items: { value: string; label: string }[];
  className?: string;
  ariaLabel?: string;
}

export function Tabs({ value, onValueChange, items, className, ariaLabel = "View options" }: TabsProps) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn("inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1", className)}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          onClick={() => onValueChange(item.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2",
            value === item.value
              ? "bg-white text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-700"
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
