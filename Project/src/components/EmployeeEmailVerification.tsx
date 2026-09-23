import { useId } from 'react';
import { ArrowRight, Check, LoaderCircle, Mail, RotateCcw } from 'lucide-react';
import { Button } from './ui/Button';

export function EmployeeEmailVerification({ email, sent, code, sending, saving, onSend, onChange }: {
  email: string; sent: boolean; code: string; sending: boolean; saving: boolean;
  onSend: () => void; onChange: (code: string) => void;
}) {
  const inputId = useId();
  return <div className="overflow-hidden rounded-xl border border-violet-100 bg-gradient-to-br from-violet-50/80 via-white to-white">
    <div className="flex items-center gap-3 border-b border-violet-100/80 px-4 py-3">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-violet-600 shadow-sm"><Mail className="h-5 w-5" /></div>
      <div className="min-w-0 flex-1"><p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Employee email</p><p className="break-all text-sm font-semibold text-slate-800">{email || 'Enter an email address above'}</p></div>
    </div>
    <div className="px-4 py-5 sm:px-6">
      {sent ? <>
        <div className="mb-4 flex items-center gap-2 text-xs font-medium text-violet-700" role="status"><span className="h-2 w-2 rounded-full bg-violet-500" />Awaiting email verification</div>
        <label htmlFor={inputId} className="block text-sm font-semibold text-slate-900">Enter the 6-digit code</label>
        <p id={`${inputId}-hint`} className="mt-1 text-xs leading-5 text-slate-500">Ask the employee for the code in their inbox or spam folder. It expires 10 minutes after sending.</p>
        <div className="relative mt-4 max-w-sm rounded-xl focus-within:ring-2 focus-within:ring-violet-500/30 focus-within:ring-offset-4">
          <div aria-hidden="true" className="grid grid-cols-6 gap-2">
            {Array.from({ length: 6 }, (_, index) => <div key={index} className={`flex h-12 items-center justify-center rounded-lg border bg-white font-mono text-xl font-semibold shadow-sm sm:h-14 ${code[index] ? 'border-violet-300 text-violet-700' : 'border-slate-200 text-slate-300'}`}>{code[index] || '–'}</div>)}
          </div>
          <input id={inputId} aria-describedby={`${inputId}-hint`} aria-label="Six-digit email verification code" required disabled={saving || sending} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))} className="absolute inset-0 h-full w-full cursor-text rounded-xl opacity-0 disabled:cursor-not-allowed" />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs text-slate-500">{code.length === 6 ? <><Check className="h-3.5 w-3.5 text-violet-600" />Code ready to verify on creation</> : 'You can paste the full code.'}</p>
          <button type="button" onClick={onSend} disabled={saving || sending} className="inline-flex items-center gap-1.5 rounded-md px-1 py-2 text-xs font-semibold text-violet-600 hover:text-violet-800 focus-visible:outline-2 focus-visible:outline-violet-500 disabled:opacity-50">{sending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}{sending ? 'Sending…' : 'Resend code'}</button>
        </div>
      </> : <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="text-sm font-semibold text-slate-900">Confirm access to this inbox</p><p className="mt-1 max-w-sm text-xs leading-5 text-slate-500">Send a one-time code to the employee before creating their account.</p></div>
        <Button type="button" className="shrink-0" disabled={saving || sending || !email} onClick={onSend}>{sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}{sending ? 'Sending code…' : 'Send code'}</Button>
      </div>}
    </div>
    <p className="border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-[11px] leading-5 text-slate-500">The account is created after the code is verified. Login details are then emailed to the employee.</p>
  </div>;
}
