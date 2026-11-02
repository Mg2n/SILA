// SILA — data model: normalized entity collections, enums, seed scenario and consistency invariants.
// Synthetic data only. Nothing here computes triage, diagnosis or treatment.
// System-generated text (task titles, notifications, timeline entries) is stored as message codes (messages.js).

import { msg } from './messages.js';

export const SCHEMA_VERSION = 3; // 2: message codes + capacity confirmation; 3: ambulance units + structured vitals
export const PRIMARY_HOSPITAL_ID = 'h-wadi-noor';

export const COLLECTIONS = [
  'hospitals', 'roles', 'users', 'patients', 'cases', 'arrivalNotices', 'ambulanceAssignments',
  'beds', 'reservations', 'placements', 'transferRequests', 'staffingAssignments', 'tasks',
  'maintenanceTickets', 'equipmentChecks', 'comments', 'notifications', 'auditEvents',
];

// Every record carries `entity` (singular); this maps it to its collection.
export const COLLECTION_OF = {
  hospital: 'hospitals', role: 'roles', user: 'users', patient: 'patients', case: 'cases',
  arrivalNotice: 'arrivalNotices', ambulanceAssignment: 'ambulanceAssignments', bed: 'beds',
  reservation: 'reservations', placement: 'placements', transferRequest: 'transferRequests',
  staffingAssignment: 'staffingAssignments', task: 'tasks', maintenanceTicket: 'maintenanceTickets',
  equipmentCheck: 'equipmentChecks', comment: 'comments', notification: 'notifications', auditEvent: 'auditEvents',
};
export const ENTITY_OF = Object.fromEntries(Object.entries(COLLECTION_OF).map(([e, c]) => [c, e]));

export const ROLES = [
  { id: 'er_coordinator', department: 'ER', staff: true },
  { id: 'icu_coordinator', department: 'ICU', staff: true },
  { id: 'nurse', department: null, staff: true },
  { id: 'doctor', department: null, staff: true },
  { id: 'housekeeping', department: null, staff: true },
  { id: 'maintenance_tech', department: null, staff: true },
  { id: 'biomed_tech', department: null, staff: true },
  { id: 'diagnostics', department: null, staff: true },
  { id: 'porter', department: null, staff: true },
  { id: 'admin', department: null, staff: true },
  { id: 'paramedic', department: null, staff: false },
  { id: 'citizen', department: null, staff: false },
]; // display names come from i18n (role.<id>)

// Separate concepts (SPEC §7) — each has its own field or entity; availability is derived in readiness.js.
export const JOURNEY = ['expected', 'arrived', 'triage_pending', 'waiting', 'assigned', 'in_care', 'awaiting_transfer', 'departed'];
export const LOCATION_KINDS = ['pre_hospital', 'er_waiting', 'bed', 'in_transit', 'unit_arrival', 'departed', 'off_site'];
export const CLEANING_STATUS = ['not_required', 'required', 'assigned', 'in_progress', 'complete'];
export const TICKET_STATUS = ['open', 'assigned', 'in_progress', 'resolved'];
export const RESERVATION_STATUS = ['active', 'expired', 'released', 'fulfilled']; // "active" past expiresAt is read as expired
export const TRANSFER_STATUS = ['requested', 'declined', 'accepted', 'reserved', 'in_transit', 'arrived', 'completed', 'canceled'];
// 'accepted' covers clinical acceptance; capacity is confirmed when targetBedId/capacity are set (confirmCapacity).
export const ACTIVE_TRANSFER_STATUS = ['requested', 'accepted', 'reserved', 'in_transit', 'arrived'];
export const NOTICE_STATUS = ['submitted', 'acknowledged', 'en_route', 'arrived', 'handover_complete', 'canceled', 'closed'];
export const TASK_STATUS = ['open', 'accepted', 'in_progress', 'blocked', 'done', 'canceled'];
export const DIAGNOSTIC_STATUS = ['requested', 'scheduled', 'in_progress', 'report_available', 'canceled'];
export const CLOSED_TASK_STATUS = ['done', 'canceled', 'report_available'];

export const DIAGNOSTIC_TYPES = ['eeg', 'ct_head', 'chest_xray', 'ultrasound', 'echo', 'lab_panel'];

export const SLA_MINUTES = {
  cleaning: 30, nursing_verification: 30, staffing: 30, equipment_check: 60, handover: 30,
  ticket: { critical: 60, high: 120, medium: 240, low: 1440 },
};
export const RESERVATION_MINUTES = { ER: 30, ICU: 60 };

export function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

export function isOpenTask(task) {
  return !CLOSED_TASK_STATUS.includes(task.status);
}

export function isOpenTicket(ticket) {
  return ticket.status !== 'resolved';
}

export function emptyState() {
  const s = { meta: {} };
  for (const c of COLLECTIONS) s[c] = {};
  return s;
}

// Stable sequential IDs; the store always dispatches against the freshest persisted state, so counters stay unique.
export function nextId(state, prefix) {
  const counters = state.meta.counters;
  counters[prefix] = (counters[prefix] ?? 100) + 1;
  return `${prefix}-${counters[prefix]}`;
}

// Human-facing references (case SL-2041, ticket MT-511 / BM-721, transfer TR-301).
export function nextRef(state, prefix) {
  const refs = state.meta.refCounters;
  refs[prefix] = (refs[prefix] ?? 1000) + 1;
  return `${prefix}-${refs[prefix]}`;
}

export function values(state, collection) {
  return Object.values(state[collection] ?? {});
}

// ---------------------------------------------------------------------------
// Seed — SPEC §13 scenario plus one ICU patient with a step-down flag.
// All timestamps are relative to `now` so ETAs and due times stay meaningful.
// ---------------------------------------------------------------------------
export function seed(now = new Date()) {
  const T0 = new Date(now).toISOString();
  const at = (min) => addMinutes(T0, min);
  const H = PRIMARY_HOSPITAL_ID;
  const s = emptyState();
  s.meta = {
    schemaVersion: SCHEMA_VERSION,
    seededAt: T0,
    rev: 1,
    counters: {},
    refCounters: { SL: 2050, MT: 520, BM: 730, TR: 310 },
  };

  const put = (entity, rec) => {
    const created = rec.createdAt ?? at(-240);
    s[COLLECTION_OF[entity]][rec.id] = { entity, version: 1, createdAt: created, updatedAt: created, ...rec };
    return s[COLLECTION_OF[entity]][rec.id];
  };

  // Hospitals ------------------------------------------------------------------
  put('hospital', { id: H, name: 'Wadi Noor General Hospital', nameAr: 'مستشفى وادي النور العام', shortName: 'Wadi Noor', isPrimary: true,
    position: { x: 8.4, y: 6.1 }, services: ['emergency', 'adult_icu', 'stroke', 'cath_lab'],
    publicCapacity: { level: 'medium', erOpen: true, updatedAt: at(-5) } }); // live level is derived from ER beds
  put('hospital', { id: 'h-rimal', name: 'Rimal Medical Center', nameAr: 'مركز الرمال الطبي', shortName: 'Rimal', isPrimary: false,
    position: { x: 14, y: 3.5 }, services: ['emergency', 'pediatric_emergency', 'orthopedics'],
    publicCapacity: { level: 'medium', erOpen: true, updatedAt: at(-12) } });
  put('hospital', { id: 'h-qasr-bay', name: 'Qasr Bay Hospital', nameAr: 'مستشفى خليج القصر', shortName: 'Qasr Bay', isPrimary: false,
    position: { x: 3.6, y: 11.5 }, services: ['emergency', 'burns', 'adult_icu'],
    publicCapacity: { level: 'high', erOpen: true, updatedAt: at(-20) } });

  for (const r of ROLES) put('role', { ...r });

  // Users ----------------------------------------------------------------------
  const user = (id, name, role, hospitalId, department, extra = {}) =>
    put('user', { id, name, role, hospitalId, department, active: true, ...extra });
  user('u-er-coord', 'Mariam Al-Harbi', 'er_coordinator', H, 'ER');
  user('u-er-coord-2', 'Samuel Adeyemi', 'er_coordinator', H, 'ER', { note: 'Second charge nurse' });
  user('u-er-nurse-1', 'Daniel Okafor', 'nurse', H, 'ER');
  user('u-er-nurse-2', 'Huda Saleh', 'nurse', H, 'ER');
  user('u-er-doc', 'Dr. Faisal Rahman', 'doctor', H, 'ER');
  user('u-icu-coord', 'Leena Haddad', 'icu_coordinator', H, 'ICU');
  user('u-icu-nurse-1', 'Grace Mensah', 'nurse', H, 'ICU');
  user('u-icu-nurse-2', 'Omar Nasser', 'nurse', H, 'ICU');
  user('u-icu-nurse-3', 'Aisha Karim', 'nurse', H, 'ICU', { note: 'Float nurse' });
  user('u-icu-doc', 'Dr. Sara Lindqvist', 'doctor', H, 'ICU', { title: 'Intensivist' });
  user('u-housekeeping', 'Ahmed Yusuf', 'housekeeping', H, null);
  user('u-maint', 'Khalid Mansour', 'maintenance_tech', H, null);
  user('u-biomed', 'Priya Nair', 'biomed_tech', H, null);
  user('u-diag', 'Noura Fahad', 'diagnostics', H, null, { unit: 'Neurophysiology' });
  user('u-porter', 'Samir Aziz', 'porter', H, null);
  user('u-admin', 'Ravi Menon', 'admin', H, null);
  user('u-rimal-coord', 'Yara Khoury', 'er_coordinator', 'h-rimal', 'ER');
  // Two ambulance units, each with a named crew. A crew sees only cases assigned to its unit.
  user('u-para-1', 'Tariq Saeed', 'paramedic', null, null, { ambulanceId: 'WN-A12', organization: 'Regional Ambulance Service (demo)' });
  user('u-para-4', 'Hamad Al-Otaibi', 'paramedic', null, null, { ambulanceId: 'WN-A12', organization: 'Regional Ambulance Service (demo)' });
  user('u-para-2', 'Lina Farouk', 'paramedic', null, null, { ambulanceId: 'WN-A07', organization: 'Regional Ambulance Service (demo)' });
  user('u-para-3', 'Jamal Idris', 'paramedic', null, null, { ambulanceId: 'WN-A07', organization: 'Regional Ambulance Service (demo)' });
  user('u-citizen-1', 'Demo caller — Hessa', 'citizen', null, null);
  user('u-citizen-2', 'Demo caller — Yousef', 'citizen', null, null);
  // No-login citizen sessions act through this shared account; each device owns only the cases it submitted (deviceRef).
  user('u-citizen-public', 'Citizen (device session)', 'citizen', null, null, { shared: true });

  // Beds: 12 ER + 8 ICU at the primary hospital ---------------------------------
  const pad = (n) => String(n).padStart(2, '0');
  const ER_ZONE = ['Resus', 'Resus', 'Resus', 'Acute A', 'Acute A', 'Acute A', 'Acute B', 'Acute B', 'Acute B', 'Fast track', 'Isolation', 'Isolation'];
  const ER_NURSE = (i) => (i <= 6 ? 'u-er-nurse-1' : 'u-er-nurse-2');
  const ICU_NURSE = { 1: 'u-icu-nurse-1', 2: 'u-icu-nurse-1', 3: 'u-icu-nurse-1', 4: 'u-icu-nurse-1', 6: 'u-icu-nurse-2', 7: 'u-icu-nurse-2', 8: 'u-icu-nurse-2' };
  const bed = (dept, i) => {
    const id = `bed-${dept.toLowerCase()}-${pad(i)}`;
    const icu = dept === 'ICU';
    put('bed', {
      id, hospitalId: H, department: dept, label: `${dept}-${pad(i)}`,
      zone: icu ? (i <= 4 ? 'ICU North' : 'ICU South') : ER_ZONE[i - 1],
      capabilities: { monitor: true, oxygen: true, ventilator: icu || i <= 3, isolation: icu ? i >= 7 : i >= 11 },
      requiredEquipment: icu ? ['monitor', 'ventilator', 'infusion_pump'] : ['monitor'],
      occupancy: { status: 'vacant', patientId: null, since: at(-300) },
      cleaning: { status: 'complete', since: at(-290), taskId: null },
      nursingVerification: { status: 'verified', by: icu ? 'u-icu-nurse-1' : ER_NURSE(i), at: at(-280), since: at(-280) },
    });
    for (const eq of s.beds[id].requiredEquipment) {
      put('equipmentCheck', { id: `eqc-${id}-${eq}`, bedId: id, hospitalId: H, equipment: eq, result: 'passed',
        checkedBy: 'u-biomed', checkedAt: at(-600), invalidatedAt: null, invalidatedReason: null, createdAt: at(-600) });
    }
    const nurse = icu ? ICU_NURSE[i] : ER_NURSE(i);
    put('staffingAssignment', nurse
      ? { id: `staff-${id}`, bedId: id, hospitalId: H, department: dept, nurseUserId: nurse, status: 'confirmed', confirmedBy: icu ? 'u-icu-coord' : 'u-er-coord', confirmedAt: at(-240), reason: null }
      : { id: `staff-${id}`, bedId: id, hospitalId: H, department: dept, nurseUserId: null, status: 'unavailable', confirmedBy: null, confirmedAt: null,
          reason: 'Assigned nurse redeployed to cover ICU-02; replacement not yet confirmed' });
  };
  for (let i = 1; i <= 12; i++) bed('ER', i);
  for (let i = 1; i <= 8; i++) bed('ICU', i);

  // Patients and cases ---------------------------------------------------------
  const baseCase = { deviceRef: null, status: 'active', triage: null, crewAcuity: null, disposition: null, stepDown: null,
    requirements: { isolation: false, ventilator: false }, assignedCoordinatorId: null, noticeId: null,
    ambulanceAssignmentId: null, submittedBy: null, transferId: null, arrivedAt: null };
  const triage = (priority, by = 'u-er-nurse-1', min = -100) => ({ priority, by, at: at(min), source: 'staff-entered' });

  const placed = (key, alias, age, bedId, fields) => {
    const b = s.beds[bedId];
    const pid = `p-${key}`, cid = `case-${key}`;
    put('patient', { id: pid, alias, approxAge: age, location: { kind: 'bed', hospitalId: H, department: b.department, bedId, since: at(-150) } });
    put('case', { ...baseCase, id: cid, patientId: pid, source: 'walk_in', destinationHospitalId: H, department: b.department,
      journey: 'in_care', arrivedAt: at(-200), destinationHistory: [{ hospitalId: H, at: at(-200), by: null, reason: 'Initial destination' }], ...fields });
    b.occupancy = { status: 'occupied', patientId: pid, since: at(-150) };
    put('placement', { id: `pl-${key}`, patientId: pid, caseId: cid, bedId, hospitalId: H, status: 'active', startedAt: at(-150), endedAt: null, placedBy: b.department === 'ICU' ? 'u-icu-coord' : 'u-er-coord' });
  };
  placed('cedar', 'Cedar 41', 67, 'bed-er-01', { ref: 'SL-2031', journey: 'awaiting_transfer', triage: triage(2), transferId: 'tr-301',
    reportedConcern: 'Worsening shortness of breath over two days (reported)' });
  placed('juniper', 'Juniper 17', 34, 'bed-er-02', { ref: 'SL-2032', triage: triage(3), reportedConcern: 'Abdominal pain since last night (reported)' });
  placed('basil', 'Basil 08', 58, 'bed-er-03', { ref: 'SL-2033', triage: triage(2), reportedConcern: 'Palpitations and dizziness (reported)' });
  placed('willow', 'Willow 23', 45, 'bed-er-05', { ref: 'SL-2034', triage: triage(3), reportedConcern: 'Fall from ladder, wrist pain (reported)' });
  placed('sage', 'Sage 52', 71, 'bed-er-08', { ref: 'SL-2035', triage: triage(4), reportedConcern: 'Persistent cough (reported)' });
  placed('maple', 'Maple 30', 29, 'bed-er-11', { ref: 'SL-2036', triage: triage(3), requirements: { isolation: true, ventilator: false }, reportedConcern: 'Fever and rash (reported)' });
  placed('olive', 'Olive 64', 80, 'bed-er-12', { ref: 'SL-2037', triage: triage(3), requirements: { isolation: true, ventilator: false }, reportedConcern: 'Vomiting and diarrhoea (reported)' });
  placed('aspen', 'Aspen 11', 63, 'bed-icu-01', { ref: 'SL-2021', source: 'internal' });
  placed('linden', 'Linden 45', 55, 'bed-icu-02', { ref: 'SL-2022', source: 'internal',
    stepDown: { flagged: true, reason: 'Stable for 24h; ward review agreed by ICU team', by: 'u-icu-doc', at: at(-45), taskId: 'task-icu02-ward' } });
  placed('rowan', 'Rowan 26', 47, 'bed-icu-04', { ref: 'SL-2023', source: 'internal' });
  placed('spruce', 'Spruce 90', 72, 'bed-icu-07', { ref: 'SL-2024', source: 'internal', requirements: { isolation: true, ventilator: true } });
  placed('poplar', 'Poplar 33', 39, 'bed-icu-08', { ref: 'SL-2025', source: 'internal', requirements: { isolation: true, ventilator: true } });

  // Patients in the ER but not in a bed.
  put('patient', { id: 'p-fern', alias: 'Fern 19', approxAge: 52, location: { kind: 'er_waiting', hospitalId: H, department: 'ER', since: at(-6) } });
  put('case', { ...baseCase, id: 'case-fern', ref: 'SL-2038', patientId: 'p-fern', source: 'walk_in', destinationHospitalId: H, department: 'ER',
    journey: 'triage_pending', arrivedAt: at(-6), reportedConcern: 'Headache and blurred vision (reported)',
    destinationHistory: [{ hospitalId: H, at: at(-6), by: null, reason: 'Walk-in' }] });
  put('patient', { id: 'p-hazel', alias: 'Hazel 77', approxAge: 38, location: { kind: 'er_waiting', hospitalId: H, department: 'ER', since: at(-48) } });
  put('case', { ...baseCase, id: 'case-hazel', ref: 'SL-2039', patientId: 'p-hazel', source: 'walk_in', destinationHospitalId: H, department: 'ER',
    journey: 'waiting', arrivedAt: at(-48), triage: triage(3, 'u-er-nurse-2', -40), requirements: { isolation: true, ventilator: false },
    reportedConcern: 'Productive cough and fever (reported)', waitingReason: 'Needs an isolation-capable bed; both isolation bays occupied',
    destinationHistory: [{ hospitalId: H, at: at(-48), by: null, reason: 'Walk-in' }] });

  // Incoming: three ambulance cases and two citizen arrival notices --------------
  const incoming = (key, ref, alias, age, source, submittedBy, notice, extra = {}) => {
    const pid = `p-${key}`, cid = `case-${key}`, nid = `an-${key}`;
    put('patient', { id: pid, alias, approxAge: age, location: { kind: 'pre_hospital', hospitalId: null, department: null, since: notice.submittedAt } });
    put('case', { ...baseCase, id: cid, ref, patientId: pid, source, destinationHospitalId: H, department: 'ER', journey: 'expected',
      noticeId: nid, submittedBy, reportedConcern: notice.reported.concern, createdAt: notice.submittedAt,
      destinationHistory: [{ hospitalId: H, at: notice.submittedAt, by: submittedBy, reason: 'Initial destination' }], ...extra });
    put('arrivalNotice', { id: nid, caseId: cid, source, submittedBy, clientRef: `seed-${key}`, revision: 1, clinicallyVerified: false, updates: [],
      acknowledged: null, handover: null, transcript: null, extractionMethod: source === 'citizen' ? 'demo-rule-based' : 'crew-entered',
      timeline: [{ at: notice.submittedAt, by: submittedBy, event: 'submitted', detail: msg('tl.sent', { hospital: s.hospitals[H].shortName }) }],
      createdAt: notice.submittedAt, ...notice });
    if (notice.acknowledged) {
      s.arrivalNotices[nid].timeline.push({ at: notice.acknowledged.at, by: notice.acknowledged.by, event: 'acknowledged', detail: msg('tl.acknowledged') });
      s.cases[cid].assignedCoordinatorId = notice.acknowledged.by;
    }
    return s.cases[cid];
  };
  const reported = (concern, rest = {}) => ({ ageText: null, concern, onset: null, awakeBreathing: 'unknown', conditions: null,
    allergies: null, patientCount: 1, location: null, contact: null, accessibilityNeeds: null, ...rest });
  const ambulance = (key, ambulanceId, currentLocation, status) =>
    put('ambulanceAssignment', { id: `amb-${key}`, ambulanceId, crewUserIds: values(s, 'users').filter((u) => u.ambulanceId === ambulanceId).map((u) => u.id),
      caseId: `case-${key}`, destinationHospitalId: H, status, currentLocation, createdAt: at(-20) });
  // Structured readings: { id, type, value, unit, takenAt, enteredBy } — see vitals.js. No interpretation is stored.
  const vital = (key, n, type, value, unit, min, by) => ({ id: `vs-${key}-${n}`, type, value, unit, takenAt: at(min), enteredBy: by });
  const handover = (fields) => ({ crewNotes: null, interventions: [], receivingRequirements: null, history: null, allergies: null, ...fields });

  incoming('ivy', 'SL-2041', 'Ivy 05', 62, 'ambulance', 'u-para-1', {
    submittedAt: at(-18), status: 'acknowledged', etaAt: at(12), transportMode: 'ambulance',
    acknowledged: { by: 'u-er-coord', at: at(-15) },
    reported: reported('Chest pain radiating to left arm, started ~40 min before crew arrival', { ageText: 'Early 60s', onset: '~40 min before call', awakeBreathing: 'yes', location: 'Al Safa district, Street 14 (simulated)' }),
    handover: handover({ crewAcuity: { level: 'high', source: 'crew' }, history: 'Hypertension (reported by family)', allergies: 'None known',
      vitals: [vital('ivy', 1, 'HR', 108, 'bpm', -16, 'u-para-1'), vital('ivy', 2, 'BP', { systolic: 152, diastolic: 94 }, 'mmHg', -16, 'u-para-1'),
        vital('ivy', 3, 'SpO2', 95, '%', -16, 'u-para-1'), vital('ivy', 4, 'RR', 20, '/min', -16, 'u-para-1')],
      interventions: ['12-lead ECG recorded', 'Oxygen'], receivingRequirements: null }),
  }, { requirements: { isolation: false, ventilator: false, monitor: true }, crewAcuity: { level: 'high', source: 'crew' }, ambulanceAssignmentId: 'amb-ivy' });
  ambulance('ivy', 'WN-A12', 'Ring Road, exit 7 (simulated)', 'en_route');

  incoming('laurel', 'SL-2042', 'Laurel 14', 25, 'ambulance', 'u-para-2', {
    submittedAt: at(-6), status: 'submitted', etaAt: at(25), transportMode: 'ambulance',
    reported: reported('Motorcycle collision, right leg injury, conscious and talking', { ageText: 'Mid 20s', onset: '~20 min ago', awakeBreathing: 'yes', location: 'Coastal highway km 31 (simulated)' }),
    handover: handover({ crewAcuity: { level: 'moderate', source: 'crew' },
      vitals: [vital('laurel', 1, 'HR', 96, 'bpm', -7, 'u-para-2'), vital('laurel', 2, 'BP', { systolic: 128, diastolic: 80 }, 'mmHg', -7, 'u-para-2')],
      interventions: ['Splint'], receivingRequirements: 'Trauma bay; imaging likely' }),
  }, { crewAcuity: { level: 'moderate', source: 'crew' }, ambulanceAssignmentId: 'amb-laurel' });
  ambulance('laurel', 'WN-A07', 'Coastal highway km 31 (simulated)', 'en_route');

  incoming('moss', 'SL-2043', 'Moss 62', 81, 'ambulance', 'u-para-3', {
    submittedAt: at(-14), status: 'en_route', etaAt: at(8), transportMode: 'ambulance',
    acknowledged: { by: 'u-er-coord', at: at(-11) },
    reported: reported('Found on floor at home, confused, unable to stand', { ageText: 'About 80', onset: 'Unknown — found this morning', awakeBreathing: 'yes', location: 'Old town, Lane 3 (simulated)' }),
    handover: handover({ crewAcuity: { level: 'moderate', source: 'crew' }, history: 'Lives alone; daughter on the way', allergies: 'Penicillin (reported by daughter)',
      vitals: [vital('moss', 1, 'HR', 88, 'bpm', -12, 'u-para-3'), vital('moss', 2, 'Temp', 37.9, '°C', -12, 'u-para-3'), vital('moss', 3, 'glucose', 6.1, 'mmol/L', -12, 'u-para-3')],
      interventions: ['Blood glucose checked'], receivingRequirements: 'Falls assessment; family contact pending' }),
  }, { crewAcuity: { level: 'moderate', source: 'crew' }, ambulanceAssignmentId: 'amb-moss', assignedCoordinatorId: 'u-er-coord' });
  ambulance('moss', 'WN-A07', 'University bridge (simulated)', 'en_route');

  incoming('reed', 'SL-2044', 'Reed 38', 70, 'citizen', 'u-citizen-1', {
    submittedAt: at(-4), status: 'submitted', etaAt: at(15), transportMode: 'private_car',
    transcript: 'My father is about seventy, he has had a fever since this morning and now he seems confused. He is awake and breathing. He has diabetes. We are driving from Al Noor district.',
    reported: reported('Fever since this morning, now seems confused', { ageText: 'About 70', onset: 'This morning', awakeBreathing: 'yes', conditions: 'Diabetes (reported)', location: 'Al Noor district (simulated)' }),
  });
  incoming('thyme', 'SL-2045', 'Thyme 09', 6, 'citizen', 'u-citizen-2', {
    submittedAt: at(-10), status: 'acknowledged', etaAt: at(30), transportMode: 'taxi', acknowledged: { by: 'u-er-coord', at: at(-7) },
    transcript: 'My son is six. High fever and a rash since last night. He is awake. We are taking a taxi.',
    reported: reported('High fever and a rash since last night', { ageText: '6 years', onset: 'Last night', awakeBreathing: 'yes', location: 'Harbour district (simulated)', accessibilityNeeds: 'Arabic-speaking parent' }),
  });

  // The two citizen notices belong to two (simulated) phones.
  for (const [key, device] of [['reed', 'seed-device-1'], ['thyme', 'seed-device-2']]) {
    s.cases[`case-${key}`].deviceRef = device;
    s.arrivalNotices[`an-${key}`].deviceRef = device;
  }

  // ER-10 is ready and reserved for the acknowledged ambulance case.
  put('reservation', { id: 'res-er10', bedId: 'bed-er-10', caseId: 'case-ivy', patientId: 'p-ivy', hospitalId: H, department: 'ER', transferId: null,
    status: 'active', createdBy: 'u-er-coord', createdAt: at(-8), expiresAt: at(22), releasedAt: null, releaseReason: null, fulfilledAt: null });
  s.cases['case-ivy'].journey = 'expected';

  // Bed states (SPEC §13) ------------------------------------------------------
  const vacantUnverified = (bedId, since) => { s.beds[bedId].nursingVerification = { status: 'pending', by: null, at: null, since }; };
  // ER-04: vacant, awaiting cleaning.
  vacantUnverified('bed-er-04', at(-12));
  s.beds['bed-er-04'].cleaning = { status: 'required', since: at(-12), taskId: 'task-er04-clean' };
  // ER-07: monitor fault (biomedical ticket) — check invalidated.
  vacantUnverified('bed-er-07', at(-40));
  s.equipmentChecks['eqc-bed-er-07-monitor'].invalidatedAt = at(-40);
  s.equipmentChecks['eqc-bed-er-07-monitor'].invalidatedReason = msg('check.invalidatedByTicket', { ref: 'BM-721' });
  // ICU-03: cleaning complete, nursing verification pending (TR-301's suggested bed; prep starts at capacity confirmation).
  vacantUnverified('bed-icu-03', at(-60));
  s.beds['bed-icu-03'].cleaning = { status: 'complete', since: at(-25), taskId: null };
  // ICU-05: technically ready and verified, but no confirmed staffing (record created above).
  // ICU-06: awaiting technical repair.
  vacantUnverified('bed-icu-06', at(-90));

  const ticket = (rec) => put('maintenanceTicket', { linkedTransferId: null, reopenCount: 0, resolution: null, resolvedAt: null, resolvedBy: null, ...rec });
  ticket({ id: 'mt-er07-monitor', ref: 'BM-721', kind: 'equipment', bedId: 'bed-er-07', hospitalId: H, department: 'ER', category: 'Patient monitor',
    equipmentType: 'monitor', description: 'Bedside monitor screen flickers; SpO₂ module shows no reading', severity: 'high',
    status: 'assigned', assignedTo: 'u-biomed', reportedBy: 'u-er-nurse-2', reportedAt: at(-40), dueAt: at(80), createdAt: at(-40),
    history: [{ at: at(-40), by: 'u-er-nurse-2', status: 'open', note: 'Reported' }, { at: at(-30), by: 'u-biomed', status: 'assigned', note: 'Accepted' }] });
  ticket({ id: 'mt-icu06-power', ref: 'MT-511', kind: 'technical', bedId: 'bed-icu-06', hospitalId: H, department: 'ICU', category: 'Electrical',
    equipmentType: null, description: 'Headwall power outlet B tripping; circuit isolated pending repair', severity: 'high',
    status: 'in_progress', assignedTo: 'u-maint', reportedBy: 'u-icu-nurse-2', reportedAt: at(-90), dueAt: at(30), createdAt: at(-90),
    history: [{ at: at(-90), by: 'u-icu-nurse-2', status: 'open', note: 'Reported' }, { at: at(-70), by: 'u-maint', status: 'in_progress', note: 'Isolating circuit' }] });

  // Tasks ----------------------------------------------------------------------
  const task = (rec) => put('task', { linked: {}, ownerUserId: null, ownerTeam: null, priority: 'normal', dueAt: null, status: 'open',
    completionNotes: null, department: null, hospitalId: H, history: [{ at: rec.createdAt, by: null, status: rec.status ?? 'open', note: null }], ...rec });
  task({ id: 'task-er04-clean', category: 'cleaning', title: msg('taskTitle.clean', { bed: 'ER-04', why: msg('why.discharge') }), linked: { bedId: 'bed-er-04' }, requiredRole: 'housekeeping',
    ownerTeam: 'housekeeping', priority: 'high', department: 'ER', createdAt: at(-12), dueAt: at(18) });
  task({ id: 'task-er04-verify', category: 'nursing_verification', title: msg('taskTitle.verify', { bed: 'ER-04' }), linked: { bedId: 'bed-er-04' },
    requiredRole: 'nurse', ownerUserId: 'u-er-nurse-1', department: 'ER', createdAt: at(-12), dueAt: at(30) });
  task({ id: 'task-er07-verify', category: 'nursing_verification', title: msg('taskTitle.verify', { bed: 'ER-07' }), linked: { bedId: 'bed-er-07' },
    requiredRole: 'nurse', ownerUserId: 'u-er-nurse-2', department: 'ER', createdAt: at(-40), dueAt: at(90) });
  task({ id: 'task-icu01-iv', category: 'treatment', title: msg('taskTitle.ivTreatment'), linked: { patientId: 'p-aspen', caseId: 'case-aspen', bedId: 'bed-icu-01' },
    requiredRole: 'nurse', ownerUserId: 'u-icu-nurse-1', department: 'ICU', status: 'in_progress', createdAt: at(-30), dueAt: at(90) });
  task({ id: 'task-icu04-eeg', category: 'diagnostic', title: msg('taskTitle.diagnostic', { type: msg('diag.eeg') }), diagnosticType: 'eeg',
    orderedBy: 'u-icu-doc', orderReason: 'Fluctuating consciousness', reportAcknowledged: null, linked: { patientId: 'p-rowan', caseId: 'case-rowan', bedId: 'bed-icu-04' },
    requiredRole: 'diagnostics', ownerUserId: 'u-diag', department: 'ICU', status: 'report_available', createdAt: at(-300) });
  task({ id: 'task-icu04-eeg-review', category: 'report_review', title: msg('taskTitle.reportReview', { type: msg('diag.eeg') }), linked: { patientId: 'p-rowan', caseId: 'case-rowan', bedId: 'bed-icu-04', taskId: 'task-icu04-eeg' },
    requiredRole: 'doctor', ownerUserId: 'u-icu-doc', department: 'ICU', priority: 'high', createdAt: at(-35), dueAt: at(25) });
  task({ id: 'task-icu02-ward', category: 'ward_transfer', title: msg('taskTitle.wardStepDown', { alias: 'Linden 45' }), linked: { patientId: 'p-linden', caseId: 'case-linden', bedId: 'bed-icu-02' },
    requiredRole: 'icu_coordinator', department: 'ICU', createdAt: at(-45) });

  // ER-to-ICU request: clinically accepted, waiting for capacity (ICU coordinator has not confirmed a bed; ICU-03 is suggested).
  put('transferRequest', { id: 'tr-301', ref: 'TR-301', caseId: 'case-cedar', patientId: 'p-cedar', hospitalId: H, fromDepartment: 'ER', toDepartment: 'ICU',
    fromBedId: 'bed-er-01', status: 'accepted', reason: 'Escalating oxygen requirement despite ER management', requirements: { ventilator: true, isolation: false },
    requestedBy: 'u-er-doc', requestedAt: at(-75), clinicalDecision: { decision: 'accept', by: 'u-icu-doc', at: at(-50), reason: 'Meets ICU admission criteria per intensivist review' },
    targetBedId: null, capacity: null, prepItems: [], reservationId: null, porterUserId: null, handoverTaskIds: [],
    departedAt: null, departedBy: null, droppedOffAt: null, droppedOffBy: null, completedAt: null, completedBy: null, cancelReason: null, createdAt: at(-75) });

  // Clarification requested by the ER on an ambulance case (comments entity).
  put('comment', { id: 'cm-moss-1', caseId: 'case-moss', kind: 'clarification', body: 'Any anticoagulant medication mentioned by the family?',
    authorId: 'u-er-doc', status: 'open', answer: null, answeredBy: null, answeredAt: null, createdAt: at(-3) });

  // Notifications ----------------------------------------------------------------
  const note = (id, to, type, message, ref, min) => put('notification', { id, to, type, message, ref, urgent: false, readBy: [], createdAt: at(min) });
  note('n-seed-1', { role: 'er_coordinator', hospitalId: H }, 'incoming_handover', msg('notifMsg.newNotice', { source: msg('source.ambulance'), ref: 'SL-2042' }), { entity: 'case', id: 'case-laurel' }, -6);
  note('n-seed-2', { role: 'er_coordinator', hospitalId: H }, 'incoming_handover', msg('notifMsg.newNotice', { source: msg('source.citizen'), ref: 'SL-2044' }), { entity: 'case', id: 'case-reed' }, -4);
  note('n-seed-3', { userId: 'u-para-3' }, 'clarification', msg('notifMsg.clarification', { ref: 'SL-2043', question: 'Any anticoagulant medication mentioned by the family?' }), { entity: 'comment', id: 'cm-moss-1' }, -3);
  note('n-seed-4', { role: 'icu_coordinator', hospitalId: H }, 'icu_request', msg('notifMsg.acceptedNeedsCapacity', { ref: 'TR-301' }), { entity: 'transferRequest', id: 'tr-301' }, -50);
  note('n-seed-5', { role: 'housekeeping', hospitalId: H }, 'cleaning_required', msg('notifMsg.cleaningRequired', { bed: 'ER-04' }), { entity: 'bed', id: 'bed-er-04' }, -12);

  s.auditEvents['audit-seed'] = { id: 'audit-seed', entity: 'auditEvent', at: T0, actorId: null, actorName: 'System', actorRole: null,
    action: 'seed', summary: msg('audit.seed'), reason: null, refs: [], changed: [] };
  return s;
}

// ---------------------------------------------------------------------------
// Invariants — run after every dispatch; any violation rolls the action back.
// ---------------------------------------------------------------------------
export function checkInvariants(state) {
  const errors = [];
  const problem = (text) => errors.push(text); // developer diagnostics

  for (const coll of COLLECTIONS) {
    for (const [id, rec] of Object.entries(state[coll] ?? {})) {
      if (rec.id !== id) problem(`${coll}/${id}: id mismatch`);
      if (COLLECTION_OF[rec.entity] !== coll) problem(`${coll}/${id}: entity "${rec.entity}" does not belong here`);
      if (coll !== 'auditEvents' && !(Number.isInteger(rec.version) && rec.version >= 1)) problem(`${coll}/${id}: missing version`);
    }
  }

  // One physical location per patient, mirrored exactly by bed occupancy and placements.
  const bedHolders = {};
  for (const p of values(state, 'patients')) {
    const loc = p.location;
    if (!loc || !LOCATION_KINDS.includes(loc.kind)) { problem(`Patient ${p.alias}: invalid location`); continue; }
    if (loc.kind === 'bed') {
      const b = state.beds[loc.bedId];
      if (!b) problem(`Patient ${p.alias}: located in unknown bed ${loc.bedId}`);
      else if (b.occupancy.status !== 'occupied' || b.occupancy.patientId !== p.id) problem(`Patient ${p.alias}: bed ${b.label} does not show them as occupant`);
      (bedHolders[loc.bedId] ??= []).push(p.id);
    } else if (loc.bedId) {
      problem(`Patient ${p.alias}: location "${loc.kind}" must not reference a bed`);
    }
    if (loc.kind === 'in_transit') {
      const t = state.transferRequests[loc.transferId];
      if (!t || t.status !== 'in_transit' || t.patientId !== p.id) problem(`Patient ${p.alias}: in transit without an in-transit transfer`);
    }
  }
  for (const [bedId, holders] of Object.entries(bedHolders)) if (holders.length > 1) problem(`Bed ${bedId} held by ${holders.length} patients`);

  const activePlacementsByBed = {}, activePlacementsByPatient = {};
  for (const pl of values(state, 'placements')) {
    if (pl.status !== 'active') continue;
    (activePlacementsByBed[pl.bedId] ??= []).push(pl);
    (activePlacementsByPatient[pl.patientId] ??= []).push(pl);
  }
  for (const b of values(state, 'beds')) {
    const pls = activePlacementsByBed[b.id] ?? [];
    if (pls.length > 1) problem(`Bed ${b.label}: ${pls.length} active placements`);
    if (b.occupancy.status === 'occupied') {
      const p = state.patients[b.occupancy.patientId];
      if (!p || p.location.kind !== 'bed' || p.location.bedId !== b.id) problem(`Bed ${b.label}: occupant's location does not match`);
      if (pls.length !== 1 || pls[0].patientId !== b.occupancy.patientId) problem(`Bed ${b.label}: occupied without a matching active placement`);
    } else {
      if (b.occupancy.patientId) problem(`Bed ${b.label}: vacant but names an occupant`);
      if (pls.length) problem(`Bed ${b.label}: vacant with an active placement`);
    }
  }
  for (const [pid, pls] of Object.entries(activePlacementsByPatient)) if (pls.length > 1) problem(`Patient ${pid}: ${pls.length} active placements`);

  // One active reservation per bed and per case; a reserved bed is never occupied.
  const resByBed = {}, resByCase = {};
  for (const r of values(state, 'reservations')) {
    if (r.status !== 'active') continue;
    (resByBed[r.bedId] ??= []).push(r.id);
    (resByCase[r.caseId] ??= []).push(r.id);
    if (state.beds[r.bedId]?.occupancy.status === 'occupied') problem(`Reservation ${r.id}: bed is occupied`);
  }
  for (const [k, ids] of Object.entries(resByBed)) if (ids.length > 1) problem(`Bed ${k}: ${ids.length} active reservations`);
  for (const [k, ids] of Object.entries(resByCase)) if (ids.length > 1) problem(`Case ${k}: ${ids.length} active reservations`);

  // One active transfer per case.
  const trByCase = {};
  for (const t of values(state, 'transferRequests')) if (ACTIVE_TRANSFER_STATUS.includes(t.status)) (trByCase[t.caseId] ??= []).push(t.id);
  for (const [k, ids] of Object.entries(trByCase)) if (ids.length > 1) problem(`Case ${k}: ${ids.length} active transfers`);

  return errors;
}
