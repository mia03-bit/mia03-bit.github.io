const DAY_MS = 86_400_000;
const TIME_ZONE = 'Asia/Manila';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 1) => Number(value.toFixed(digits));
// Operator-facing index: a score at the native acceptance boundary is 95,
// and a theoretically perfect dissimilarity score is capped at 99.
const matchStrength = (score, threshold) => round(clamp(99 - 4 * (score / threshold), 0, 99));
const asDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const isoDate = (date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const utcDate = (value) => {
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  return year && month && day ? new Date(Date.UTC(year, month - 1, day)) : null;
};
const addDays = (date, amount) => new Date(date.getTime() + amount * DAY_MS);
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const clockMinutes = (value) => {
  if (!value) return null;
  const match = String(value).match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 1_440 ? minutes : null;
};
const displayClock = (minutes) => {
  const total = ((Math.round(minutes) % 1_440) + 1_440) % 1_440;
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
};
const sessionsFor = (record) => Array.isArray(record?.sessions) && record.sessions.length
  ? record.sessions
  : [{
      checkIn: record?.checkIn, checkOut: record?.checkOut,
      matchScore: record?.matchScore, checkoutMatchScore: record?.checkoutMatchScore,
      deviceUid: record?.deviceUid, checkoutDeviceUid: record?.checkoutDeviceUid,
      checkInAt: record?.checkInAt, checkOutAt: record?.checkOutAt,
    }];

function forecastInsight(attendance, activeEmployees, today) {
  const todayDate = utcDate(today);
  const historyStart = addDays(todayDate, -89);
  const dated = attendance.filter((item) => {
    const date = utcDate(item.date);
    return date && date >= historyStart && date <= todayDate;
  });
  const latestDataDate = dated.reduce((latest, item) => {
    const date = utcDate(item.date);
    return !latest || date > latest ? date : latest;
  }, null);
  const counts = new Map();
  const observedDates = new Set();
  const clockInDates = new Set();
  for (const item of dated) {
    const day = String(item.date).slice(0, 10);
    observedDates.add(day);
    const present = item.status !== 'Absent' && sessionsFor(item).some((session) => session.checkIn);
    if (present) {
      counts.set(day, (counts.get(day) || 0) + 1);
      clockInDates.add(day);
    }
  }
  const series = [...observedDates].sort().map((date) => ({ date, value: counts.get(date) || 0 }));
  const values = series.map((item) => item.value);
  // Allow a normal two-day weekend gap, but do not call an older dataset ready.
  const dataStale = !latestDataDate || latestDataDate < addDays(todayDate, -2);
  const ready = activeEmployees > 0 && clockInDates.size >= 14 && !dataStale;
  const weekdayAverages = Array.from({ length: 7 }, (_, day) => {
    const matches = series.filter((item) => utcDate(item.date).getUTCDay() === day).map((item) => item.value);
    return matches.length ? matches.reduce((sum, value) => sum + value, 0) / matches.length : 0;
  });
  let level = values.slice(0, 7).reduce((sum, value) => sum + value, 0) / Math.max(1, Math.min(7, values.length));
  let trend = values.length >= 14
    ? (values.slice(-7).reduce((sum, value) => sum + value, 0) - values.slice(-14, -7).reduce((sum, value) => sum + value, 0)) / 49
    : 0;
  const season = weekdayAverages.map((value) => value - level);
  if (ready) {
    values.forEach((value, index) => {
      const day = utcDate(series[index].date).getUTCDay();
      const previousLevel = level;
      level = 0.45 * (value - season[day]) + 0.55 * (level + trend);
      trend = 0.2 * (level - previousLevel) + 0.8 * trend;
      season[day] = 0.3 * (value - level) + 0.7 * season[day];
    });
  }
  const forecast = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(todayDate, index + 1);
    const day = date.getUTCDay();
    const weekdayBaseline = weekdayAverages[day];
    const modelEstimate = level + (index + 1) * trend + season[day];
    const maxAdjustment = Math.max(2, weekdayBaseline * 0.15);
    const estimate = ready
      ? weekdayBaseline + clamp(modelEstimate - weekdayBaseline, -maxAdjustment, maxAdjustment)
      : weekdayBaseline;
    const expectedPresent = Math.round(clamp(estimate, 0, activeEmployees));
    const weekdaySamples = series.filter((item) => utcDate(item.date).getUTCDay() === day);
    const weekdayAverage = Math.round(weekdayAverages[day]);
    const trendDirection = Math.abs(trend) < 0.05 ? 'stable' : trend > 0 ? 'increasing' : 'decreasing';
    const expectedLabel = `${expectedPresent} ${expectedPresent === 1 ? 'employee' : 'employees'}`;
    const averageLabel = `${weekdayAverage} ${weekdayAverage === 1 ? 'employee' : 'employees'}`;
    const trendExplanation = trendDirection === 'stable'
      ? 'Recent attendance has stayed about the same.'
      : trendDirection === 'increasing'
        ? 'Recent attendance has been going up.'
        : 'Recent attendance has been going down.';
    return {
      date: date.toISOString().slice(0, 10), expectedPresent,
      attendanceRate: activeEmployees ? round(expectedPresent / activeEmployees * 100) : 0,
      weekdayAverage, weekdaySamples: weekdaySamples.length, trendDirection,
      explanation: ready
        ? `We expect ${expectedLabel} because usually around ${averageLabel} attended on recent ${displayWeekday(day)}s. ${trendExplanation}`
        : `We expect ${expectedLabel} because around ${averageLabel} attended on previous ${displayWeekday(day)}s. More attendance records will make this estimate clearer.`,
    };
  });
  const average = forecast.reduce((sum, day) => sum + day.expectedPresent, 0) / forecast.length;
  return {
    version: 'Holt-Winters additive · bounded weekly baseline', status: ready ? 'ready' : 'limited',
    sampleDays: series.length, clockInDays: clockInDates.size, activeEmployees,
    latestDataDate: latestDataDate?.toISOString().slice(0, 10) || null,
    dataStale,
    forecast,
    summary: !activeEmployees
      ? 'Add active employees to generate a forecast'
      : ready
        ? `${round(average)} of ${activeEmployees} employees expected per day next week`
        : `Limited forecast: only ${clockInDates.size} days contain valid clock-ins`,
  };
}

function displayWeekday(day) {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day];
}

function leaveDateSet(leaveRequests) {
  const result = new Map();
  for (const leave of leaveRequests.filter((item) => item.status === 'approved')) {
    if (!result.has(leave.employeeId)) result.set(leave.employeeId, new Set());
    if (Array.isArray(leave.approvedDates) && leave.approvedDates.length) {
      for (const value of leave.approvedDates) {
        const approvedDate = utcDate(value);
        if (approvedDate) result.get(leave.employeeId).add(approvedDate.toISOString().slice(0, 10));
      }
      continue;
    }
    const start = utcDate(leave.startDate);
    const end = utcDate(leave.endDate);
    if (!start || !end) continue;
    for (let date = start; date <= end; date = addDays(date, 1)) result.get(leave.employeeId).add(date.toISOString().slice(0, 10));
  }
  return result;
}

export function attendanceFlagFor(absenceDays) {
  if (absenceDays >= 26) return 'red';
  if (absenceDays >= 16) return 'orange';
  return 'green';
}

export function attendanceRiskForEmployee(attendance, employeeId, leaveRequests, today) {
  const todayDate = utcDate(today);
  const periodStart = addDays(todayDate, -29).toISOString().slice(0, 10);
  const periodEnd = todayDate.toISOString().slice(0, 10);
  const coveredLeave = leaveDateSet(leaveRequests);
  const records = attendance
    .filter((item) => item.employeeId === employeeId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const absenceDates = records
    .map((item) => ({ status: item.status, day: String(item.date).slice(0, 10) }))
    .filter((item) => item.status === 'Absent' && item.day >= periodStart && item.day <= periodEnd && !coveredLeave.get(employeeId)?.has(item.day))
    .map((item) => item.day);
  const lateDays = records.filter((item) => {
    const day = String(item.date).slice(0, 10);
    return item.status === 'Late' && day >= periodStart && day <= periodEnd;
  }).length;
  return { tier: attendanceFlagFor(absenceDates.length), absenceDays: absenceDates.length, absenceDates, lateDays, periodStart, periodEnd };
}

function riskInsight(attendance, employees, leaveRequests, today) {
  const todayDate = utcDate(today);
  const periodStart = addDays(todayDate, -29).toISOString().slice(0, 10);
  const periodEnd = todayDate.toISOString().slice(0, 10);
  const rows = employees.map((employee) => {
    const result = attendanceRiskForEmployee(attendance, employee.id, leaveRequests, today);
    return { employeeId: employee.id, name: employee.name || employee.fullName || employee.id, ...result };
  }).sort((a, b) => b.absenceDays - a.absenceDays || b.lateDays - a.lateDays || a.name.localeCompare(b.name));
  const flagged = rows.filter((row) => row.tier !== 'green').length;
  return {
    version: '30-day unapproved absence count', status: rows.length ? 'ready' : 'limited', periodStart, periodEnd,
    employeesAnalyzed: rows.length, flagged,
    employees: rows, summary: rows.length ? `${flagged} ${flagged === 1 ? 'employee has' : 'employees have'} an Orange or Red attendance flag` : 'No employee records to analyze',
  };
}

function anomalyInsight(attendance, employees) {
  const names = new Map(employees.map((employee) => [employee.id, employee.name || employee.fullName || employee.id]));
  const scans = attendance.flatMap((record) => {
    const first = sessionsFor(record)[0];
    const minutes = clockMinutes(first?.checkIn);
    return minutes == null ? [] : [{ employeeId: record.employeeId, name: names.get(record.employeeId) || record.employeeId, date: String(record.date).slice(0, 10), time: first.checkIn, minutes }];
  });
  const values = scans.map((scan) => scan.minutes);
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  const scale = Math.max(mad, 15);
  const anomalies = scans.map((scan) => ({
    ...scan, score: round(0.6745 * (scan.minutes - center) / scale, 2), deviationMinutes: Math.round(scan.minutes - center),
  })).filter((scan) => Math.abs(scan.score) > 3.5).sort((a, b) => String(b.date).localeCompare(String(a.date)) || Math.abs(b.score) - Math.abs(a.score)).slice(0, 200);
  return {
    version: 'Modified Z-score · MAD baseline', status: scans.length >= 7 ? 'ready' : 'limited', sampleScans: scans.length,
    medianTime: values.length ? displayClock(center) : 'No data', madMinutes: round(mad), scaleMinutes: scale,
    anomalies, summary: values.length ? `${anomalies.length} unusual arrival ${anomalies.length === 1 ? 'time' : 'times'} detected` : 'No arrival scans to analyze',
  };
}

function verificationInsight(attendance, verificationAttempts, evaluationTrials, employees, threshold) {
  const matches = [];
  for (const record of attendance) {
    for (const session of sessionsFor(record)) {
      const pairs = [
        { rawScore: session.matchScore, rawDevice: session.deviceUid, rawDate: session.checkInAt || record.date, action: 'time-in', eventTime: session.checkIn },
        { rawScore: session.checkoutMatchScore, rawDevice: session.checkoutDeviceUid || session.deviceUid, rawDate: session.checkOutAt || record.date, action: 'time-out', eventTime: session.checkOut },
      ];
      for (const { rawScore, rawDevice, rawDate, action, eventTime } of pairs) {
        if (rawScore == null || !Number.isFinite(Number(rawScore))) continue;
        matches.push({
          score: Number(rawScore), deviceUid: rawDevice || 'Unknown reader',
          at: asDate(rawDate) || utcDate(record.date), action, eventTime,
          employeeId: record.employeeId, name: record.name || record.employeeId,
        });
      }
    }
  }
  matches.sort((a, b) => (b.at?.getTime() || 0) - (a.at?.getTime() || 0));
  const recent = matches.slice(0, 500);
  const groups = new Map();
  for (const match of recent) {
    if (!groups.has(match.deviceUid)) groups.set(match.deviceUid, []);
    groups.get(match.deviceUid).push(match.score);
  }
  const scanners = [...groups.entries()].map(([deviceUid, scores]) => {
    const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const health = matchStrength(averageScore, threshold);
    return { deviceUid, scans: scores.length, averageScore: Math.round(averageScore), health, status: health >= 95 ? 'healthy' : health >= 80 ? 'attention' : 'critical' };
  }).sort((a, b) => a.health - b.health);
  const averageHealth = scanners.length ? round(scanners.reduce((sum, scanner) => sum + scanner.health, 0) / scanners.length) : 0;
  const attendanceMatches = recent.slice(0, 20).map((match) => ({
    employeeId: match.employeeId, name: match.name, action: match.action,
    eventTime: match.eventTime || null, scannedAt: match.at?.toISOString() || null,
    deviceUid: match.deviceUid, score: match.score, accepted: true, responseTimeMs: null,
    matchStrength: matchStrength(match.score, threshold),
  }));
  const names = new Map(employees.map((employee) => [employee.id, employee.name || employee.fullName || employee.id]));
  const loggedAttempts = verificationAttempts.map((attempt) => {
    const score = attempt.score == null || !Number.isFinite(Number(attempt.score)) ? null : Number(attempt.score);
    const attemptThreshold = Number(attempt.threshold) > 0 ? Number(attempt.threshold) : threshold;
    return {
      employeeId: attempt.employeeId || null,
      name: attempt.accepted ? names.get(attempt.employeeId) || attempt.employeeId || 'Recognized employee' : 'Unrecognized fingerprint',
      action: attempt.action || (attempt.accepted ? 'recognized' : 'no-match'), eventTime: attempt.eventTime || null,
      scannedAt: asDate(attempt.createdAt)?.toISOString() || null,
      deviceUid: attempt.deviceUid || 'Unknown reader', score,
      accepted: Boolean(attempt.accepted), responseTimeMs: Number(attempt.responseTimeMs) || null,
      matchStrength: score == null ? null : matchStrength(score, attemptThreshold),
    };
  }).sort((a, b) => String(b.scannedAt).localeCompare(String(a.scannedAt))).slice(0, 20);
  const recentMatches = loggedAttempts.length ? loggedAttempts : attendanceMatches;
  const counts = { TA: 0, TR: 0, FA: 0, FR: 0 };
  for (const trial of evaluationTrials) if (Object.hasOwn(counts, trial.classification)) counts[trial.classification] += 1;
  const totalTrials = counts.TA + counts.TR + counts.FA + counts.FR;
  const genuineTrials = counts.TA + counts.FR;
  const impostorTrials = evaluationTrials.filter((trial) => trial.expectedType === 'impostor');
  const impostorFalseAcceptances = impostorTrials.filter((trial) => trial.classification === 'FA').length;
  const averageResponseTimeMs = totalTrials
    ? Math.round(evaluationTrials.slice(0, totalTrials).reduce((sum, trial) => sum + Number(trial.responseTimeMs || 0), 0) / totalTrials) : 0;
  const evaluation = {
    counts, totalTrials,
    accuracy: totalTrials ? round((counts.TA + counts.TR) / totalTrials * 100) : null,
    far: impostorTrials.length ? round(impostorFalseAcceptances / impostorTrials.length * 100) : null,
    frr: genuineTrials ? round(counts.FR / genuineTrials * 100) : null,
    genuineTrialCount: evaluationTrials.filter((trial) => trial.expectedType === 'genuine').length,
    impostorTrialCount: impostorTrials.length,
    wrongIdentificationCount: evaluationTrials.filter((trial) => trial.wrongEmployeeMatch).length,
    minimumRecommendedTrials: 40,
    averageResponseTimeMs,
    recentTrials: evaluationTrials.slice(0, 20).map((trial) => ({
      id: trial.id || String(trial._id), classification: trial.classification,
      scanKind: trial.mode === 'automatic-identification' ? 'automatic' : 'controlled',
      expectedType: trial.expectedType, expectedEmployeeName: trial.expectedEmployeeName || null,
      actualEmployeeName: trial.actualEmployeeName || null, accepted: Boolean(trial.accepted),
      wrongEmployeeMatch: Boolean(trial.wrongEmployeeMatch), responseTimeMs: Number(trial.responseTimeMs || 0),
      matchStrength: trial.score == null ? null : matchStrength(Number(trial.score), Number(trial.threshold) || threshold),
      createdAt: asDate(trial.createdAt)?.toISOString() || null,
    })),
  };
  return {
    version: 'Rolling FingerJet operational health', status: recent.length ? 'ready' : 'limited', matchesAnalyzed: recent.length,
    threshold, averageHealth, scanners, recentMatches, evaluation,
    summary: recent.length ? `${averageHealth}% average scanner match quality` : 'No verified fingerprint matches recorded yet',
  };
}

export function buildAIInsights({ attendance = [], employees = [], leaveRequests = [], verificationAttempts = [], evaluationTrials = [], now = new Date(), fingerJetThreshold = 21_474 } = {}) {
  const today = isoDate(now);
  const activeEmployees = employees.filter((employee) => employee.archived !== true && employee.status !== 'inactive');
  return {
    generatedAt: now.toISOString(), today,
    forecast: forecastInsight(attendance, activeEmployees.length, today),
    risk: riskInsight(attendance, activeEmployees, leaveRequests, today),
    anomaly: anomalyInsight(attendance, activeEmployees),
    verification: verificationInsight(attendance, verificationAttempts, evaluationTrials, activeEmployees, fingerJetThreshold),
    disclaimer: 'These signals support human review. They must not be used as the sole basis for discipline, payroll decisions, or employment action.',
  };
}
