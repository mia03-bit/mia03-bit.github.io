import {
  Fingerprint,
  LayoutDashboard, 
  Users, 
  ReceiptText, 
  Settings, 
  LogOut, 
  ChevronRight, 
  Sparkles,
  Calendar,
  X
} from "lucide-react";
import { cn } from "../lib/utils";
import { Badge } from "./ui/Badge";

export type ViewKey =
  | "overview"
  | "attendance"
  | "employees"
  | "leave"
  | "payroll"
  | "insights"
  | "settings"
  | "admin";

interface SidebarProps {
  active: ViewKey;
  onNavigate: (view: ViewKey) => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  accountName: string;
  onLogout: () => void;
}

export function AdminSidebar({ active, onNavigate, mobileOpen = false, onMobileClose = () => {}, accountName, onLogout }: SidebarProps) {
  const initials = accountName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const navItems: { key: ViewKey; label: string; icon: React.ElementType }[] = [
    { key: 'overview', label: 'Overview', icon: LayoutDashboard },
    { key: 'attendance', label: 'Attendance', icon: Calendar },
    { key: 'employees', label: 'Employee Directory', icon: Users },
    { key: 'leave', label: 'Leave Requests', icon: Calendar },
    { key: 'payroll', label: 'Payroll', icon: ReceiptText },
    { key: 'insights', label: 'AI Insights', icon: Sparkles },
    { key: 'settings', label: 'System Settings', icon: Settings },
    { key: 'admin', label: 'Admin Controls', icon: Settings },
  ];

  return (
    <>
    <button aria-label="Close navigation" onClick={onMobileClose} className={`fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-sm transition-opacity lg:hidden ${mobileOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`} />
    <aside className={`fixed inset-y-0 left-0 z-50 flex w-[min(19rem,86vw)] flex-col border-r border-slate-200/80 bg-white shadow-2xl transition-transform duration-200 lg:sticky lg:top-0 lg:z-20 lg:h-screen lg:w-64 lg:translate-x-0 lg:shadow-none ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="flex h-16 items-center gap-3 border-b border-slate-200/80 px-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#8642ED] shadow-md shadow-[#8642ED]/25">
          <Fingerprint className="h-[18px] w-[18px] text-white" />
        </div>
        <div className="min-w-0">
          <h2 className="text-[13px] font-bold leading-tight tracking-tight text-slate-900">
            <span className="font-extrabold">WORK</span>
            <span className="font-extrabold text-[#8642ED]">PULSE</span>
            <span className="font-extrabold"> MVL</span>
          </h2>
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-slate-400">Admin</p>
        </div>
        <button onClick={onMobileClose} aria-label="Close navigation" className="ml-auto rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 lg:hidden"><X className="h-5 w-5" /></button>
      </div>

      <nav className="scrollbar-thin flex-1 space-y-1 overflow-y-auto p-3">
        <p className="mb-2 px-3 pt-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Workspace</p>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.key;
          return (
            <button
              key={item.key}
              onClick={() => { onNavigate(item.key); onMobileClose(); }}
              className={cn(
                "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition-all",
                isActive ? "bg-violet-600 text-white shadow-sm shadow-violet-600/20" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
              )}
            >
              <Icon className={cn("h-[18px] w-[18px] shrink-0 transition-colors", isActive ? "text-white" : "text-slate-400 group-hover:text-slate-700")} />
              {item.label}
              {isActive && <ChevronRight className="ml-auto h-3.5 w-3.5 text-white/80" />}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-slate-200/80 p-3">
        <div className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#8642ED] text-[13px] font-bold text-white">{initials || '?'}</div>
          <div className="min-w-0 flex-1">
            <p title={accountName} className="truncate text-[13px] font-semibold text-slate-900">{accountName || 'Loading account...'}</p>
            <div className="flex items-center gap-1.5">
              <Badge variant="success" className="px-1.5 py-0">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Online
              </Badge>
            </div>
          </div>
          <button onClick={onLogout} aria-label="Log out" className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
    </>
  );
}
