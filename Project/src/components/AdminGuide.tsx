import { useEffect, useLayoutEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, ShieldCheck, X } from 'lucide-react'
import type { ViewKey } from './AdminSidebar'

type GuideStep = {
  view: ViewKey
  target: string
  title: string
  description: string
  tip: string
}

const guideSteps: GuideStep[] = [
  { view: 'overview', target: '[data-guide="workforce-operations"]', title: 'Staff numbers', description: 'This area shows how many staff you have, who is available, and what work is still waiting.', tip: 'The date arrows only change the day you are looking at.' },
  { view: 'overview', target: '[data-guide="performance-snapshot"]', title: 'Performance percentages', description: 'These bars show attendance, on-time arrivals, fingerprint setup, and finished payroll.', tip: 'A low number means check the records. It does not mean someone is guilty.' },
  { view: 'overview', target: '[data-guide="attendance-trends"]', title: 'Attendance trend', description: 'Green is present, yellow is late, and red is absent. The lines help you see if attendance is getting better or worse.', tip: 'Daily, Weekly, and Monthly change how the same records are grouped.' },
  { view: 'overview', target: '[data-guide="today-breakdown"]', title: 'Today’s attendance', description: 'This circle shows the share of staff who are present, late, absent, or on leave.', tip: 'Point at a color to see its number.' },
  { view: 'overview', target: '[data-guide="audit-trail"]', title: 'Recent activity', description: 'This list shows the latest actions recorded by the system.', tip: 'Use it when you need to check what happened and when.' },
  { view: 'attendance', target: '[data-guide="attendance-table"]', title: 'Attendance records', description: 'Each row shows one employee’s date, clock-in, clock-out, and attendance status.', tip: 'Use this page to check the real record behind an Overview number.' },
  { view: 'employees', target: '[data-guide="employee-add"]', title: 'Add Employee', description: 'Use this button when a new worker needs an account and fingerprint setup.', tip: 'This changes real data, so check the employee details before saving.' },
  { view: 'employees', target: '[data-guide="employee-filters"]', title: 'Find an employee', description: 'Search by name or ID. The status filter shows active, on-leave, or inactive staff. The two small view buttons switch between table and cards.', tip: 'Search and view buttons do not change employee data.' },
  { view: 'employees', target: '[data-guide="employee-list"]', title: 'Employee actions', description: 'Edit details updates a profile. Archive makes an employee inactive and moves the record to Admin Controls.', tip: 'Both are real actions. Read the confirmation before continuing.' },
  { view: 'leave', target: '[data-guide="leave-summary"]', title: 'Leave summary', description: 'These cards show requests waiting, requests approved this month, and total approved leave days.', tip: 'Start with Pending Review when work is waiting.' },
  { view: 'leave', target: '[data-guide="leave-filters"]', title: 'Leave filters', description: 'Search finds a worker. The status buttons show all, pending, approved, or declined requests.', tip: 'Filters only change what you see. They do not change a request.' },
  { view: 'leave', target: '[data-guide="leave-list"]', title: 'Review a leave request', description: 'Read the person, dates, leave type, and reason. Approve accepts it. Decline rejects it.', tip: 'Approve and Decline change real data, so review first.' },
  { view: 'payroll', target: '[data-guide="payroll-filters"]', title: 'Find payroll records', description: 'Use the simple status buttons or search for an employee. More filters contains the optional employee-type filter.', tip: 'Filters only change what you see. They never change pay.' },
  { view: 'payroll', target: '[data-guide="payroll-hub"]', title: 'Review and pay', description: 'The Select boxes choose unpaid employees for Pay Selected. A dash means that row cannot be selected. Review opens one payslip.', tip: 'Attendance reminders do not block payroll. Only payments placed on hold are excluded. Unpaid amounts carry into the next pay period.' },
  { view: 'insights', target: '[data-guide="ai-forecast"]', title: 'Forecast AI', description: 'This estimates future attendance from recent and repeating patterns.', tip: 'Use it to plan staffing. It is an estimate, not a promise.' },
  { view: 'insights', target: '[data-guide="ai-risk"]', title: 'Risk AI', description: 'This points out repeated absence patterns that may need a closer look.', tip: 'A high score means review the situation. It does not mean punish the employee.' },
  { view: 'insights', target: '[data-guide="ai-anomaly"]', title: 'Anomaly AI', description: 'This finds clock-ins that are very different from the normal time.', tip: 'An unusual time can still be valid. Check the attendance record first.' },
  { view: 'insights', target: '[data-guide="ai-verification"]', title: 'Verification AI', description: 'This watches fingerprint scanner quality and warns when a scanner may need cleaning or repair.', tip: 'This is mainly a hardware warning, not an employee warning.' },
  { view: 'insights', target: '[data-guide="ai-explanation"]', title: 'More details', description: 'After choosing an AI card, this area explains what it checks and what HR receives.', tip: 'You can use the simple text. The formula is there for technical checking.' },
  { view: 'insights', target: '[data-guide="responsible-ai"]', title: 'Always check first', description: 'AI helps you notice something. A person must still check the records and situation before making a decision.', tip: 'Consider approved leave, company rules, and the employee’s situation.' },
  { view: 'overview', target: '[data-guide="overview-guide-button"]', title: 'Open this guide again', description: 'Use Start guide again here, or Manual Guide in the sidebar, whenever you need help.', tip: 'The guide is view-only and does not change your data.' },
]

type Spotlight = { top: number; left: number; width: number; height: number }
const GAP = 6

export function AdminGuide({ open, onClose, onNavigate }: { open: boolean; onClose: () => void; onNavigate: (view: ViewKey) => void }) {
  const [stepIndex, setStepIndex] = useState(0)
  const [spotlight, setSpotlight] = useState<Spotlight | null>(null)
  const step = guideSteps[stepIndex]

  useLayoutEffect(() => {
    if (!open) return
    onNavigate(step.view)

    const timer = window.setTimeout(() => {
      const element = document.querySelector<HTMLElement>(step.target)
      if (!element) { setSpotlight(null); return }
      element.scrollIntoView({ behavior: 'smooth', block: element.offsetHeight > window.innerHeight * 0.65 ? 'start' : 'center', inline: 'nearest' })

      window.setTimeout(() => {
        const rect = element.getBoundingClientRect()
        setSpotlight({
          top: Math.max(GAP, rect.top - GAP),
          left: Math.max(GAP, rect.left - GAP),
          width: Math.min(window.innerWidth - GAP * 2, rect.width + GAP * 2),
          height: Math.min(300, window.innerHeight - GAP * 2, rect.height + GAP * 2),
        })
      }, 350)
    }, 50)
    return () => window.clearTimeout(timer)
  }, [open, step, onNavigate])

  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const previousHtmlOverflow = document.documentElement.style.overflow
    const previousBodyOverflow = document.body.style.overflow
    const previousBodyOverscroll = document.body.style.overscrollBehavior
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'none'

    const stopManualScroll = (event: Event) => event.preventDefault()
    const stopScrollKeys = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) event.preventDefault()
    }
    window.addEventListener('wheel', stopManualScroll, { passive: false })
    window.addEventListener('touchmove', stopManualScroll, { passive: false })
    window.addEventListener('keydown', stopScrollKeys)

    return () => {
      document.documentElement.style.overflow = previousHtmlOverflow
      document.body.style.overflow = previousBodyOverflow
      document.body.style.overscrollBehavior = previousBodyOverscroll
      window.removeEventListener('wheel', stopManualScroll)
      window.removeEventListener('touchmove', stopManualScroll)
      window.removeEventListener('keydown', stopScrollKeys)
    }
  }, [open])

  if (!open) return null

  function moveTo(index: number) {
    setStepIndex(Math.max(0, Math.min(guideSteps.length - 1, index)))
  }

  const panelWidth = Math.min(368, window.innerWidth - 24)
  const panelHeight = 260
  const isSmallScreen = window.innerWidth < 640
  let panelTop = Math.max(12, window.innerHeight / 2 - panelHeight / 2)
  let panelLeft = Math.max(12, window.innerWidth / 2 - panelWidth / 2)

  if (spotlight && isSmallScreen) {
    panelTop = window.innerHeight - panelHeight - 12
    panelLeft = 12
  } else if (spotlight) {
    const rightSpace = window.innerWidth - (spotlight.left + spotlight.width)
    if (rightSpace >= panelWidth + 24) {
      panelLeft = spotlight.left + spotlight.width + 14
      panelTop = Math.max(12, Math.min(spotlight.top, window.innerHeight - panelHeight - 12))
    } else if (spotlight.left >= panelWidth + 24) {
      panelLeft = spotlight.left - panelWidth - 14
      panelTop = Math.max(12, Math.min(spotlight.top, window.innerHeight - panelHeight - 12))
    } else {
      const fitsBelow = window.innerHeight - (spotlight.top + spotlight.height) >= panelHeight + 24
      panelTop = fitsBelow ? spotlight.top + spotlight.height + 14 : Math.max(12, spotlight.top - panelHeight - 14)
      panelLeft = Math.max(12, Math.min(spotlight.left, window.innerWidth - panelWidth - 12))
    }
  }

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-labelledby="admin-guide-title">
      {spotlight ? (
        <>
          <div className="fixed left-0 right-0 top-0 bg-slate-950/65" style={{ height: spotlight.top }} />
          <div className="fixed left-0 bg-slate-950/65" style={{ top: spotlight.top, width: spotlight.left, height: spotlight.height }} />
          <div className="fixed right-0 bg-slate-950/65" style={{ top: spotlight.top, left: spotlight.left + spotlight.width, height: spotlight.height }} />
          <div className="fixed bottom-0 left-0 right-0 bg-slate-950/65" style={{ top: spotlight.top + spotlight.height }} />
          <div className="fixed rounded-2xl border-2 border-violet-400 ring-4 ring-violet-400/25" style={spotlight} aria-hidden="true" />
        </>
      ) : <div className="fixed inset-0 bg-slate-950/65" />}

      <section className="fixed w-[calc(100vw-1.5rem)] max-w-[23rem] overflow-hidden rounded-xl border border-violet-200 bg-white shadow-2xl transition-all" style={{ top: panelTop, left: panelLeft }}>
        <div className="flex items-center justify-between border-b border-violet-100 bg-violet-50 px-4 py-2.5">
          <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-violet-700"><BookOpen className="h-4 w-4" /> Guided walkthrough</span>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-slate-700" aria-label="Close guide"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-4">
          <div className="mb-3 flex items-center justify-between gap-3"><span className="text-xs font-bold text-violet-700">Step {stepIndex + 1} of {guideSteps.length}</span><span className="flex items-center gap-1 text-xs font-semibold text-emerald-700"><ShieldCheck className="h-4 w-4" /> View only</span></div>
          <h2 id="admin-guide-title" className="text-lg font-bold text-slate-950">{step.title}</h2>
          <p className="mt-1.5 text-sm leading-5 text-slate-600">{step.description}</p>
          <p className="mt-2.5 rounded-lg bg-violet-50 p-2.5 text-xs leading-4 text-violet-800"><strong>Tip:</strong> {step.tip}</p>
          <div className="mt-4 flex items-center justify-between gap-3">
            <button type="button" disabled={stepIndex === 0} onClick={() => moveTo(stepIndex - 1)} className="flex h-10 items-center gap-1.5 rounded-xl border border-slate-200 px-3 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"><ArrowLeft className="h-4 w-4" /> Back</button>
            {stepIndex === guideSteps.length - 1
              ? <button type="button" onClick={onClose} className="h-10 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-700">Finish guide</button>
              : <button type="button" onClick={() => moveTo(stepIndex + 1)} className="flex h-10 items-center gap-1.5 rounded-xl bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-700">Next <ArrowRight className="h-4 w-4" /></button>}
          </div>
        </div>
      </section>
    </div>
  )
}
