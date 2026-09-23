/// <reference types="@digitalpersona/websdk" />
/// <reference types="@digitalpersona/fingerprint" />

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Clock3, Fingerprint as FingerprintIcon, HelpCircle, LoaderCircle, ShieldCheck, WifiOff } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { readCapturedFingerprintSample, selectPreferredFingerprintDevice } from '../lib/fingerprintDevices';

type ReaderState = 'connecting' | 'ready' | 'capturing' | 'matching' | 'offline' | 'error';
type AttendanceResult = { action: 'time-in' | 'time-out'; record: { name: string; employeeId: string; eventTime?: string; checkIn?: string; checkOut?: string; status?: string } };

const qualityMessages: Record<number, string> = {
  0: 'Good scan', 1: 'No fingerprint detected', 2: 'Finger is too light', 3: 'Finger is too dark',
  4: 'Scan is too noisy', 5: 'Low contrast', 6: 'Not enough fingerprint detail', 7: 'Center your finger',
  19: 'Press more gently', 20: 'Press a little more firmly', 21: 'Dry your finger and try again', 23: 'Cover more of the scanner',
};

export function AttendanceKioskView() {
  const apiRef = useRef<Fingerprint.WebApi | null>(null);
  const mountedRef = useRef(true);
  const submittingRef = useRef(false);
  const acquiringRef = useRef(false);
  const deviceRef = useRef('');
  const rearmTimerRef = useRef<number | undefined>(undefined);
  const confirmationRef = useRef<HTMLHeadingElement>(null);
  const autoCaptureRef = useRef<() => Promise<void>>(async () => undefined);
  const [readerState, setReaderState] = useState<ReaderState>('connecting');
  const [message, setMessage] = useState('Connecting to the fingerprint reader...');
  const [result, setResult] = useState<AttendanceResult | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    if (result) confirmationRef.current?.focus();
  }, [result]);

  const startAutomaticCapture = useCallback(async () => {
    if (!mountedRef.current || !apiRef.current || !deviceRef.current || acquiringRef.current || submittingRef.current) return;
    setResult(null); setError('');
    try {
      await apiRef.current.startAcquisition(Fingerprint.SampleFormat.Raw, deviceRef.current);
      acquiringRef.current = true;
    } catch (reason) {
      if (!mountedRef.current) return;
      acquiringRef.current = false;
      setReaderState('error');
      setMessage(reason instanceof Error ? reason.message : 'Unable to start automatic fingerprint capture');
      window.clearTimeout(rearmTimerRef.current);
      rearmTimerRef.current = window.setTimeout(() => void autoCaptureRef.current(), 3000);
    }
  }, []);

  useEffect(() => { autoCaptureRef.current = startAutomaticCapture; }, [startAutomaticCapture]);

  const submitScan = useCallback(async (event: Fingerprint.SamplesAcquired) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    let rearmDelay = 2500;
    setReaderState('matching'); setMessage('Identifying fingerprint...'); setError('');
    try {
      await apiRef.current?.stopAcquisition(event.deviceUid);
      acquiringRef.current = false;
      const sample = readCapturedFingerprintSample(event.samples);
      const response = await apiFetch('/api/attendance/kiosk', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprintSamples: [sample], deviceUid: event.deviceUid || deviceRef.current }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Attendance could not be recorded');
      rearmDelay = 4000;
      if (mountedRef.current) { setResult(data); setReaderState('ready'); setMessage('Attendance saved — remove your finger'); }
    } catch (reason) {
      if (mountedRef.current) { setError(reason instanceof Error ? reason.message : 'Fingerprint could not be identified'); setReaderState(deviceRef.current ? 'ready' : 'offline'); setMessage(deviceRef.current ? 'Ready to try again' : 'Scanner unavailable'); }
    } finally {
      submittingRef.current = false;
      window.clearTimeout(rearmTimerRef.current);
      rearmTimerRef.current = window.setTimeout(() => void startAutomaticCapture(), rearmDelay);
    }
  }, [startAutomaticCapture]);

  useEffect(() => {
    mountedRef.current = true;
    const clock = window.setInterval(() => setNow(new Date()), 1000);
    const api = new Fingerprint.WebApi();
    let reconnectTimer: number | undefined;
    apiRef.current = api;
    const reconnect = () => {
      if (!mountedRef.current) return;
      window.clearTimeout(reconnectTimer);
      setReaderState('connecting');
      setMessage('Connecting to the fingerprint reader...');
      void api.enumerateDevices().then((devices) => selectPreferredFingerprintDevice(api, devices)).then((device) => {
        if (!mountedRef.current) return;
        if (device) {
          deviceRef.current = device.uid; setReaderState('ready'); setMessage(`${device.label} ready — place a finger`);
          window.clearTimeout(rearmTimerRef.current);
          rearmTimerRef.current = window.setTimeout(() => void startAutomaticCapture(), 250);
        }
        else {
          setReaderState('offline'); setMessage('No DigitalPersona fingerprint reader found. Retrying...');
          reconnectTimer = window.setTimeout(reconnect, 3000);
        }
      }).catch(() => {
        if (!mountedRef.current) return;
        setReaderState('offline');
        setMessage('Cannot connect to the HID scanner service. Retrying...');
        reconnectTimer = window.setTimeout(reconnect, 3000);
      });
    };
    api.onDeviceConnected = () => {
      // HID can emit this again when acquisition starts. Re-enumerating here
      // would incorrectly reset an active capture back to the ready screen.
      if (mountedRef.current && !deviceRef.current) reconnect();
    };
    api.onDeviceDisconnected = (event) => {
      if (!mountedRef.current || event.deviceUid !== deviceRef.current) return;
      window.clearTimeout(rearmTimerRef.current);
      acquiringRef.current = false; deviceRef.current = ''; setReaderState('offline'); setMessage('External fingerprint reader disconnected');
      reconnectTimer = window.setTimeout(reconnect, 1000);
    };
    api.onCommunicationFailed = () => {
      if (!mountedRef.current) return;
      window.clearTimeout(rearmTimerRef.current);
      acquiringRef.current = false;
      setReaderState('offline');
      setMessage('Scanner bridge connection was interrupted. Retrying...');
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(reconnect, 3000);
    };
    api.onQualityReported = (event) => { if (mountedRef.current && event.deviceUid === deviceRef.current) setMessage(qualityMessages[event.quality] ?? `Scan quality code ${event.quality}`); };
    api.onErrorOccurred = (event) => {
      if (!mountedRef.current) return;
      acquiringRef.current = false; setReaderState('error'); setMessage(`Scanner error ${event.error}. Retrying automatically...`);
      window.clearTimeout(rearmTimerRef.current);
      rearmTimerRef.current = window.setTimeout(() => void startAutomaticCapture(), 2500);
    };
    api.onAcquisitionStarted = () => { if (mountedRef.current) { acquiringRef.current = true; setReaderState('capturing'); setMessage('Place your registered finger flat on the reader'); } };
    api.onSamplesAcquired = (event) => { if (mountedRef.current && event.deviceUid === deviceRef.current) void submitScan(event); };
    reconnect();
    return () => {
      mountedRef.current = false; window.clearInterval(clock);
      window.clearTimeout(reconnectTimer); window.clearTimeout(rearmTimerRef.current);
      if (acquiringRef.current) void api.stopAcquisition().catch(() => undefined);
      acquiringRef.current = false; api.off(); apiRef.current = null;
    };
  }, [startAutomaticCapture, submitScan]);

  const busy = readerState === 'capturing' || readerState === 'matching';
  const unavailable = readerState === 'offline' || readerState === 'error';
  return <main className="relative min-h-screen overflow-hidden bg-slate-950 px-4 py-6 text-white sm:px-8">
    <div className="pointer-events-none absolute -left-32 top-1/4 h-96 w-96 rounded-full bg-indigo-600/20 blur-3xl" />
    <div className="pointer-events-none absolute -right-24 top-0 h-96 w-96 rounded-full bg-violet-600/20 blur-3xl" />
    <div className="relative mx-auto flex min-h-[calc(100vh-3rem)] max-w-6xl flex-col">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-xl bg-violet-600"><FingerprintIcon className="h-5 w-5" /></div><div><p className="font-bold">WORKPULSE MVL</p><p className="text-xs text-indigo-200/70">Fingerprint attendance kiosk</p></div></div>
        <a href="/overview?view=employees" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15 focus:outline-none focus:ring-4 focus:ring-violet-300/40"><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Admin workspace</a>
      </header>

      <section className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[.9fr_1.1fr]">
        <div>
          <div className="flex items-center gap-3 text-indigo-100"><Clock3 className="h-5 w-5" aria-hidden="true" /><span className="text-sm font-semibold uppercase tracking-[.12em]">{now.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span></div>
          <p className="mt-4 text-6xl font-bold tracking-tight sm:text-7xl">{now.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
          <h1 className="mt-8 max-w-xl text-3xl font-bold leading-tight sm:text-4xl">Record your attendance with one scan</h1>
          <p className="mt-4 max-w-xl text-lg leading-8 text-indigo-100">Place your registered finger flat on the reader. Your time in or time out is selected automatically.</p>
          <div className="mt-7 flex items-start gap-3 rounded-2xl border border-white/15 bg-white/[.06] p-4 text-sm text-indigo-50"><HelpCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" /><p><span className="font-semibold text-white">Cannot use the fingerprint reader?</span><br />Ask your supervisor for the organization’s alternative attendance method.</p></div>
          <div className="mt-4 flex items-center gap-2 text-sm text-emerald-200"><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Your scan is used only to identify your attendance record.</div>
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-white/[.07] p-6 shadow-2xl backdrop-blur-xl sm:p-10">
          <div className="flex flex-col items-center text-center" aria-busy={busy}>
            <div className={`grid h-36 w-36 place-items-center rounded-full border ${unavailable ? 'border-rose-400/30 bg-rose-400/10 text-rose-300' : result ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-violet-300/25 bg-violet-300/10 text-violet-200'} ${busy ? 'animate-pulse ring-8 ring-violet-400/10' : ''}`}>
              {readerState === 'connecting' || readerState === 'matching' ? <LoaderCircle className="h-16 w-16 animate-spin" /> : unavailable ? <WifiOff className="h-16 w-16" /> : result ? <CheckCircle2 className="h-16 w-16" /> : <FingerprintIcon className="h-16 w-16" />}
            </div>
            {result ? <>
              <h2 ref={confirmationRef} tabIndex={-1} className="mt-6 text-3xl font-bold text-white outline-none">{result.action === 'time-in' ? 'Time in recorded' : 'Time out recorded'}</h2>
              <p className="mt-3 text-xl font-semibold text-emerald-200">Attendance saved successfully</p>
              <p className="mt-4 text-lg font-semibold text-white">{result.record.name}</p>
              <p className="mt-1 text-sm text-indigo-200">{result.record.employeeId} · {result.record.eventTime || result.record.checkOut || result.record.checkIn}</p>
              <p className="mt-6 rounded-xl bg-emerald-400/10 px-4 py-3 text-sm font-semibold text-emerald-100">Remove your finger. This screen will reset for the next employee.</p>
            </> : <>
              <p className="mt-6 text-xs font-bold uppercase tracking-[.18em] text-violet-200">Scanner status</p>
              <h2 className="mt-2 text-2xl font-bold" role="status" aria-live="polite" aria-atomic="true">{message}</h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-indigo-100">No button is needed. Keep your finger flat, then lift it after recognition.</p>
              {error && <div className="mt-4 rounded-xl border border-rose-300/30 bg-rose-400/10 px-4 py-3 text-left text-sm text-rose-100" role="alert"><p className="font-semibold">We could not record your attendance.</p><p className="mt-1">{error} Try again, or ask a supervisor for help.</p></div>}
            </>}
          </div>
        </div>
      </section>
    </div>
  </main>;
}
