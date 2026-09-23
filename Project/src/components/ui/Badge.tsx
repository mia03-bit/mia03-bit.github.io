import { cn } from "../../lib/util";

interface BadgeProps {
  variant?: "default" | "success" | "warning" | "danger" | "info" | "neutral";
  className?: string;
  children: React.ReactNode;
}

const variants = {
  default: "bg-[#8642ED]/10 text-[#8642ED] border-[#8642ED]/20",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  danger: "bg-red-50 text-red-700 border-red-200",
  info: "bg-sky-50 text-sky-700 border-sky-200",
  neutral: "bg-slate-100 text-slate-600 border-slate-200",
};

export function Badge({ variant = "default", className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
