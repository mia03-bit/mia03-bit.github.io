import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fingerprint-match.ps1');
const DEFAULT_THRESHOLD = 21474; // FingerJet guidance: approximately 0.001% false-match probability.
const MAX_SAMPLE_BYTES = 1024 * 1024;

export class BiometricError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BiometricError';
    this.status = status;
  }
}

export function normalizeFingerprintSamples(value, requiredCount = 1) {
  if (!Array.isArray(value) || value.length !== requiredCount) {
    throw new BiometricError(requiredCount === 1 ? 'One fingerprint scan is required' : `Capture the same finger ${requiredCount} times`);
  }
  const samples = value.map((sample) => String(sample ?? '').trim());
  for (const sample of samples) {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(sample)) throw new BiometricError('Fingerprint sample has an invalid encoding');
    const byteLength = Buffer.from(sample.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length;
    if (byteLength < 64 || byteLength > MAX_SAMPLE_BYTES) throw new BiometricError('Fingerprint sample size is invalid');
  }
  if (new Set(samples).size !== samples.length) throw new BiometricError('Each enrollment scan must be captured separately');
  return samples;
}

function encryptionKey() {
  const material = process.env.BIOMETRIC_ENCRYPTION_KEY || process.env.MONGODB_URI;
  if (!material) throw new BiometricError('Biometric encryption is not configured', 503);
  return crypto.createHash('sha256').update(`workpulse-biometric-v1:${material}`).digest();
}

export function encryptFingerprintSamples(samples) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(samples), 'utf8'), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptFingerprintSamples(payload) {
  if (payload?.version !== 1 || payload?.algorithm !== 'aes-256-gcm') throw new Error('Unsupported biometric template encryption');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  const samples = JSON.parse(plaintext);
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > 4) throw new Error('Biometric template count is invalid');
  return normalizeFingerprintSamples(samples, samples.length);
}

export function fingerprintMatchThreshold() {
  const configured = Number.parseInt(String(process.env.FINGERPRINT_MATCH_THRESHOLD ?? ''), 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_THRESHOLD;
}

export function fingerprintMatchStrength(score, threshold = fingerprintMatchThreshold()) {
  if (score == null || !Number.isFinite(Number(score)) || !Number.isFinite(Number(threshold)) || Number(threshold) <= 0) return null;
  return Number(Math.min(99, Math.max(0, 99 - 4 * (Number(score) / Number(threshold)))).toFixed(1));
}

function runFingerprintTool(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new BiometricError('Fingerprint matching timed out', 503)); }, 15000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(new BiometricError(`Fingerprint matcher is unavailable: ${error.message}`, 503)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const nativeError = stderr.trim();
        if (/AccessViolationException|protected memory|memory is corrupt/i.test(nativeError)) {
          return reject(new BiometricError('This reader returned fingerprint data that is not compatible with HID FingerJet. Use a supported DigitalPersona or Windows biometric reader.', 422));
        }
        return reject(new BiometricError(`Fingerprint matcher failed${nativeError ? `: ${nativeError.slice(0, 240)}` : ''}`, 503));
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new BiometricError('Fingerprint matcher returned an invalid response', 503)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export function runFingerprintMatcher(probe, candidates) {
  return runFingerprintTool({ operation: 'compare', probe, candidates });
}

export async function extractFingerprintTemplates(samples) {
  const result = await runFingerprintTool({ operation: 'extract', samples });
  const templates = normalizeFingerprintSamples(result?.templates, samples.length);
  if (result?.format !== 'DPFJ_FMD_ANSI_378_2004') {
    throw new BiometricError('Fingerprint matcher returned an unsupported template format', 503);
  }
  return { templates, format: result.format };
}

export async function validateEnrollmentSamples(samples) {
  const matchThreshold = fingerprintMatchThreshold();
  const extracted = await extractFingerprintTemplates(samples);
  const templates = extracted.templates;
  const matchingPairs = [];
  let acceptedFormat = extracted.format;

  // Compare every pair instead of making the first impression mandatory. One
  // partial scan should not invalidate two mutually consistent impressions.
  for (let probeIndex = 0; probeIndex < templates.length - 1; probeIndex += 1) {
    const candidates = templates.slice(probeIndex + 1).map((sample, offset) => ({
      employeeId: `capture-${probeIndex + offset + 1}`,
      samples: [sample],
    }));
    const comparison = await runFingerprintMatcher(templates[probeIndex], candidates);
    for (const item of comparison.results ?? []) {
      if (item.format && !acceptedFormat) acceptedFormat = item.format;
      if (!item.format || Number(item.score) > matchThreshold) continue;
      const candidateIndex = Number(String(item.employeeId).replace('capture-', ''));
      if (!Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= samples.length) continue;
      matchingPairs.push({ first: probeIndex, second: candidateIndex, score: Number(item.score) });
    }
  }

  if (!acceptedFormat) {
    throw new BiometricError('The reader sample format is not supported by the installed HID FingerJet matcher. Recapture using a supported reader.', 422);
  }

  if (!matchingPairs.length) throw new BiometricError('The enrollment scans did not match. Use the same finger for all three scans.');

  // All three impressions must agree. This keeps three useful reference
  // templates without allowing unrelated fingers under one employee identity.
  const pairKeys = new Set(matchingPairs.map((pair) => `${Math.min(pair.first, pair.second)}:${Math.max(pair.first, pair.second)}`));
  const allThreeAgree = templates.length === 3 && pairKeys.has('0:1') && pairKeys.has('0:2') && pairKeys.has('1:2');
  if (!allThreeAgree) throw new BiometricError('All three enrollment scans must match the same finger. Start over and keep the finger centered for every scan.');
  return { threshold: matchThreshold, format: acceptedFormat, templates };
}

export async function findFingerprintDecision(probe, templateDocuments) {
  const candidates = [];
  for (const template of templateDocuments) {
    try { candidates.push({ employeeId: template.employeeId, samples: decryptFingerprintSamples(template.protectedSamples) }); }
    catch (error) { console.error(`Biometric template ${template.employeeId} could not be decrypted:`, error instanceof Error ? error.message : error); }
  }
  if (!candidates.length) return { accepted: false, best: null, threshold: fingerprintMatchThreshold() };
  const result = await runFingerprintMatcher(probe, candidates);
  const best = result.best;
  const matchThreshold = fingerprintMatchThreshold();
  return {
    accepted: Boolean(best && Number(best.score) <= matchThreshold),
    best: best ? { employeeId: best.employeeId, score: Number(best.score), format: best.format } : null,
    threshold: matchThreshold,
  };
}

export async function findFingerprintMatch(probe, templateDocuments) {
  const decision = await findFingerprintDecision(probe, templateDocuments);
  return decision.accepted ? decision.best : null;
}

export async function rejectDuplicateEnrollment(db, enrollmentTemplates) {
  // A biometric identity remains reserved while its template exists. Check
  // active, inactive, archived, and the employee's current enrollment so a
  // re-registration cannot silently reuse any finger already in the database.
  const storedTemplates = await db.collection('biometric_templates').find({}).toArray();
  if (!storedTemplates.length) return;
  for (const enrollmentTemplate of enrollmentTemplates) {
    const duplicate = await findFingerprintMatch(enrollmentTemplate, storedTemplates);
    if (duplicate) throw new BiometricError('This fingerprint is already registered. Use a different finger that is not saved in the system.', 409);
  }
}
