/// <reference types="@digitalpersona/websdk" />
/// <reference types="@digitalpersona/fingerprint" />

import { useEffect, useRef, useState } from "react";
import { Fingerprint as FingerprintIcon, LoaderCircle } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { readCapturedFingerprintSample, selectPreferredFingerprintDevice } from "../../lib/fingerprintDevices";
import { Button } from "../ui/Button";

type Classification = "TA" | "TR" | "FA" | "FR";
type Trial = { id: string; classification: Classification | null; scanKind?: "automatic" | "controlled"; expectedType: "genuine" | "impostor" | "automatic"; expectedEmployeeName: string | null; actualEmployeeName: string | null; accepted: boolean; matchStrength: number | null; responseTimeMs: number };
export type EvaluationSummary = { counts: Record<Classification, number>; totalTrials: number; accuracy: number | null; far: number | null; frr: number | null; averageResponseTimeMs: number; genuineTrialCount: number; impostorTrialCount: number; wrongIdentificationCount: number; minimumRecommendedTrials: number; recentTrials: Trial[] };

export function FingerprintEvaluation({ data, onTrialSaved }: { data: EvaluationSummary; onTrialSaved: () => void }) {
  const apiRef = useRef<Fingerprint.WebApi | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const [message, setMessage] = useState("Press Scan and identify, then place one finger flat on the reader.");

  useEffect(() => {
    return () => { if (apiRef.current) { void apiRef.current.stopAcquisition().catch(() => undefined); apiRef.current.off(); } };
  }, []);

  const identifyFinger = async () => {
    setIdentifying(true); setMessage("Connecting to the reader…");
    try {
      const api = new Fingerprint.WebApi();
      apiRef.current = api;
      const device = await api.enumerateDevices().then((devices) => selectPreferredFingerprintDevice(api, devices));
      if (!device) throw new Error("No supported fingerprint reader was found.");
      api.onQualityReported = (event) => { if (event.deviceUid === device.uid) setMessage(event.quality === 0 ? "Good scan—identifying the employee…" : "Adjust your finger and keep it flat."); };
      api.onSamplesAcquired = async (event) => {
        if (event.deviceUid !== device.uid) return;
        try {
          await api.stopAcquisition(event.deviceUid);
          const sample = readCapturedFingerprintSample(event.samples);
          setMessage("Looking for the employee who owns this fingerprint…");
          const response = await apiFetch("/api/fingerprints/identify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fingerprintSamples: [sample], deviceUid: device.uid }) });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error || "The fingerprint could not be identified.");
          setMessage(result.recognized ? `${result.employeeName} was identified${result.matchStrength == null ? "." : ` with ${result.matchStrength}% match quality.`}` : `No registered employee matched this fingerprint${result.matchStrength == null ? "." : ` (${result.matchStrength}% match quality).`}`);
          onTrialSaved();
        } catch (reason) { setMessage(reason instanceof Error ? reason.message : "The fingerprint could not be identified."); }
        finally { setIdentifying(false); api.off(); apiRef.current = null; }
      };
      api.onErrorOccurred = () => { setIdentifying(false); setMessage("The reader could not capture the fingerprint. Try again."); api.off(); apiRef.current = null; };
      setMessage("Reader ready—place the registered finger flat and hold still.");
      await api.startAcquisition(Fingerprint.SampleFormat.Raw, device.uid);
    } catch (reason) { setIdentifying(false); setMessage(reason instanceof Error ? reason.message : "Cannot connect to the reader."); apiRef.current?.off(); apiRef.current = null; }
  };

  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
    <div className="border-b border-slate-200 bg-slate-50/80 px-5 py-4"><p className="text-xs font-semibold uppercase tracking-[.16em] text-violet-700">Fingerprint review</p><h3 className="mt-1 text-lg font-bold text-slate-900">Automatic fingerprint identification</h3><p className="mt-1 text-sm text-slate-600">Identify a fingerprint and review its match quality.</p></div>
    <div className="space-y-5 p-5">
      <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm leading-6 text-sky-950"><strong>No employee selection is needed.</strong> Press “Scan and identify.” A recognized employee or “No registered match” will appear here and in Recent Fingerprint Scans.</div>
      <div className="overflow-hidden rounded-2xl border border-slate-200"><div className="border-b border-slate-200 bg-slate-50 px-4 py-3"><h4 className="text-sm font-bold text-slate-900">How a scan is decided</h4><p className="mt-1 text-xs leading-5 text-slate-600">Only a match quality of <strong>95% or higher</strong> is accepted. A retry never records attendance until the scan reaches the acceptance standard.</p></div><div className="grid gap-px bg-slate-200 sm:grid-cols-3"><QualityRule range="95% or higher" title="Accepted" note="Registered fingerprint confidently matched." tone="emerald" /><QualityRule range="80%–94.9%" title="Retry scan" note="Not accepted. Clean the reader, place the finger flat, and scan again." tone="amber" /><QualityRule range="Below 80%" title="Rejected" note="No acceptable fingerprint match." tone="red" /></div><p className="bg-violet-50 px-4 py-3 text-xs leading-5 text-violet-900"><strong>About accuracy:</strong> Match quality is the score for one scan, not the system's overall accuracy. Prove accuracy separately with repeated, labeled tests and report the number of correct results divided by all valid tests.</p></div>
      <div className="rounded-2xl border border-violet-200 bg-violet-50/50 p-4"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><div><h4 className="text-sm font-bold text-violet-950">Automatic fingerprint identification</h4><p className="mt-1 max-w-2xl text-xs leading-5 text-violet-800">Scan once. The system will automatically show the employee name or “No registered match,” then add the result to Recent Fingerprint Scans.</p></div><Button disabled={identifying} onClick={() => void identifyFinger()}>{identifying ? <LoaderCircle className="animate-spin" size={16} /> : <FingerprintIcon size={16} />}{identifying ? "Identifying…" : "Scan and identify"}</Button></div><div aria-live="polite" className="mt-3 rounded-lg bg-white px-3 py-3 text-sm font-medium text-slate-700">{message}</div></div>
      {data.recentTrials.length > 0 && <div className="overflow-hidden rounded-xl border border-slate-200"><div className="bg-slate-50 px-4 py-3"><h4 className="text-sm font-bold text-slate-900">Recent fingerprint scans</h4><p className="mt-1 text-xs text-slate-500">Review match quality and the action taken. Test scans do not change attendance.</p></div>{data.recentTrials.slice(0, 10).map((trial) => { const quality = qualityResult(trial.matchStrength); return <div key={trial.id} className="grid gap-3 border-t border-slate-100 px-4 py-3 sm:grid-cols-[1fr_auto_auto] sm:items-center"><div><p className="text-sm font-semibold text-slate-800">{trial.accepted ? trial.actualEmployeeName || "Registered employee recognized" : "No registered match"}</p><p className="mt-1 text-xs leading-5 text-slate-500">{quality.explanation}</p></div><div className="text-left sm:text-right"><p className="text-lg font-bold text-slate-900">{trial.matchStrength == null ? "No score" : `${trial.matchStrength}%`}</p><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Match quality</p></div><span className={`rounded-full px-2.5 py-1 text-center text-xs font-semibold ${quality.style}`}>{quality.label}</span></div>; })}</div>}
    </div>
  </section>;
}

function QualityRule({ range, title, note, tone }: { range: string; title: string; note: string; tone: "emerald" | "amber" | "red" }) {
  const styles = { emerald: "text-emerald-700", amber: "text-amber-700", sky: "text-sky-700", red: "text-red-700" };
  return <div className="bg-white p-4"><p className={`text-xs font-bold ${styles[tone]}`}>{range}</p><p className="mt-1 text-sm font-semibold text-slate-900">{title}</p><p className="mt-1 text-xs leading-5 text-slate-500">{note}</p></div>;
}

function qualityResult(value: number | null) {
  if (value == null) return { label: "No score", explanation: "The scanner did not produce a usable match score.", style: "bg-slate-100 text-slate-600" };
  if (value >= 95) return { label: "Accepted", explanation: "The scan met the 95% acceptance standard.", style: "bg-emerald-100 text-emerald-700" };
  if (value >= 80) return { label: "Retry", explanation: "Not accepted. Clean the reader or reposition the finger, then scan again.", style: "bg-amber-100 text-amber-700" };
  return { label: "Rejected", explanation: "The scan was below the acceptable match-quality range.", style: "bg-red-100 text-red-700" };
}
