import { useState, type FormEvent } from 'react'
import { Check, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
import { apiFetch } from '../lib/api'

type InitialPasswordChangeViewProps = {
  onComplete: () => void
}

export function InitialPasswordChangeView({ onComplete }: InitialPasswordChangeViewProps) {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const validLength = newPassword.length >= 8 && newPassword.length <= 32
  const passwordsMatch = newPassword.length > 0 && newPassword === confirmPassword

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    if (!validLength) return setError('Your password must be between 8 and 32 characters.')
    if (!passwordsMatch) return setError('The passwords do not match.')
    setSubmitting(true)
    try {
      const response = await apiFetch('/api/auth/change-initial-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error || 'Unable to save your password.')
      onComplete()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save your password.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-950 via-indigo-950 to-violet-950 px-4 py-10">
      <section className="w-full max-w-lg overflow-hidden rounded-[2rem] border border-white/10 bg-white shadow-2xl shadow-violet-950/30">
        <div className="bg-gradient-to-r from-indigo-600 to-violet-600 px-7 py-8 text-white sm:px-10">
          <div className="mb-5 grid h-12 w-12 place-items-center rounded-2xl bg-white/15 ring-1 ring-white/20"><KeyRound className="h-6 w-6" /></div>
          <p className="text-xs font-bold uppercase tracking-[.18em] text-indigo-100">First login security</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Create your own password</h1>
          <p className="mt-2 text-sm leading-6 text-indigo-100">Replace the temporary password from your email before opening your employee overview.</p>
        </div>

        <form onSubmit={submit} className="space-y-6 px-7 py-8 sm:px-10">
          <div className="rounded-2xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900">
            <div className="flex gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-indigo-600" /><p>This password is private. Your administrator will not be able to see it.</p></div>
          </div>

          <div>
            <label htmlFor="new-password" className="mb-2 block text-sm font-semibold text-slate-700">New password</label>
            <div className="relative">
              <input id="new-password" autoComplete="new-password" type={showPassword ? 'text' : 'password'} minLength={8} maxLength={32} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} className="h-12 w-full rounded-xl border border-slate-300 bg-slate-50 px-4 pr-12 text-sm outline-none transition focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-500/10" placeholder="Enter 8 to 32 characters" />
              <button type="button" onClick={() => setShowPassword((shown) => !shown)} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-2 text-slate-400 hover:bg-white hover:text-slate-700" aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
            </div>
            <p className={`mt-2 flex items-center gap-1.5 text-xs font-medium ${validLength ? 'text-emerald-600' : 'text-slate-500'}`}><Check className="h-3.5 w-3.5" />8 characters minimum, 32 maximum</p>
          </div>

          <div>
            <label htmlFor="confirm-password" className="mb-2 block text-sm font-semibold text-slate-700">Confirm new password</label>
            <input id="confirm-password" autoComplete="new-password" type={showPassword ? 'text' : 'password'} minLength={8} maxLength={32} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="h-12 w-full rounded-xl border border-slate-300 bg-slate-50 px-4 text-sm outline-none transition focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-500/10" placeholder="Enter the same password again" />
          </div>

          {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</div>}

          <button type="submit" disabled={submitting || !validLength || !passwordsMatch} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 text-sm font-bold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50">
            {submitting ? <><LoaderCircle className="h-4 w-4 animate-spin" />Saving password...</> : 'Save password and continue'}
          </button>
        </form>
      </section>
    </main>
  )
}
