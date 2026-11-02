// SILA — structured vital-sign readings entered by an ambulance crew.
// A reading is { id, type, value, unit, takenAt, enteredBy }. Validation checks format and PHYSICALLY POSSIBLE
// ranges only (e.g. SpO2 cannot exceed 100 %). Nothing here interprets, flags as abnormal, or scores a value.

import { msg } from './messages.js';

// Physically possible limits — deliberately wide; they reject typing errors, not clinical findings.
export const VITAL_TYPES = {
  HR: { unit: 'bpm', min: 0, max: 350, integer: true },
  BP: { unit: 'mmHg', systolic: [0, 350], diastolic: [0, 250] },
  RR: { unit: '/min', min: 0, max: 100, integer: true },
  SpO2: { unit: '%', min: 0, max: 100, integer: true },
  Temp: { unit: '°C', min: 20, max: 46, decimals: 1 },
  GCS: { unit: '', min: 3, max: 15, integer: true },
  glucose: { unit: 'mmol/L', min: 0.1, max: 80, decimals: 1 },
};
export const VITAL_TYPE_KEYS = Object.keys(VITAL_TYPES);
const TYPE_MSG = { HR: msg('vital.HR'), BP: msg('vital.BP'), RR: msg('vital.RR'), SpO2: msg('vital.SpO2'), Temp: msg('vital.Temp'), GCS: msg('vital.GCS'), glucose: msg('vital.glucose') };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toNum = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : v);

/** Returns null when the reading is well-formed and physically possible, else a message. */
export function vitalProblem(r, now = new Date().toISOString()) {
  const def = VITAL_TYPES[r?.type];
  if (!def) return msg('err.vitalType');
  if (!r.takenAt || Number.isNaN(Date.parse(r.takenAt))) return msg('err.vitalTime', { type: TYPE_MSG[r.type] });
  if (Date.parse(r.takenAt) > Date.parse(now) + 5 * 60000) return msg('err.vitalFuture', { type: TYPE_MSG[r.type] });
  if (r.type === 'BP') {
    const s = toNum(r.value?.systolic);
    const d = toNum(r.value?.diastolic);
    if (!isNum(s) || !isNum(d) || !Number.isInteger(s) || !Number.isInteger(d)) return msg('err.vitalBpFormat');
    if (s < def.systolic[0] || s > def.systolic[1] || d < def.diastolic[0] || d > def.diastolic[1] || d >= s) {
      return msg('err.vitalBpRange', { min: def.systolic[0], max: def.systolic[1] });
    }
    return null;
  }
  const v = toNum(r.value);
  if (!isNum(v)) return msg('err.vitalNumber', { type: TYPE_MSG[r.type] });
  if (def.integer && !Number.isInteger(v)) return msg('err.vitalInteger', { type: TYPE_MSG[r.type] });
  if (v < def.min || v > def.max) return msg('err.vitalRange', { type: TYPE_MSG[r.type], value: v, min: def.min, max: def.max, unit: def.unit });
  return null;
}

/** The stored shape: exactly these keys. Id, unit and enteredBy come from the engine (never from input); no interpretation. */
export function normalizeReading(r, enteredBy, id) {
  const def = VITAL_TYPES[r.type];
  const value = r.type === 'BP'
    ? { systolic: toNum(r.value.systolic), diastolic: toNum(r.value.diastolic) }
    : (def.decimals ? Math.round(toNum(r.value) * 10) / 10 : toNum(r.value));
  return { id, type: r.type, value, unit: def.unit, takenAt: new Date(r.takenAt).toISOString(), enteredBy };
}

export function formatVitalValue(r) {
  return r.type === 'BP' ? `${r.value.systolic}/${r.value.diastolic}` : String(r.value);
}
