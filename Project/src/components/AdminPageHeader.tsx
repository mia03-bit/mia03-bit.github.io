import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface AdminPageHeaderProps {
  title: string;
  description: string;
  icon: LucideIcon;
  badge?: ReactNode;
  actions?: ReactNode;
  "data-guide"?: string;
}

export function AdminPageHeader({ title, description, icon: Icon, badge, actions, "data-guide": guide }: AdminPageHeaderProps) {
  return (
    <section data-guide={guide} aria-label={title} className="relative isolate rounded-3xl border border-violet-200 bg-gradient-to-br from-white via-violet-50 to-purple-100 p-5 text-slate-900 shadow-sm sm:px-8 sm:py-7">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-3xl">
        <div className="absolute -right-16 -top-24 h-64 w-64 rounded-full bg-[#8642ED]/10 blur-3xl" />
        <div className="absolute bottom-0 right-1/3 h-24 w-40 bg-fuchsia-300/10 blur-3xl" />
      </div>
      <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#8642ED] text-white shadow-lg shadow-violet-200 sm:h-12 sm:w-12 sm:rounded-2xl">
            <Icon className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-words text-xl font-bold tracking-tight text-slate-950 sm:text-2xl">{title}</h2>
              {badge}
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">{description}</p>
          </div>
        </div>
        {actions && <div className="flex w-full min-w-0 flex-wrap items-center gap-2 [&>button]:flex-1 sm:w-auto sm:gap-3 sm:[&>button]:flex-none xl:max-w-[50%] xl:justify-end">{actions}</div>}
      </div>
    </section>
  );
}
