import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./Button";
import { DEFAULT_PAGE_SIZE } from "../../hooks/usePagination";

export function PaginationControls({ page, pageSize = DEFAULT_PAGE_SIZE, totalItems, totalPages, onPageChange }: { page: number; pageSize?: number; totalItems: number; totalPages: number; onPageChange: (page: number) => void }) {
  if (totalItems <= pageSize) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalItems);
  const pageStart = Math.max(1, Math.min(page - 2, totalPages - 4));
  const visiblePages = Array.from({ length: Math.min(5, totalPages) }, (_, index) => pageStart + index);
  return <nav aria-label="Table pagination" className="flex flex-col gap-3 border-t border-slate-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
    <p className="text-sm text-slate-500">Showing {first}–{last} of {totalItems}</p>
    <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-start">
      <Button type="button" size="sm" variant="outline" disabled={page === 1} onClick={() => onPageChange(page - 1)}><ChevronLeft className="h-4 w-4" /> Previous</Button>
      <span className="text-xs font-medium text-slate-600 sm:hidden">{page} / {totalPages}</span>
      <div className="hidden items-center gap-1 sm:flex" aria-label={`Page ${page} of ${totalPages}`}>{visiblePages.map((number) => <button key={number} type="button" aria-current={number === page ? "page" : undefined} aria-label={`Go to page ${number}`} onClick={() => onPageChange(number)} className={`grid h-8 min-w-8 place-items-center rounded-lg px-2 text-sm font-semibold transition ${number === page ? "bg-violet-600 text-white" : "border border-slate-200 bg-white text-slate-600 hover:border-violet-300 hover:text-violet-700"}`}>{number}</button>)}</div>
      <Button type="button" size="sm" variant="outline" disabled={page === totalPages} onClick={() => onPageChange(page + 1)}>Next <ChevronRight className="h-4 w-4" /></Button>
    </div>
  </nav>;
}
