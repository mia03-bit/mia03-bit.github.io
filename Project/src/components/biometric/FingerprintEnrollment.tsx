/// <reference types="@digitalpersona/websdk" />
/// <reference types="@digitalpersona/fingerprint" />

import { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Fingerprint as FingerprintIcon, LoaderCircle, RotateCcw, ScanLine, WifiOff } from 'lucide-react';
import { readCapturedFingerprintSample, selectPreferredFingerprintDevice } from '../../lib/fingerprintDevices';
import { Button } from '../ui/Button';

const REQUIRED_SCANS = 3;
const qualityMessages: Record<number, string> = {
  0: 'Good scan', 1: 'No fingerprint detected', 2: 'Finger is too light', 3: 'Finger is too dark',
  4: 'Scan is too noisy', 5: 'Low contrast', 6: 'Not enough fingerprint detail', 7: 'Center your finger',
  19: 'Press more gently', 20: 'Press a little more firmly', 21: 'Dry your finger and try again', 23: 'Cover more of the reader',
};

export function FingerprintEnrollment({ onComplete, onCancel, validateScan }: {
  onComplete: (samples: string[], deviceUid: string) => void;
  onCancel: () => void;
  validateScan?: (sample: string) => Promise<void>;
}) {
  const apiRef = useRef<Fingerprint.WebApi | null>(null);
  const onCompleteRef = useRef(onComplete);
  const validateScanRef = useRef(validateScan);
  const samplesRef = useRef<string[]>([]);
  const acquiringRef = useRef(false);
  const deviceRef = useRef('');
  const reconnectRef = useRef<() => void>(() => undefined);
  const feedbackTimerRef = useRef<number | undefined>(undefined);
  const rearmTimerRef = useRef<number | undefined>(undefined);
  const processingRef = useRef(false);
  const startCaptureRef = useRef<() => Promise<void>>(async () => undefined);
  const qualityRef = useRef<number | null>(null);
  const [samples, setSamples] = useState<string[]>([]);
  const [deviceUid, setDeviceUid] = useState('');
  const [state, setState] = useState<'connecting' | 'ready' | 'waiting' | 'capturing' | 'offline' | 'complete'>('connecting');
  const [message, setMessage] = useState('Connecting to the fingerprint reader...');
  const [quality, setQuality] = useState<number | null>(null);
  const [justCaptured, setJustCaptured] = useState(false);


  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { validateScanRef.current = validateScan; }, [validateScan]);

  async function startAutomaticCapture() {
    if (!apiRef.current || !deviceRef.current || acquiringRef.current || processingRef.current || samplesRef.current.length >= REQUIRED_SCANS) return;
    qualityRef.current = null; setQuality(null); setJustCaptured(false);
    try {
      await apiRef.current.startAcquisition(Fingerprint.SampleFormat.Raw, deviceRef.current);
      acquiringRef.current = true;
    } catch (error) {
      setState('ready'); setMessage(error instanceof Error ? error.message : 'Unable to start fingerprint capture');
      window.clearTimeout(rearmTimerRef.current);
      rearmTimerRef.current = window.setTimeout(() => void startCaptureRef.current(), 3000);
    }
  }

  useEffect(() => { startCaptureRef.current = startAutomaticCapture; });

  function scheduleNextScan(delay = 0, waitingMessage = 'Lift and replace your finger for the next scan.') {
    window.clearTimeout(rearmTimerRef.current);
    setState('waiting');
    setMessage(waitingMessage);
    rearmTimerRef.current = window.setTimeout(() => void startCaptureRef.current(), delay);
  }
  useEffect(() => {
    let mounted = true;
    const api = new Fingerprint.WebApi();
    let reconnectTimer: number | undefined;
    apiRef.current = api;
    const reconnect = () => {
      if (!mounted) return;
      window.clearTimeout(reconnectTimer);
      setState('connecting'); setMessage('Connecting to the fingerprint reader...');
      void api.enumerateDevices().then((devices) => selectPreferredFingerprintDevice(api, devices)).then((device) => {
        if (!mounted) return;
        if (device) { deviceRef.current = device.uid; setDeviceUid(device.uid); setState('ready'); setMessage(`${device.label} ready — automatic capture starting`); window.clearTimeout(rearmTimerRef.current); rearmTimerRef.current = window.setTimeout(() => void startCaptureRef.current(), 700); }
        else { setState('offline'); setMessage('No DigitalPersona fingerprint reader found'); }
      }).catch(() => {
        if (!mounted) return;
        setState('offline'); setMessage('Cannot connect to the HID scanner service. Retrying...');
        reconnectTimer = window.setTimeout(reconnect, 3000);
      });
    };
    reconnectRef.current = reconnect;
    api.onDeviceConnected = () => { if (mounted && !deviceRef.current) reconnect(); };
    api.onDeviceDisconnected = (event) => {
      if (!mounted || event.deviceUid !== deviceRef.current) return;
      window.clearTimeout(rearmTimerRef.current);
      acquiringRef.current = false; deviceRef.current = ''; setDeviceUid(''); setState('offline'); setMessage('Fingerprint reader disconnected');
      reconnectTimer = window.setTimeout(reconnect, 1000);
    };
    api.onCommunicationFailed = () => {
      if (!mounted) return;
      window.clearTimeout(rearmTimerRef.current);
      acquiringRef.current = false; setState('offline'); setMessage('Scanner bridge connection was interrupted. Retrying...');
      window.clearTimeout(reconnectTimer); reconnectTimer = window.setTimeout(reconnect, 3000);
    };
    api.onQualityReported = (event) => {
      if (!mounted || event.deviceUid !== deviceRef.current) return;
      qualityRef.current = event.quality; setQuality(event.quality); setMessage(qualityMessages[event.quality] ?? `Scan quality code ${event.quality}`);
    };
    api.onErrorOccurred = (event) => {
      if (mounted) { acquiringRef.current = false; qualityRef.current = null; setQuality(null); setState('ready'); setMessage(`Scanner error ${event.error}. Retrying automatically.`); window.clearTimeout(rearmTimerRef.current); rearmTimerRef.current = window.setTimeout(() => void startCaptureRef.current(), 3000); }
    };
    api.onAcquisitionStarted = () => {
      if (mounted) { acquiringRef.current = true; setQuality(null); setJustCaptured(false); setState('capturing'); setMessage('Lift and place the same finger flat on the reader'); }
    };
    api.onSamplesAcquired = (event) => {
      if (!mounted || event.deviceUid !== deviceRef.current || processingRef.current || samplesRef.current.length >= REQUIRED_SCANS) return;
      processingRef.current = true;
      const capturedQuality = qualityRef.current;
      setState('waiting'); setMessage('Checking scan...');
      acquiringRef.current = false;
      void (async () => { try {
        await api.stopAcquisition(event.deviceUid);
        if (!mounted) return;
        if (capturedQuality !== null && capturedQuality !== 0) throw new Error(qualityMessages[capturedQuality] || 'Scan quality was too low');
        const sample = readCapturedFingerprintSample(event.samples);
        setState('waiting'); setMessage('Checking whether this fingerprint is already registered...');
        if (validateScanRef.current) await validateScanRef.current(sample);
        if (!mounted) return;
        if (samplesRef.current.includes(sample)) throw new Error('Lift your finger fully and place it again for a fresh scan.');
        const next = [...samplesRef.current, sample].slice(0, REQUIRED_SCANS);
        samplesRef.current = next; setSamples(next); setQuality(0); setJustCaptured(true);
        window.clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = window.setTimeout(() => setJustCaptured(false), 1400);
        if (next.length === REQUIRED_SCANS) {
          setState('complete'); setMessage('All three fingerprint scans are ready'); onCompleteRef.current(next, event.deviceUid || deviceRef.current);
        } else {
          setState('ready'); setMessage(`Scan ${next.length} saved — lift your finger before the next scan`);
        }
        if (next.length < REQUIRED_SCANS) scheduleNextScan();
      } catch (error) {
        if (!mounted) return;
        const retryMessage = error instanceof Error ? error.message : 'Could not read the fingerprint sample';
        setState('ready'); setMessage(retryMessage);
        scheduleNextScan(1000, `${retryMessage} Retrying automatically.`);
      } finally { processingRef.current = false; } })();
    };
    reconnect();
    return () => {
      mounted = false; window.clearTimeout(reconnectTimer); window.clearTimeout(feedbackTimerRef.current); window.clearTimeout(rearmTimerRef.current);
      if (acquiringRef.current) void api.stopAcquisition().catch(() => undefined);
      acquiringRef.current = false; api.off(); apiRef.current = null;
    };
  }, []);

  function reset() {
    window.clearTimeout(rearmTimerRef.current);
    samplesRef.current = []; setSamples([]); qualityRef.current = null; setQuality(null); setJustCaptured(false);
    setState(deviceRef.current ? 'ready' : 'offline'); setMessage(deviceRef.current ? 'Reader ready — automatic capture starting' : 'Reader unavailable');
    if (deviceRef.current) rearmTimerRef.current = window.setTimeout(() => void startCaptureRef.current(), 700);
  }

  const poorQuality = quality !== null && quality !== 0;
  const visualTone = state === 'offline'
    ? 'border-rose-200 bg-rose-50 text-rose-600 shadow-rose-100'
    : state === 'complete' || justCaptured
      ? 'border-emerald-200 bg-emerald-50 text-emerald-600 shadow-emerald-100'
      : poorQuality
        ? 'border-amber-200 bg-amber-50 text-amber-600 shadow-amber-100'
        : state === 'capturing' || state === 'waiting'
          ? 'border-violet-300 bg-violet-50 text-violet-700 shadow-violet-200'
          : 'border-slate-200 bg-white text-violet-600 shadow-slate-100';
  const statusLabel = state === 'connecting' ? 'Connecting'
    : state === 'offline' ? 'Reader offline'
      : state === 'complete' ? 'Enrollment ready'
        : state === 'capturing' ? 'Live capture'
          : state === 'waiting' ? 'Checking scan'
            : `${samples.length} of ${REQUIRED_SCANS} saved`;

  return <div className="overflow-hidden rounded-2xl border border-violet-200/80 bg-gradient-to-br from-white via-white to-violet-50/60 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-violet-100 px-5 py-4">
      <div><p className="text-sm font-semibold text-slate-900">Fingerprint enrollment</p><p className="mt-0.5 text-xs text-slate-500">Use the same finger for every impression.</p></div>
      <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${state === 'complete' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : state === 'offline' ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-violet-200 bg-violet-50 text-violet-700'}`}>
        <span className={`h-2 w-2 rounded-full ${state === 'capturing' ? 'animate-pulse bg-violet-500' : state === 'complete' ? 'bg-emerald-500' : state === 'offline' ? 'bg-rose-500' : 'bg-violet-400'}`} />{statusLabel}
      </span>
    </div>

    <div className="grid gap-5 p-5 sm:grid-cols-[8rem_1fr] sm:items-center">
      <div className="flex justify-center">
        <div className={`relative grid h-28 w-28 place-items-center rounded-[2rem] border-2 shadow-xl transition-all duration-300 ${visualTone} ${state === 'capturing' ? 'scale-[1.03]' : ''}`}>
          {state === 'capturing' && <><span className="absolute inset-3 animate-ping rounded-[1.4rem] border border-violet-300 opacity-40" /><ScanLine className="absolute top-3 h-5 w-5 animate-bounce opacity-70" /></>}
          {state === 'connecting' ? <LoaderCircle className="h-12 w-12 animate-spin" /> : state === 'offline' ? <WifiOff className="h-12 w-12" /> : state === 'complete' || justCaptured ? <CheckCircle2 className="h-14 w-14" /> : <FingerprintIcon className={`h-14 w-14 transition-colors ${state === 'capturing' ? 'animate-pulse' : ''}`} />}
          <span className={`absolute -bottom-2 rounded-full border bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${poorQuality ? 'border-amber-200 text-amber-700' : justCaptured || state === 'complete' ? 'border-emerald-200 text-emerald-700' : 'border-violet-200 text-violet-700'}`}>
            {poorQuality ? 'Adjust finger' : justCaptured ? 'Scan saved' : state === 'capturing' ? 'Sensing' : state === 'complete' ? 'Complete' : 'Ready'}
          </span>
        </div>
      </div>

      <div className="min-w-0">
        <p className={`text-base font-semibold ${poorQuality ? 'text-amber-700' : justCaptured || state === 'complete' ? 'text-emerald-700' : 'text-slate-900'}`}>{message}</p>
        <p className="mt-1 text-xs text-slate-500">Keep your finger centered and still until the scan is saved{deviceUid ? ` · Reader ${deviceUid.slice(-8)}` : ''}.</p>
        <div className="mt-5 grid grid-cols-3 gap-2">
          {Array.from({ length: REQUIRED_SCANS }, (_, index) => {
            const saved = index < samples.length;
            const current = index === samples.length && state !== 'complete';
            return <div key={index} className={`rounded-xl border px-2 py-2 text-center transition-all ${saved ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : current ? 'border-violet-300 bg-violet-50 text-violet-700 shadow-sm' : 'border-slate-200 bg-slate-50 text-slate-400'}`}>
              <div className="mx-auto grid h-6 w-6 place-items-center rounded-full">{saved ? <Check className="h-4 w-4" /> : <span className="text-xs font-bold">{index + 1}</span>}</div>
              <p className="mt-0.5 text-[10px] font-semibold">{saved ? 'Saved' : current ? 'Next' : 'Pending'}</p>
            </div>;
          })}
        </div>
      </div>
    </div>

    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-violet-100 bg-white/70 px-5 py-4">
      <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      {samples.length > 0 && <Button type="button" variant="outline" onClick={reset} disabled={state === 'waiting' || state === 'capturing'}><RotateCcw className="h-4 w-4" /> Start over</Button>}
      <Button type="button" className="min-w-44" onClick={() => state === 'offline' ? reconnectRef.current() : undefined} disabled={state !== 'offline'}>
        {state === 'connecting' || state === 'capturing' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : state === 'offline' ? <RotateCcw className="h-4 w-4" /> : state === 'complete' ? <Check className="h-4 w-4" /> : <FingerprintIcon className="h-4 w-4" />}
        {state === 'connecting' ? 'Connecting...' : state === 'offline' ? 'Reconnect reader' : state === 'capturing' ? 'Hold finger still' : state === 'waiting' ? 'Checking scan' : state === 'complete' ? 'Scans complete' : 'Starting automatically'}
      </Button>
    </div>
  </div>;
}
