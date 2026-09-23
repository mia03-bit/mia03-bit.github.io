import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

export type ToastVariant = 'success' | 'error' | 'info'

type ToastInput = {
  title: string
  description?: string
  variant?: ToastVariant
  duration?: number
}

type ToastItem = Required<Pick<ToastInput, 'title' | 'variant' | 'duration'>> &
  Pick<ToastInput, 'description'> & { id: number }

const ToastContext = createContext<{ toast: (input: ToastInput) => void } | null>(null)

const styles = {
  success: { icon: CheckCircle2, iconClass: 'text-emerald-600', bar: 'bg-emerald-500' },
  error: { icon: AlertCircle, iconClass: 'text-rose-600', bar: 'bg-rose-500' },
  info: { icon: Info, iconClass: 'text-indigo-600', bar: 'bg-indigo-500' },
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const toast = useCallback((input: ToastInput) => {
    const item: ToastItem = {
      id: Date.now() + Math.random(),
      title: input.title,
      description: input.description,
      variant: input.variant ?? 'info',
      duration: input.duration ?? 5000,
    }
    setItems((current) => [...current.slice(-3), item])
    window.setTimeout(() => dismiss(item.id), item.duration)
  }, [dismiss])

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-3" aria-live="polite" aria-atomic="true">
        {items.map((item) => {
          const toastStyle = styles[item.variant]
          const Icon = toastStyle.icon
          return (
            <div key={item.id} className="pointer-events-auto relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-12px_rgba(15,23,42,0.3)] animate-toast-in" role={item.variant === 'error' ? 'alert' : 'status'}>
              <div className="flex items-start gap-3 pr-7">
                <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${toastStyle.iconClass}`} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                  {item.description && <p className="mt-1 text-xs leading-5 text-slate-500">{item.description}</p>}
                </div>
              </div>
              <button type="button" onClick={() => dismiss(item.id)} className="absolute right-3 top-3 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Dismiss notification"><X className="h-4 w-4" /></button>
              <div className="absolute inset-x-0 bottom-0 h-1 bg-slate-100"><div className={`h-full origin-left ${toastStyle.bar} animate-toast-timer`} style={{ animationDuration: `${item.duration}ms` }} /></div>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

// The provider and its companion hook intentionally share one module.
// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside ToastProvider')
  return context
}
