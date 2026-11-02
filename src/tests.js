// SILA engine test suite — shared by tests.html (browser) and run-tests-node.js.
// Covers every logic item of SPEC §16, the Task 1 extras, and at least one successful run of every action.

import { seed, checkInvariants, values, ROLES, PRIMARY_HOSPITAL_ID as H, COLLECTIONS, addMinutes } from './data.js';
import { can } from './permissions.js';
import {
  deriveBedReadiness, forecastReadyTime, incomingCases, expectedToFreeSoon, reservationState, deriveTransferStatus,
  describeLocation, latestEquipmentCheck, isCheckValid,
} from './readiness.js';
import { dispatch, memoryEngine, targetOf, preflight, nextTaskStatuses, completionActionFor, ACTION_NAMES } from './actions.js';
import { deriveErCounts, erDashboard, bedBoardStatus, commentsFor, historyFor, selectMyWork, icuDashboard, transferSteps, housekeepingQueue, biomedQueue, diagnosticsQueue, porterJobs } from './selectors.js';
import { tm, allKeys } from './i18n.js';
import { extractIntake, INTAKE_FIELDS } from './extract.js';
import { publicHospitals, rankHospitals, citizenCases, citizenCaseView, PUBLIC_HOSPITAL_FIELDS } from './selectors.js';
import { pointFromGeo, simulatedTrip } from './geo.js';
import { isMsg } from './messages.js';
import { createStore } from './store.js';
import { vitalProblem, normalizeReading, VITAL_TYPE_KEYS } from './vitals.js';
import { crewCases, crewCaseView, crewScope, auditLog } from './selectors.js';
import { notificationsFor } from './readiness.js';

const T0 = '2026-11-02T10:00:00.000Z';
const tests = [];
const test = (group, name, fn) => tests.push({ group, name, fn });
const succeeded = new Set(); // action names that ran successfully somewhere in the suite

// --- assertions -------------------------------------------------------------
class Fail extends Error {}
const assert = (cond, msg) => { if (!cond) throw new Fail(msg); };
const eq = (actual, expected, msg) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Fail(`${msg}: expected ${e}, got ${a}`);
};
const ok = (res, msg = 'expected success') => {
  if (!res.ok) throw new Fail(`${msg} — rejected (${res.code}): ${tm(res.error)}`);
  return res;
};
// Engine messages are { code, params }; assertions check the rendered English (exactly what users read).
const text = (m) => tm(m);
const rejected = (res, code, includes) => {
  if (res.ok) throw new Fail(`expected a ${code} rejection but the action succeeded`);
  if (!isMsg(res.error)) throw new Fail(`error is not a message code: ${JSON.stringify(res.error)}`);
  if (code && res.code !== code) throw new Fail(`expected ${code}, got ${res.code}: ${text(res.error)}`);
  if (includes && !text(res.error).includes(includes)) throw new Fail(`expected message to include "${includes}", got: ${text(res.error)}`);
  return res;
};

// --- harness ----------------------------------------------------------------
// Fresh seeded engine with a controllable clock. act() fills expectedVersion from the live record
// (like the UI will) and asserts the invariants after every successful action.
function setup(mutateFixture) {
  let t = Date.parse(T0);
  const now = () => new Date(t).toISOString();
  const s0 = seed(T0);
  if (mutateFixture) mutateFixture(s0); // test fixture only — application code never mutates outside dispatch
  const eng = memoryEngine(s0, now);
  const S = eng.getState;
  const act = (name, payload, user) => {
    const rec = targetOf(S(), name, payload);
    const res = dispatch(name, { ...(rec ? { expectedVersion: rec.version } : {}), ...payload }, user);
    if (res.ok) {
      succeeded.add(name);
      const problems = checkInvariants(S());
      if (problems.length) throw new Fail(`invariants broken after ${name}: ${problems.join('; ')}`);
    }
    return res;
  };
  return { S, act, now, advance: (min) => { t += min * 60000; } };
}

const ready = (S, bedId, now) => deriveBedReadiness(S().beds[bedId], S(), now());
const blockerTypes = (S, bedId, now) => ready(S, bedId, now).blockers.map((b) => b.type);
const bedsHolding = (s, pid) => values(s, 'beds').filter((b) => b.occupancy.patientId === pid).map((b) => b.id);
const latestCase = (s, pred) => values(s, 'cases').filter(pred).sort((a, b) => a.id.localeCompare(b.id)).at(-1);

// ============================================================================
// Seed (SPEC §13)
// ============================================================================
test('Seed', 'seed counts match SPEC section 13 exactly', () => {
  const s = seed(T0);
  const now = () => T0;
  const beds = values(s, 'beds').filter((b) => b.hospitalId === H);
  const R = (b) => deriveBedReadiness(b, s, T0);
  const only = (b, type) => { const t = R(b).blockers.map((x) => x.type); return t.length === 1 && t[0] === type; };
  eq(checkInvariants(s), [], 'invariants');
  eq(values(s, 'hospitals').length, 3, 'hospitals');
  eq(beds.filter((b) => b.department === 'ER').length, 12, 'primary ER beds');
  eq(beds.filter((b) => b.department === 'ICU').length, 8, 'primary ICU beds');
  for (const r of ROLES) assert(values(s, 'users').some((u) => u.role === r.id && u.active && u.name), `named demo account for role ${r.id}`);
  const journeys = new Set(values(s, 'cases').filter((c) => c.status === 'active').map((c) => c.journey));
  for (const j of ['expected', 'triage_pending', 'waiting', 'in_care', 'awaiting_transfer']) assert(journeys.has(j), `a patient in stage ${j}`);
  eq(incomingCases(s, H).filter((c) => c.source === 'ambulance').length, 3, 'incoming ambulance cases');
  eq(values(s, 'ambulanceAssignments').length, 3, 'ambulance assignments');
  eq(values(s, 'arrivalNotices').filter((n) => n.source === 'citizen').length, 2, 'citizen arrival notices');
  eq(beds.filter((b) => b.occupancy.status === 'vacant' && R(b).blockers.some((x) => x.type === 'cleaning')).length, 1, 'vacant bed awaiting cleaning');
  eq(values(s, 'maintenanceTickets').filter((t) => t.status !== 'resolved' && t.kind === 'equipment' && t.equipmentType === 'monitor').length, 1, 'bed with a monitor fault');
  eq(beds.filter((b) => b.department === 'ICU' && R(b).blockers.some((x) => x.type === 'technical_fault')).length, 1, 'ICU room awaiting technical repair');
  eq(beds.filter((b) => b.cleaning.status === 'complete' && only(b, 'nursing_verification')).length, 1, 'room cleaned, nursing verification pending');
  eq(beds.filter((b) => only(b, 'staffing')).length, 1, 'technically ready bed blocked only by staffing');
  eq(values(s, 'tasks').filter((t) => t.category === 'treatment' && t.status === 'in_progress' && t.title.code === 'taskTitle.ivTreatment').length, 1, 'IV treatment in progress');
  const eeg = values(s, 'tasks').filter((t) => t.category === 'diagnostic' && t.diagnosticType === 'eeg' && t.status === 'report_available');
  eq(eeg.length, 1, 'EEG report available');
  eq(values(s, 'tasks').filter((t) => t.category === 'report_review' && t.status === 'open' && t.linked.taskId === eeg[0].id).length, 1, 'EEG awaiting clinician review');
  const waitingCapacity = values(s, 'transferRequests').filter((t) => t.status === 'accepted' && !t.reservationId);
  eq(waitingCapacity.length, 1, 'ER-to-ICU request waiting for capacity');
  eq(text(deriveTransferStatus(waitingCapacity[0], s, T0).label), 'Waiting for capacity', 'transfer status label');
  eq(text(deriveTransferStatus(waitingCapacity[0], s, T0).reason), 'Suggested: ICU-03 — awaiting ICU coordinator confirmation', 'owner reason');
  eq(values(s, 'cases').filter((c) => c.stepDown?.flagged).length, 1, 'ICU patient with step-down flag');
  eq(deriveErCounts(s, H, now()), { incoming: 5, awaitingTriage: 1, waiting: 1, inCare: 7, availableStaffedBeds: 2, reservedBeds: 1,
    beingCleaned: 1, blockedBeds: 1, icuRequests: 1, overdueTasks: 0 }, 'ER dashboard counts derived from seed');
  for (const coll of COLLECTIONS) {
    if (coll === 'auditEvents') continue;
    for (const r of values(s, coll)) assert(Number.isInteger(r.version) && !Number.isNaN(Date.parse(r.createdAt)), `${coll}/${r.id} has version and ISO timestamp`);
  }
  eq(JSON.stringify(seed(T0)), JSON.stringify(s), 'seed is deterministic (stable IDs)');
});

// ============================================================================
// SPEC §16 acceptance logic
// ============================================================================
test('SPEC §16', "citizen submission creates a case on the correct hospital's ER board", () => {
  const { S, act } = setup();
  const before = incomingCases(S(), 'h-rimal').length;
  const res = ok(act('submitArrival', { destinationHospitalId: 'h-rimal', concern: 'Sudden weakness in right arm', transportMode: 'private_car',
    transcript: 'My mother has sudden weakness in her right arm', ageText: 'About 75', etaAt: addMinutes(T0, 20), clientRef: 'cit-device-1' }, 'u-citizen-1'));
  const c = S().cases[res.result.caseId];
  eq(c.destinationHospitalId, 'h-rimal', 'destination');
  eq(c.source, 'citizen', 'source');
  eq(incomingCases(S(), 'h-rimal').length, before + 1, 'appears on Rimal board');
  assert(!incomingCases(S(), H).some((x) => x.id === c.id), 'not on Wadi Noor board');
  const n = S().arrivalNotices[c.noticeId];
  eq([n.status, n.clinicallyVerified, n.transcript.length > 0], ['submitted', false, true], 'notice is submitted, unverified, keeps transcript');
  eq(values(S(), 'reservations').filter((r) => r.caseId === c.id).length, 0, 'citizen notice reserves no bed');
  assert(values(S(), 'notifications').some((x) => x.to.role === 'er_coordinator' && x.to.hospitalId === 'h-rimal' && x.ref.id === c.id), 'Rimal ER notified');
});

test('SPEC §16', 'ambulance updates modify the existing case without duplication', () => {
  const { S, act } = setup();
  const nCases = values(S(), 'cases').length;
  const first = ok(act('submitArrival', { destinationHospitalId: H, concern: 'Shortness of breath', crewAcuity: 'high', clientRef: 'amb-12-run-7',
    vitals: [{ type: 'SpO2', value: '89', takenAt: T0 }] }, 'u-para-1'));
  eq(values(S(), 'cases').length, nCases + 1, 'one new case');
  // Resend by clientRef (device retry) and by caseId (explicit update): still one case.
  ok(act('submitArrival', { clientRef: 'amb-12-run-7', concern: 'Shortness of breath, now drowsy', vitals: [{ type: 'SpO2', value: '87', takenAt: T0 }] }, 'u-para-1'));
  ok(act('submitArrival', { caseId: first.result.caseId, etaAt: addMinutes(T0, 9) }, 'u-para-1'));
  eq(values(S(), 'cases').length, nCases + 1, 'no duplicate case');
  eq(values(S(), 'arrivalNotices').filter((n) => n.caseId === first.result.caseId).length, 1, 'one notice');
  const n = S().arrivalNotices[S().cases[first.result.caseId].noticeId];
  eq([n.revision, n.reported.concern, n.handover.vitals.map((v) => v.value), n.etaAt], [3, 'Shortness of breath, now drowsy', [89, 87], addMinutes(T0, 9)], 'notice updated in place; readings kept over time');
  // Seeded case resent via its device clientRef.
  ok(act('submitArrival', { clientRef: 'seed-laurel', concern: 'Leg injury; pain controlled' }, 'u-para-2'));
  eq(values(S(), 'cases').length, nCases + 1, 'seeded case updated in place');
  rejected(act('submitArrival', { clientRef: 'seed-laurel', concern: 'x' }, 'u-para-1'), 'forbidden', 'original submitter');
});

test('SPEC §16', 'staff actions update connected dashboards and calculated counts', () => {
  const { S, act, now } = setup();
  const c0 = deriveErCounts(S(), H, now());
  ok(act('completeCleaning', { bedId: 'bed-er-04' }, 'u-housekeeping'));
  ok(act('verifyReadiness', { bedId: 'bed-er-04' }, 'u-er-nurse-1'));
  const c1 = deriveErCounts(S(), H, now());
  eq([c1.beingCleaned, c1.availableStaffedBeds], [c0.beingCleaned - 1, c0.availableStaffedBeds + 1], 'cleaning → available');
  ok(act('confirmArrival', { caseId: 'case-reed' }, 'u-er-nurse-1'));
  const c2 = deriveErCounts(S(), H, now());
  eq([c2.incoming, c2.awaitingTriage], [c1.incoming - 1, c1.awaitingTriage + 1], 'arrival moves incoming → awaiting triage');
  ok(act('recordTriage', { caseId: 'case-reed', priority: 3 }, 'u-er-nurse-1'));
  ok(act('reserveBed', { bedId: 'bed-er-04', caseId: 'case-reed' }, 'u-er-coord'));
  const c3 = deriveErCounts(S(), H, now());
  eq([c3.awaitingTriage, c3.waiting, c3.reservedBeds, c3.availableStaffedBeds], [c2.awaitingTriage - 1, c2.waiting + 1, c2.reservedBeds + 1, c2.availableStaffedBeds - 1], 'triage + reservation');
  ok(act('confirmPlacement', { bedId: 'bed-er-04', caseId: 'case-reed' }, 'u-er-nurse-1'));
  const c4 = deriveErCounts(S(), H, now());
  eq([c4.inCare, c4.waiting, c4.reservedBeds], [c3.inCare + 1, c3.waiting - 1, c3.reservedBeds - 1], 'placement → in care');
});

test('SPEC §16', 'a nurse cannot resolve a technical ticket', () => {
  const { S, act } = setup();
  rejected(act('resolveFault', { ticketId: 'mt-icu06-power', resolution: 'Reset breaker' }, 'u-icu-nurse-2'), 'forbidden', 'Only a maintenance technician can resolve technical faults.');
  rejected(act('resolveFault', { ticketId: 'mt-er07-monitor', resolution: 'Rebooted' }, 'u-er-nurse-2'), 'forbidden', 'Only a biomedical technician can resolve equipment tickets.');
  rejected(act('resolveFault', { ticketId: 'mt-icu06-power', resolution: 'x' }, 'u-biomed'), 'forbidden', 'maintenance technician');
  rejected(act('resolveFault', { ticketId: 'mt-er07-monitor', resolution: 'x' }, 'u-maint'), 'forbidden', 'biomedical technician');
  eq(S().maintenanceTickets['mt-icu06-power'].status, 'in_progress', 'ticket untouched');
  ok(act('reportFault', { bedId: 'bed-icu-03', kind: 'technical', description: 'Call bell not working', severity: 'medium' }, 'u-icu-nurse-1'), 'a nurse can report');
  ok(act('resolveFault', { ticketId: 'mt-icu06-power', resolution: 'Replaced outlet B; circuit tested' }, 'u-maint'), 'the maintenance technician can resolve');
});

test('SPEC §16', 'a technician cannot admit a patient or verify clinical readiness', () => {
  const { S, act } = setup();
  ok(act('confirmArrival', { caseId: 'case-reed' }, 'u-er-nurse-1'));
  for (const tech of ['u-maint', 'u-biomed']) {
    rejected(act('confirmPlacement', { bedId: 'bed-er-06', caseId: 'case-reed' }, tech), 'forbidden');
    rejected(act('reserveBed', { bedId: 'bed-er-06', caseId: 'case-reed' }, tech), 'forbidden');
    rejected(act('verifyReadiness', { bedId: 'bed-icu-03' }, tech), 'forbidden', 'Only a bedside nurse can verify nursing readiness');
    rejected(act('confirmArrival', { caseId: 'case-thyme' }, tech), 'forbidden');
  }
  eq(S().patients['p-reed'].location.kind, 'er_waiting', 'patient not admitted');
  eq(S().beds['bed-icu-03'].nursingVerification.status, 'pending', 'not verified');
});

test('SPEC §16', 'housekeeping completion does not clear maintenance blockers', () => {
  const { S, act, now } = setup();
  ok(act('reportFault', { bedId: 'bed-er-04', kind: 'technical', description: 'Bed brake stuck', severity: 'high' }, 'u-er-nurse-1'));
  ok(act('reportFault', { bedId: 'bed-er-04', kind: 'equipment', equipmentType: 'monitor', description: 'No display', severity: 'high' }, 'u-er-nurse-1'));
  ok(act('completeCleaning', { bedId: 'bed-er-04' }, 'u-housekeeping'));
  const types = blockerTypes(S, 'bed-er-04', now);
  assert(!types.includes('cleaning'), 'cleaning blocker cleared');
  for (const t of ['technical_fault', 'equipment_ticket', 'equipment_check', 'nursing_verification']) assert(types.includes(t), `${t} still blocks`);
  assert(values(S(), 'maintenanceTickets').filter((t) => t.bedId === 'bed-er-04').every((t) => t.status === 'open'), 'tickets still open');
  rejected(act('resolveFault', { ticketId: values(S(), 'maintenanceTickets').find((t) => t.bedId === 'bed-er-04').id, resolution: 'x' }, 'u-housekeeping'), 'forbidden');
  rejected(act('verifyReadiness', { bedId: 'bed-er-04' }, 'u-er-nurse-1'), 'invalid', 'cannot be verified while blockers remain');
});

test('SPEC §16', 'a bed with any unresolved readiness requirement cannot become available', () => {
  // Start from ER-06 (available) and break exactly one requirement at a time.
  const variants = {
    occupied: (s) => { s.beds['bed-er-06'].occupancy = { status: 'occupied', patientId: 'p-fern', since: T0 }; },
    cleaning: (s) => { s.beds['bed-er-06'].cleaning = { status: 'in_progress', since: T0, taskId: null }; },
    technical_fault: (s) => { s.maintenanceTickets.x = { ...s.maintenanceTickets['mt-icu06-power'], id: 'x', bedId: 'bed-er-06', department: 'ER' }; },
    equipment_ticket: (s) => { s.maintenanceTickets.y = { ...s.maintenanceTickets['mt-er07-monitor'], id: 'y', bedId: 'bed-er-06', equipmentType: 'oxygen' }; },
    equipment_check: (s) => { s.equipmentChecks['eqc-bed-er-06-monitor'].result = 'failed'; },
    staffing: (s) => { s.staffingAssignments['staff-bed-er-06'].status = 'unavailable'; },
    nursing_verification: (s) => { s.beds['bed-er-06'].nursingVerification = { status: 'pending', since: T0 }; },
    reserved: (s) => { s.reservations.r = { ...s.reservations['res-er10'], id: 'r', bedId: 'bed-er-06', caseId: 'case-reed' }; },
  };
  const base = seed(T0);
  assert(deriveBedReadiness(base.beds['bed-er-06'], base, T0).available, 'ER-06 starts available');
  for (const [type, breakIt] of Object.entries(variants)) {
    const s = seed(T0);
    breakIt(s);
    const r = deriveBedReadiness(s.beds['bed-er-06'], s, T0);
    assert(!r.available, `${type}: bed must not be available`);
    assert(r.blockers.some((b) => b.type === type && b.ownerRole && b.description), `${type}: blocker listed with owner`);
  }
  // And through the actions: reservation is refused while any blocker remains.
  const { act } = setup();
  rejected(act('reserveBed', { bedId: 'bed-er-04', caseId: 'case-fern' }, 'u-er-coord'), 'invalid', 'is not available');
  rejected(act('reserveBed', { bedId: 'bed-er-07', caseId: 'case-fern' }, 'u-er-coord'), 'invalid', 'BM-721');
});

test('SPEC §16', 'two patients cannot hold the same bed', () => {
  const { S, act } = setup();
  ok(act('reserveBed', { bedId: 'bed-er-06', caseId: 'case-fern' }, 'u-er-coord'));
  rejected(act('reserveBed', { bedId: 'bed-er-06', caseId: 'case-reed' }, 'u-er-coord'), 'invalid', 'Reserved for SL-2038 (owner');
  ok(act('confirmPlacement', { bedId: 'bed-er-06', caseId: 'case-fern' }, 'u-er-nurse-1'));
  ok(act('confirmArrival', { caseId: 'case-reed' }, 'u-er-coord'));
  rejected(act('confirmPlacement', { bedId: 'bed-er-06', caseId: 'case-reed' }, 'u-er-nurse-1'), 'invalid', 'two patients cannot hold the same bed');
  rejected(act('confirmPlacement', { bedId: 'bed-er-09', caseId: 'case-fern' }, 'u-er-nurse-1'), 'invalid', 'already in ER-06');
  eq(bedsHolding(S(), 'p-fern'), ['bed-er-06'], 'fern holds exactly one bed');
  eq(bedsHolding(S(), 'p-reed'), [], 'reed holds none');
});

test('SPEC §16', 'a discharge decision alone does not vacate a bed', () => {
  const { S, act, now } = setup();
  ok(act('recordDisposition', { caseId: 'case-juniper', decision: 'discharge', note: 'Fit for discharge' }, 'u-er-doc'));
  eq(S().beds['bed-er-02'].occupancy.patientId, 'p-juniper', 'still occupied');
  eq(S().patients['p-juniper'].location.bedId, 'bed-er-02', 'still located in ER-02');
  assert(values(S(), 'placements').some((p) => p.patientId === 'p-juniper' && p.status === 'active'), 'placement still active');
  ok(act('confirmDeparture', { caseId: 'case-juniper' }, 'u-er-nurse-1'), 'separate confirmation of physical departure');
  eq([S().beds['bed-er-02'].occupancy.status, S().beds['bed-er-02'].cleaning.status, S().patients['p-juniper'].location.kind, S().cases['case-juniper'].status],
    ['vacant', 'required', 'departed', 'closed'], 'departure vacates and requires cleaning');
  assert(blockerTypes(S, 'bed-er-02', now).includes('cleaning'), 'cleaning blocker');
  rejected(act('confirmDeparture', { caseId: 'case-basil' }, 'u-er-nurse-1'), 'invalid', 'Nothing authorises');
});

test('SPEC §16', 'a pending EEG report does not change physical bed occupancy', () => {
  const { S, act, now } = setup();
  const snap = () => JSON.stringify([S().beds['bed-icu-01'].occupancy, S().patients['p-aspen'].location, blockerTypes(S, 'bed-icu-01', now)]);
  const before = snap();
  const order = ok(act('orderDiagnostic', { patientId: 'p-aspen', type: 'eeg', reason: 'Fluctuating consciousness' }, 'u-icu-doc'));
  const eegId = order.result.taskId;
  eq([S().tasks[eegId].status, snap()], ['requested', before], 'EEG requested; occupancy unchanged');
  for (const status of ['scheduled', 'in_progress', 'report_available']) {
    ok(act('updateTaskStatus', { taskId: eegId, status }, 'u-diag'));
    eq(snap(), before, `occupancy unchanged after EEG ${status}`);
  }
  const review = values(S(), 'tasks').find((t) => t.category === 'report_review' && t.linked.taskId === eegId);
  assert(review && review.requiredRole === 'doctor' && review.ownerUserId === 'u-icu-doc', 'report availability creates a clinician review task for the ordering doctor');
  rejected(act('updateTaskStatus', { taskId: review.id, status: 'done' }, 'u-diag'), 'forbidden', 'doctor');
  rejected(act('acknowledgeReport', { taskId: eegId }, 'u-diag'), 'forbidden', 'doctors can acknowledge');
  ok(act('acknowledgeReport', { taskId: eegId, note: 'Reviewed' }, 'u-icu-doc'), 'clinician acknowledges review separately');
  eq(S().tasks[review.id].status, 'done', 'review task closed by the acknowledgment');
  ok(act('acknowledgeReport', { taskId: 'task-icu04-eeg' }, 'u-icu-doc'));
  eq(snap(), before, 'occupancy unchanged after review');
  eq(S().beds['bed-icu-04'].occupancy.patientId, 'p-rowan', 'ICU-04 still occupied');
});

test('SPEC §16', 'a canceled or redirected case releases the appropriate reservation', () => {
  const { S, act, now } = setup();
  rejected(act('cancelCase', { caseId: 'case-ivy' }, 'u-er-coord'), 'invalid', 'reason is required');
  ok(act('cancelCase', { caseId: 'case-ivy', reason: 'Crew diverted to closer facility per dispatch' }, 'u-er-coord'));
  eq([S().reservations['res-er10'].status, S().cases['case-ivy'].status, S().arrivalNotices['an-ivy'].status], ['released', 'canceled', 'canceled'], 'released + canceled');
  assert(ready(S, 'bed-er-10', now).available, 'ER-10 available again');
  // Redirect: reserve a bed for another incoming case, then change destination.
  ok(act('reserveBed', { bedId: 'bed-er-10', caseId: 'case-moss' }, 'u-er-coord'));
  ok(act('changeDestination', { caseId: 'case-moss', toHospitalId: 'h-qasr-bay', reason: 'Road closure' }, 'u-para-3'));
  const res = values(S(), 'reservations').find((r) => r.caseId === 'case-moss');
  eq(res.status, 'released', 'redirect releases reservation');
  assert(text(res.releaseReason).includes('Road closure'), 'release reason recorded');
  assert(ready(S, 'bed-er-10', now).available, 'ER-10 available after redirect');
  // An ICU reservation released by redirecting is n/a pre-arrival; ICU release reverts the transfer to accepted.
});

test('SPEC §16', 'ER-to-ICU transfer preserves one accurate physical location', () => {
  const { S, act, now } = setup();
  const P = 'p-cedar';
  const where = () => {
    const holding = bedsHolding(S(), P);
    const loc = S().patients[P].location;
    assert(holding.length <= 1, `patient in ${holding.length} beds`);
    if (loc.kind === 'bed') eq(holding, [loc.bedId], 'bed matches location'); else eq(holding, [], `no bed while ${loc.kind}`);
    return loc.kind === 'bed' ? loc.bedId : loc.kind;
  };
  eq(where(), 'bed-er-01', 'starts in ER-01');
  rejected(act('reserveBed', { bedId: 'bed-icu-03', caseId: 'case-cedar' }, 'u-icu-coord'), 'invalid', 'must confirm capacity');
  ok(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-03' }, 'u-icu-coord'));
  ok(act('verifyReadiness', { bedId: 'bed-icu-03' }, 'u-icu-nurse-1'));
  ok(act('reserveBed', { bedId: 'bed-icu-03', caseId: 'case-cedar' }, 'u-icu-coord'));
  eq(where(), 'bed-er-01', 'still in ER-01 while ICU bed reserved');
  const tr = S().transferRequests['tr-301'];
  rejected(act('confirmDeparture', { caseId: 'case-cedar' }, 'u-er-nurse-1'), 'invalid', 'Handover not complete');
  ok(act('updateTaskStatus', { taskId: tr.handoverTaskIds[0], status: 'done', note: 'SBAR given' }, 'u-er-nurse-1'));
  ok(act('updateTaskStatus', { taskId: tr.handoverTaskIds[1], status: 'done', note: 'SBAR received' }, 'u-icu-nurse-1'));
  ok(act('confirmDeparture', { caseId: 'case-cedar' }, 'u-er-nurse-1'));
  eq(where(), 'in_transit', 'in transit between departure and arrival');
  eq([S().beds['bed-er-01'].occupancy.status, S().beds['bed-er-01'].cleaning.status], ['vacant', 'required'], 'ER bed vacant + cleaning');
  assert(values(S(), 'tasks').some((t) => t.category === 'cleaning' && t.linked.bedId === 'bed-er-01' && t.status === 'open'), 'cleaning task queued');
  eq([S().beds['bed-icu-03'].occupancy.status, reservationState(S().reservations[tr.reservationId], addMinutes(now(), 600))], ['vacant', 'active'], 'ICU bed stays reserved during transport (no expiry)');
  rejected(act('releaseReservation', { reservationId: tr.reservationId, reason: 'x' }, 'u-icu-coord'), 'invalid', 'stays reserved until arrival');
  ok(act('confirmArrival', { transferId: 'tr-301' }, 'u-icu-nurse-1'));
  eq(where(), 'bed-icu-03', 'placed in ICU-03');
  eq([S().transferRequests['tr-301'].status, S().reservations[tr.reservationId].status, S().cases['case-cedar'].journey], ['completed', 'fulfilled', 'in_care'], 'transfer completed');
});

test('SPEC §16', 'unauthorized actions are rejected inside the mutation logic', () => {
  const { S, act } = setup();
  const before = S();
  const attempts = [
    ['reserveBed', { bedId: 'bed-er-06', caseId: 'case-fern' }, 'u-citizen-1'],
    ['verifyReadiness', { bedId: 'bed-icu-03' }, 'u-housekeeping'],
    ['approveTransfer', { transferId: 'tr-301', decision: 'accept' }, 'u-admin'],
    ['verifyReadiness', { bedId: 'bed-icu-03' }, 'u-admin'],
    ['confirmPlacement', { bedId: 'bed-er-06', caseId: 'case-fern' }, 'u-diag'],
    ['requestTransfer', { caseId: 'case-basil', reason: 'x' }, 'u-er-nurse-1'],
    ['acknowledgeArrival', { caseId: 'case-reed' }, 'u-rimal-coord'],
    ['completeCleaning', { bedId: 'bed-er-04' }, 'u-er-nurse-1'],
    ['verifyReadiness', { bedId: 'bed-icu-03' }, 'u-er-nurse-1'],
    ['flagStepDown', { caseId: 'case-aspen', reason: 'x' }, 'u-er-doc'],
    ['updateETA', { caseId: 'case-reed', etaAt: T0 }, 'u-citizen-2'],
    ['reserveBed', { bedId: 'bed-icu-05', caseId: 'case-cedar' }, 'u-er-coord'],
    ['submitArrival', { destinationHospitalId: H, concern: 'x' }, 'u-er-doc'],
    ['markNotificationRead', { notificationId: 'n-seed-3' }, 'u-para-1'],
    ['confirmPlacement', { bedId: 'bed-er-06', caseId: 'case-fern' }, 'no-such-user'],
  ];
  for (const [name, payload, user] of attempts) {
    const res = dispatch(name, { ...payload, expectedVersion: targetOf(S(), name, payload)?.version }, user);
    rejected(res, 'forbidden');
    assert(text(res.error).length > 15, `${name}: human-readable reason`);
  }
  assert(S() === before, 'state object untouched by rejected actions');
  eq(text(can(S().users['u-admin'], 'verifyReadiness', { hospitalId: H, department: 'ICU' }).reason),
    'Only a bedside nurse can verify nursing readiness. Technical or administrative roles cannot give clinical sign-off.', 'admin explanation');
  eq(text(can(S().users['u-rimal-coord'], 'acknowledgeArrival', { hospitalId: H }).reason), 'You can only act on records at your own hospital.', 'hospital scope');
});

// ============================================================================
// Task 1 extras
// ============================================================================
test('Task 1', "ICU prep tasks don't exist before clinical acceptance", () => {
  const { S, act } = setup();
  const taskIds = new Set(Object.keys(S().tasks));
  const req = ok(act('requestTransfer', { caseId: 'case-basil', reason: 'Needs ventilatory support', requirements: { ventilator: true } }, 'u-er-doc'));
  const trId = req.result.transferId;
  const linked = () => [...values(S(), 'tasks'), ...values(S(), 'maintenanceTickets')].filter((x) => x.linked?.transferId === trId || x.linkedTransferId === trId);
  eq(linked().length, 0, 'no work items linked to the request');
  eq(Object.keys(S().tasks).filter((id) => !taskIds.has(id)).length, 0, 'no tasks created by the request');
  eq([S().transferRequests[trId].targetBedId, S().transferRequests[trId].prepItems.length], [null, 0], 'no target bed yet');
  eq(text(deriveTransferStatus(S().transferRequests[trId], S(), T0).label), 'Pending ICU clinical review', 'pending with owner');
  rejected(act('reserveBed', { bedId: 'bed-icu-05', caseId: 'case-basil' }, 'u-icu-coord'), 'invalid', 'before the intensivist accepts');
  rejected(act('confirmStaffing', { bedId: 'bed-icu-05', nurseUserId: 'u-icu-nurse-3' }, 'u-er-coord'), 'forbidden');
  ok(act('approveTransfer', { transferId: trId, decision: 'accept', reason: 'Meets criteria' }, 'u-icu-doc'));
  // Acceptance only suggests a bed; nothing is prepared until the ICU coordinator confirms capacity (SPEC §9 step 3).
  eq([S().transferRequests[trId].targetBedId, linked().length, transferSteps(S().transferRequests[trId], S(), T0)[2].suggestedBedId],
    [null, 0, 'bed-icu-05'], 'suggestion only — most-ready compatible bed');
  ok(act('confirmCapacity', { transferId: trId, bedId: 'bed-icu-05' }, 'u-icu-coord'));
  const tr = S().transferRequests[trId];
  eq(tr.targetBedId, 'bed-icu-05', 'capacity confirmed on the suggested bed');
  assert(tr.prepItems.length > 0 && linked().length === tr.prepItems.length, 'prep items exist only after acceptance and capacity confirmation');
  const staffingTask = values(S(), 'tasks').find((t) => t.category === 'staffing' && t.linked.transferId === trId);
  assert(staffingTask && staffingTask.requiredRole === 'icu_coordinator' && staffingTask.dueAt, 'staffing prep task for ICU coordinator, with due time');
  ok(act('confirmStaffing', { bedId: 'bed-icu-05', nurseUserId: 'u-icu-nurse-3' }, 'u-icu-coord'));
  eq(S().tasks[staffingTask.id].status, 'done', 'prep task completed by the owner');
  ok(act('reserveBed', { bedId: 'bed-icu-05', caseId: 'case-basil' }, 'u-icu-coord'), 'ICU coordinator reserves once ready');
});

test('Task 1', 'citizen notice cannot create an ICU request', () => {
  const { S, act } = setup();
  const nTransfers = values(S(), 'transferRequests').length;
  rejected(act('submitArrival', { destinationHospitalId: H, concern: 'Very unwell', requestIcu: true }, 'u-citizen-1'), 'invalid', 'Only an ER doctor can request an ICU transfer');
  rejected(act('submitArrival', { destinationHospitalId: H, concern: 'Very unwell', requirements: { icu: true } }, 'u-citizen-1'), 'invalid');
  const res = ok(act('submitArrival', { destinationHospitalId: H, concern: 'Very unwell' }, 'u-citizen-1'));
  rejected(act('requestTransfer', { caseId: res.result.caseId, reason: 'Family asks for ICU' }, 'u-citizen-1'), 'forbidden', 'Only an ER doctor can request an ICU transfer.');
  rejected(act('requestTransfer', { caseId: 'case-cedar', reason: 'x' }, 'u-para-1'), 'forbidden', 'Only an ER doctor');
  rejected(act('requestTransfer', { caseId: 'case-basil', reason: 'x' }, 'u-icu-doc'), 'forbidden', 'Only an ER doctor');
  rejected(act('requestTransfer', { caseId: res.result.caseId, reason: 'x' }, 'u-er-doc'), 'invalid', 'patient who is in the ER');
  eq(values(S(), 'transferRequests').length, nTransfers, 'no transfer requests created');
  ok(act('confirmArrival', { caseId: res.result.caseId }, 'u-er-nurse-1'));
  ok(act('requestTransfer', { caseId: res.result.caseId, reason: 'Assessed by ER doctor' }, 'u-er-doc'), 'only the ER doctor, after arrival');
});

test('Task 1', 'step-down flag does not vacate the bed', () => {
  const { S, act, now } = setup();
  const before = JSON.stringify([S().beds['bed-icu-01'].occupancy, S().patients['p-aspen'].location]);
  rejected(act('flagStepDown', { caseId: 'case-aspen' }, 'u-icu-doc'), 'invalid', 'reason is required');
  rejected(act('flagStepDown', { caseId: 'case-aspen', reason: 'x' }, 'u-er-doc'), 'forbidden', 'Only an ICU doctor');
  rejected(act('flagStepDown', { caseId: 'case-basil', reason: 'x' }, 'u-icu-doc'), 'invalid', 'Only a patient in an ICU bed');
  ok(act('flagStepDown', { caseId: 'case-aspen', reason: 'Off vasopressors 24h; ward review agreed', expectedWithinMinutes: 240 }, 'u-icu-doc'));
  eq(JSON.stringify([S().beds['bed-icu-01'].occupancy, S().patients['p-aspen'].location]), before, 'occupancy and location unchanged');
  const r = ready(S, 'bed-icu-01', now);
  assert(!r.available && r.blockers[0].type === 'occupied' && text(r.blockers[0].description).includes('expected to free soon'), 'still occupied, marked expected to free soon');
  const ward = values(S(), 'tasks').find((t) => t.category === 'ward_transfer' && t.linked.caseId === 'case-aspen');
  assert(ward && ward.status === 'open', 'pending ward-transfer task');
  eq(expectedToFreeSoon(S(), H).map((b) => b.label), ['ICU-01', 'ICU-02'], 'ICU board "Expected to free soon"');
  rejected(act('updateTaskStatus', { taskId: ward.id, status: 'done' }, 'u-icu-coord'), 'invalid', 'confirmDeparture');
  ok(act('confirmDeparture', { caseId: 'case-aspen' }, 'u-icu-nurse-1'), 'only a confirmed departure frees it');
  eq([S().beds['bed-icu-01'].occupancy.status, S().tasks[ward.id].status, S().patients['p-aspen'].location.reason], ['vacant', 'done', 'step_down'], 'departed');
});

test('Task 1', 'forecast returns "Unknown" when a blocker has no due time', () => {
  const { S, act, now } = setup();
  const f = forecastReadyTime(S().beds['bed-icu-05'], S(), now());
  eq([f.estimatedReadyAt, f.isEstimate, f.blockingStep.type, f.owner.role], [null, true, 'staffing', 'icu_coordinator'], 'ICU-05 forecast');
  assert(text(f.summary).startsWith('Unknown'), `summary says Unknown: ${text(f.summary)}`);
  const g = forecastReadyTime(S().beds['bed-er-04'], S(), now());
  eq([g.estimatedReadyAt, g.isEstimate, g.owner.role], [addMinutes(T0, 30), true, 'nurse'], 'ER-04: latest due among blockers');
  assert(text(g.summary).includes('estimate'), 'labeled as an estimate');
  const icu6 = forecastReadyTime(S().beds['bed-icu-06'], S(), now());
  eq([icu6.estimatedReadyAt, icu6.blockingStep.type], [null, 'nursing_verification'], 'ICU-06: verification has no task yet → Unknown');
  ok(act('confirmStaffing', { bedId: 'bed-icu-05', nurseUserId: 'u-icu-nurse-3' }, 'u-icu-coord'));
  const h = forecastReadyTime(S().beds['bed-icu-05'], S(), now());
  eq([h.estimatedReadyAt, h.blockingStep], [now(), null], 'ready now once unblocked');
});

test('Task 1', 'a porter cannot place a patient', () => {
  const { S, act } = setup();
  ok(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-03' }, 'u-icu-coord'));
  ok(act('verifyReadiness', { bedId: 'bed-icu-03' }, 'u-icu-nurse-1'));
  ok(act('reserveBed', { bedId: 'bed-icu-03', caseId: 'case-cedar' }, 'u-icu-coord'));
  rejected(act('assignPorter', { transferId: 'tr-301', porterUserId: 'u-porter' }, 'u-porter'), 'forbidden');
  ok(act('assignPorter', { transferId: 'tr-301', porterUserId: 'u-porter' }, 'u-er-coord'));
  for (const id of S().transferRequests['tr-301'].handoverTaskIds) ok(act('updateTaskStatus', { taskId: id, status: 'done' }, S().tasks[id].department === 'ER' ? 'u-er-nurse-1' : 'u-icu-nurse-1'));
  ok(act('confirmPickup', { transferId: 'tr-301' }, 'u-porter'), 'porter confirms pickup');
  eq(S().patients['p-cedar'].location.kind, 'in_transit', 'in transit');
  ok(act('confirmDropoff', { transferId: 'tr-301' }, 'u-porter'), 'porter confirms drop-off');
  eq(S().patients['p-cedar'].location.kind, 'unit_arrival', 'arrived, awaiting placement');
  rejected(act('confirmPlacement', { bedId: 'bed-icu-03', caseId: 'case-cedar' }, 'u-porter'), 'forbidden', 'confirm physical placement');
  rejected(act('reserveBed', { bedId: 'bed-er-06', caseId: 'case-fern' }, 'u-porter'), 'forbidden');
  rejected(act('verifyReadiness', { bedId: 'bed-er-04' }, 'u-porter'), 'forbidden');
  rejected(act('confirmArrival', { transferId: 'tr-301' }, 'u-porter'), 'forbidden');
  eq(bedsHolding(S(), 'p-cedar'), [], 'porter could not place');
  ok(act('confirmPlacement', { bedId: 'bed-icu-03', caseId: 'case-cedar' }, 'u-icu-nurse-1'), 'ICU nurse places');
  eq(S().transferRequests['tr-301'].status, 'completed', 'transfer completed');
});

test('Task 1', 'a stale version is rejected with a clear message', () => {
  const { S, act } = setup();
  const seen = S().beds['bed-er-04'].version;
  ok(act('completeCleaning', { bedId: 'bed-er-04' }, 'u-housekeeping'));
  const res = rejected(dispatch('verifyReadiness', { bedId: 'bed-er-04', expectedVersion: seen }, 'u-er-nurse-1'), 'conflict');
  eq(text(res.error), `Bed ER-04 was changed by someone else since you loaded it (you had version ${seen}, it is now version ${seen + 1}). Reload and try again.`, 'message');
  rejected(dispatch('verifyReadiness', { bedId: 'bed-er-04' }, 'u-er-nurse-1'), 'invalid', 'expectedVersion is required');
  // Order of checks: permission before version, version before transition rules.
  rejected(dispatch('verifyReadiness', { bedId: 'bed-er-04', expectedVersion: seen }, 'u-maint'), 'forbidden');
  rejected(dispatch('completeCleaning', { bedId: 'bed-er-04', expectedVersion: seen }, 'u-housekeeping'), 'conflict');
  ok(act('verifyReadiness', { bedId: 'bed-er-04' }, 'u-er-nurse-1'), 'succeeds after reload');
});

test('Task 1', 'changing destination moves the case between hospital boards and releases its reservation, with the audit trail kept', () => {
  const { S, act, now } = setup();
  const auditBefore = Object.keys(S().auditEvents);
  ok(act('acknowledgeArrival', { caseId: 'case-laurel' }, 'u-er-coord'));
  assert(incomingCases(S(), H).some((c) => c.id === 'case-ivy'), 'on Wadi Noor board before');
  rejected(act('changeDestination', { caseId: 'case-ivy', toHospitalId: 'h-rimal' }, 'u-para-1'), 'invalid', 'reason is required');
  rejected(act('changeDestination', { caseId: 'case-ivy', toHospitalId: 'h-rimal', reason: 'x' }, 'u-para-2'), 'forbidden');
  ok(act('changeDestination', { caseId: 'case-ivy', toHospitalId: 'h-rimal', reason: 'Cath lab at Wadi Noor unavailable (simulated)' }, 'u-para-1'));
  assert(!incomingCases(S(), H).some((c) => c.id === 'case-ivy'), 'removed from Wadi Noor board');
  assert(incomingCases(S(), 'h-rimal').some((c) => c.id === 'case-ivy'), 'on Rimal board');
  eq(S().reservations['res-er10'].status, 'released', 'ER-10 reservation released');
  assert(ready(S, 'bed-er-10', now).available, 'ER-10 available again');
  const c = S().cases['case-ivy'];
  eq(c.destinationHistory.map((d) => d.hospitalId), [H, 'h-rimal'], 'destination history kept');
  eq([c.assignedCoordinatorId, S().arrivalNotices['an-ivy'].acknowledged], [null, null], 'acknowledgement reset for the new hospital');
  assert(S().arrivalNotices['an-ivy'].timeline.some((e) => e.event === 'destination_changed'), 'timeline entry');
  assert(auditBefore.every((id) => S().auditEvents[id]), 'no audit events removed');
  const ev = values(S(), 'auditEvents').filter((e) => e.action === 'changeDestination');
  eq(ev.length, 1, 'one audit event');
  assert(ev[0].reason.includes('Cath lab') && ev[0].changed.includes('res-er10') && ev[0].actorId === 'u-para-1', 'audit has who, why and the released reservation');
  assert(values(S(), 'notifications').some((n) => n.to.hospitalId === H && n.type === 'redirected'), 'old hospital notified');
  assert(values(S(), 'notifications').some((n) => n.to.hospitalId === 'h-rimal' && n.type === 'incoming_handover'), 'new hospital notified');
  rejected(act('acknowledgeArrival', { caseId: 'case-ivy' }, 'u-er-coord'), 'forbidden', 'own hospital');
  ok(act('acknowledgeArrival', { caseId: 'case-ivy' }, 'u-rimal-coord'), 'Rimal can acknowledge');
});

// ============================================================================
// Engine guarantees
// ============================================================================
test('Engine', 'every successful action appends exactly one audit event; rejected actions change nothing', () => {
  const { S, act } = setup();
  const count = () => values(S(), 'auditEvents').length;
  const n = count();
  ok(act('acknowledgeArrival', { caseId: 'case-reed' }, 'u-er-coord'));
  eq(count(), n + 1, 'one audit event');
  const ev = values(S(), 'auditEvents').find((e) => e.action === 'acknowledgeArrival');
  assert(ev.actorId === 'u-er-coord' && ev.actorName && ev.at && ev.summary && Array.isArray(ev.changed) && ev.followUps.length > 0, 'who/what/when + follow-ups');
  const before = S();
  rejected(act('acknowledgeArrival', { caseId: 'case-reed' }, 'u-er-coord'), 'invalid', 'already acknowledged');
  assert(S() === before && count() === n + 1, 'nothing changed');
  const v = S().cases['case-reed'].version;
  ok(act('updateETA', { caseId: 'case-reed', etaAt: addMinutes(T0, 25), enRoute: true, reason: 'Traffic' }, 'u-citizen-1'));
  eq(S().cases['case-reed'].version, v + 1, 'primary record version bumped exactly once');
});

test('Engine', 'equipment: resolving one ticket keeps the others; reopening restores the blocker', () => {
  const { S, act, now } = setup();
  ok(act('reportFault', { bedId: 'bed-er-06', kind: 'equipment', equipmentType: 'monitor', description: 'Alarm silent', severity: 'high' }, 'u-er-nurse-1'));
  ok(act('reportFault', { bedId: 'bed-er-06', kind: 'equipment', equipmentType: 'monitor', description: 'Cracked screen', severity: 'medium' }, 'u-er-nurse-1'));
  const [a, b] = values(S(), 'maintenanceTickets').filter((t) => t.bedId === 'bed-er-06');
  ok(act('updateTicketStatus', { ticketId: a.id, status: 'assigned' }, 'u-biomed'));
  rejected(act('updateTicketStatus', { ticketId: a.id, status: 'open' }, 'u-biomed'), 'invalid');
  ok(act('updateTicketStatus', { ticketId: a.id, status: 'in_progress' }, 'u-biomed'));
  rejected(act('resolveFault', { ticketId: a.id }, 'u-biomed'), 'invalid', 'Document the repair');
  ok(act('resolveFault', { ticketId: a.id, resolution: 'Alarm board replaced' }, 'u-biomed'));
  const types = blockerTypes(S, 'bed-er-06', now);
  eq([types.filter((t) => t === 'equipment_ticket').length, S().maintenanceTickets[b.id].status], [1, 'open'], 'other ticket still blocks');
  ok(act('resolveFault', { ticketId: b.id, resolution: 'Screen replaced' }, 'u-biomed'));
  ok(act('verifyReadiness', { bedId: 'bed-er-06' }, 'u-er-nurse-1'));
  assert(ready(S, 'bed-er-06', now).available, 'available after both resolved and verified');
  ok(act('reopenTicket', { ticketId: a.id, reason: 'Alarm silent again' }, 'u-er-nurse-1'));
  const after = blockerTypes(S, 'bed-er-06', now);
  for (const t of ['equipment_ticket', 'equipment_check', 'nursing_verification']) assert(after.includes(t), `reopen restores ${t}`);
  eq(S().maintenanceTickets[a.id].reopenCount, 1, 'reopen counted');
});

test('Engine', 'fault on an occupied bed keeps occupancy and raises an urgent blocker', () => {
  const { S, act, now } = setup();
  ok(act('reportFault', { bedId: 'bed-er-03', kind: 'technical', description: 'Oxygen outlet hissing', severity: 'critical' }, 'u-er-nurse-1'));
  eq(S().beds['bed-er-03'].occupancy.patientId, 'p-basil', 'patient not moved');
  assert(blockerTypes(S, 'bed-er-03', now).includes('technical_fault'), 'blocker shown');
  assert(values(S(), 'notifications').some((n) => n.type === 'urgent_blocker' && n.urgent && text(n.message).includes('never moved automatically')), 'urgent coordination notice');
});

test('Engine', 'reservations: expiry is derived, extension and release need reasons', () => {
  const { S, act, now, advance } = setup();
  rejected(act('extendReservation', { reservationId: 'res-er10', minutes: 15 }, 'u-er-coord'), 'invalid', 'reason is required');
  ok(act('extendReservation', { reservationId: 'res-er10', minutes: 15, reason: 'Ambulance delayed' }, 'u-er-coord'));
  eq(S().reservations['res-er10'].expiresAt, addMinutes(T0, 37), 'extended');
  advance(40);
  eq(reservationState(S().reservations['res-er10'], now()), 'expired', 'derived expiry');
  assert(ready(S, 'bed-er-10', now).available, 'expired reservation no longer blocks');
  rejected(act('extendReservation', { reservationId: 'res-er10', minutes: 5, reason: 'x' }, 'u-er-coord'), 'invalid', 'expired');
  ok(act('reserveBed', { bedId: 'bed-er-10', caseId: 'case-ivy', minutes: 20 }, 'u-er-coord'), 're-reserve after expiry');
  eq(S().reservations['res-er10'].status, 'expired', 'stale reservation closed as expired');
  const fresh = values(S(), 'reservations').find((r) => r.caseId === 'case-ivy' && r.status === 'active');
  rejected(act('releaseReservation', { reservationId: fresh.id }, 'u-er-coord'), 'invalid', 'reason is required');
  ok(act('releaseReservation', { reservationId: fresh.id, reason: 'Patient diverted' }, 'u-er-coord'));
  eq(S().reservations[fresh.id].status, 'released', 'released');
});

test('Engine', 'ICU release reverts the transfer and cancels handover tasks', () => {
  const { S, act } = setup();
  ok(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-03' }, 'u-icu-coord'));
  ok(act('verifyReadiness', { bedId: 'bed-icu-03' }, 'u-icu-nurse-1'));
  ok(act('reserveBed', { bedId: 'bed-icu-03', caseId: 'case-cedar' }, 'u-icu-coord'));
  const tr = S().transferRequests['tr-301'];
  ok(act('releaseReservation', { reservationId: tr.reservationId, reason: 'Bed needed for resuscitation' }, 'u-icu-coord'));
  eq(S().transferRequests['tr-301'].status, 'accepted', 'back to waiting for a bed');
  assert(tr.handoverTaskIds.every((id) => S().tasks[id].status === 'canceled'), 'handover tasks canceled');
});

test('Engine', 'ICU step-down departure frees a bed that becomes the suggestion for the oldest waiting request', () => {
  const { S, act, now } = setup();
  // Maple (ER-11) needs isolation; both ICU isolation rooms are occupied, so there is no capacity.
  const r = ok(act('requestTransfer', { caseId: 'case-maple', reason: 'Deteriorating; needs ICU isolation', requirements: { isolation: true, ventilator: true } }, 'u-er-doc'));
  const trId = r.result.transferId;
  ok(act('approveTransfer', { transferId: trId, decision: 'accept' }, 'u-icu-doc'));
  const st = () => deriveTransferStatus(S().transferRequests[trId], S(), now());
  eq([text(st().label), text(st().reason), st().ownerRole], ['Waiting for capacity', 'No compatible vacant ICU bed', 'icu_coordinator'], 'waiting with owner and reason');
  rejected(act('confirmCapacity', { transferId: trId, bedId: 'bed-icu-03' }, 'u-icu-coord'), 'invalid', 'cannot meet this patient’s requirements (isolation)');
  ok(act('flagStepDown', { caseId: 'case-poplar', reason: 'Weaned; ward review agreed' }, 'u-icu-doc'));
  eq(st().suggestedBedId, null, 'a step-down flag alone frees nothing');
  ok(act('confirmDeparture', { caseId: 'case-poplar' }, 'u-icu-coord'));
  eq([st().suggestedBedId, S().transferRequests[trId].targetBedId], ['bed-icu-08', null], 'freed isolation room suggested, not yet confirmed');
  assert(values(S(), 'notifications').some((n) => n.type === 'bed_suggested' && n.ref.id === trId), 'ICU coordinator told about the suggestion');
  assert(!isCheckValid(latestEquipmentCheck(S(), 'bed-icu-08', 'ventilator')), 'ICU turnover invalidates the ventilator check');
  ok(act('confirmCapacity', { transferId: trId, bedId: 'bed-icu-08' }, 'u-icu-coord'));
  const prepCats = S().transferRequests[trId].prepItems.map((i) => S().tasks[i.id]?.category);
  for (const c of ['cleaning', 'equipment_check', 'nursing_verification']) assert(prepCats.includes(c), `${c} prep work for the confirmed bed`);
});

test('Engine', 'declined ICU request keeps the patient in the ER', () => {
  const { S, act } = setup();
  const r = ok(act('requestTransfer', { caseId: 'case-sage', reason: 'Hypoxia' }, 'u-er-doc'));
  rejected(act('approveTransfer', { transferId: r.result.transferId, decision: 'decline' }, 'u-icu-doc'), 'invalid', 'reason is required');
  ok(act('approveTransfer', { transferId: r.result.transferId, decision: 'decline', reason: 'Manage on ward with outreach review' }, 'u-icu-doc'));
  eq([S().transferRequests[r.result.transferId].status, S().patients['p-sage'].location.bedId], ['declined', 'bed-er-08'], 'declined, still in ER-08');
});

// ============================================================================
// Remaining actions
// ============================================================================
test('Actions', 'clarification request and response stay inside the case', () => {
  const { S, act } = setup();
  rejected(act('respondClarification', { commentId: 'cm-moss-1', answer: 'Yes' }, 'u-para-1'), 'forbidden');
  ok(act('respondClarification', { commentId: 'cm-moss-1', answer: 'Daughter reports apixaban twice daily' }, 'u-para-3'));
  eq(S().comments['cm-moss-1'].status, 'answered', 'answered');
  rejected(act('respondClarification', { commentId: 'cm-moss-1', answer: 'again' }, 'u-para-3'), 'invalid', 'already answered');
  const r = ok(act('requestClarification', { caseId: 'case-laurel', question: 'Helmet worn?' }, 'u-er-nurse-1'));
  assert(values(S(), 'notifications').some((n) => n.to.userId === 'u-para-2' && n.ref.id === r.result.commentId), 'crew notified');
  rejected(act('requestClarification', { caseId: 'case-laurel', question: ' ' }, 'u-er-nurse-1'), 'invalid');
});

test('Actions', 'ambulance arrival → triage → handover complete', () => {
  const { S, act } = setup();
  ok(act('confirmArrival', { caseId: 'case-laurel' }, 'u-para-2'), 'crew can confirm arrival at the door');
  eq([S().patients['p-laurel'].location.kind, S().cases['case-laurel'].journey, S().arrivalNotices['an-laurel'].status], ['er_waiting', 'triage_pending', 'arrived'], 'arrived, not in a bed');
  rejected(act('recordTriage', { caseId: 'case-laurel', priority: 9 }, 'u-er-nurse-1'), 'invalid', '1–5');
  ok(act('recordTriage', { caseId: 'case-laurel', priority: 2, note: 'Staff-assessed' }, 'u-er-nurse-1'));
  eq(S().cases['case-laurel'].triage.source, 'staff-entered', 'triage source');
  const t = values(S(), 'tasks').find((x) => x.category === 'ambulance_handover' && x.linked.caseId === 'case-laurel');
  ok(act('updateTaskStatus', { taskId: t.id, status: 'done', note: 'Handover received' }, 'u-er-nurse-2'));
  eq([S().arrivalNotices['an-laurel'].status, S().ambulanceAssignments['amb-laurel'].status], ['handover_complete', 'handover_complete'], 'handover complete');
});

test('Actions', 'cleaning task accept/start/blocked mirrors the bed and needs a reason to block', () => {
  const { S, act } = setup();
  ok(act('updateTaskStatus', { taskId: 'task-er04-clean', status: 'accepted' }, 'u-housekeeping'));
  eq([S().beds['bed-er-04'].cleaning.status, S().tasks['task-er04-clean'].ownerUserId], ['assigned', 'u-housekeeping'], 'assigned');
  rejected(act('updateTaskStatus', { taskId: 'task-er04-clean', status: 'blocked' }, 'u-housekeeping'), 'invalid', 'Describe the blocker');
  ok(act('updateTaskStatus', { taskId: 'task-er04-clean', status: 'blocked', note: 'Out of disinfectant wipes' }, 'u-housekeeping'));
  ok(act('updateTaskStatus', { taskId: 'task-er04-clean', status: 'in_progress' }, 'u-housekeeping'));
  eq(S().beds['bed-er-04'].cleaning.status, 'in_progress', 'in progress');
  rejected(act('updateTaskStatus', { taskId: 'task-er04-clean', status: 'done' }, 'u-housekeeping'), 'invalid', 'completeCleaning');
  ok(act('completeCleaning', { bedId: 'bed-er-04', note: 'Terminal clean' }, 'u-housekeeping'));
  rejected(act('completeCleaning', { bedId: 'bed-er-04' }, 'u-housekeeping'), 'invalid', 'No cleaning is pending');
});

test('Actions', 'equipment checks and staffing confirmation', () => {
  const { S, act, now } = setup();
  rejected(act('recordEquipmentCheck', { bedId: 'bed-er-07', equipment: 'monitor', result: 'passed' }, 'u-biomed'), 'invalid', 'Resolve BM-721');
  rejected(act('recordEquipmentCheck', { bedId: 'bed-icu-05', equipment: 'monitor', result: 'passed' }, 'u-icu-nurse-1'), 'forbidden', 'Only a biomedical technician');
  rejected(act('recordEquipmentCheck', { bedId: 'bed-icu-05', equipment: 'ventilator', result: 'failed' }, 'u-biomed'), 'invalid', 'why the check failed');
  ok(act('recordEquipmentCheck', { bedId: 'bed-icu-05', equipment: 'ventilator', result: 'failed', note: 'Leak test failed' }, 'u-biomed'));
  assert(blockerTypes(S, 'bed-icu-05', now).includes('equipment_check'), 'failed check blocks');
  ok(act('recordEquipmentCheck', { bedId: 'bed-icu-05', equipment: 'ventilator', result: 'passed', note: 'Circuit replaced' }, 'u-biomed'));
  rejected(act('confirmStaffing', { bedId: 'bed-icu-05', nurseUserId: 'u-er-nurse-1' }, 'u-icu-coord'), 'invalid', 'not a ICU nurse');
  ok(act('confirmStaffing', { bedId: 'bed-icu-05', nurseUserId: 'u-icu-nurse-3' }, 'u-icu-coord'));
  eq(blockerTypes(S, 'bed-icu-05', now), ['nursing_verification'], 'failed check reset verification');
  ok(act('verifyReadiness', { bedId: 'bed-icu-05' }, 'u-icu-nurse-3'));
  assert(ready(S, 'bed-icu-05', now).available, 'ICU-05 available');
});

test('Actions', 'notifications are read only by their recipients', () => {
  const { S, act } = setup();
  rejected(act('markNotificationRead', { notificationId: 'n-seed-1' }, 'u-icu-coord'), 'forbidden');
  ok(act('markNotificationRead', { notificationId: 'n-seed-1' }, 'u-er-coord'));
  eq(S().notifications['n-seed-1'].readBy, ['u-er-coord'], 'read');
  rejected(act('markNotificationRead', { notificationId: 'n-seed-1' }, 'u-er-coord'), 'invalid', 'Already');
});

test('Actions', 'admission to ward: decision then confirmed departure', () => {
  const { S, act } = setup();
  rejected(act('recordDisposition', { caseId: 'case-willow', decision: 'admit_ward' }, 'u-icu-doc'), 'forbidden');
  ok(act('recordDisposition', { caseId: 'case-willow', decision: 'admit_ward' }, 'u-er-doc'));
  eq(S().beds['bed-er-05'].occupancy.patientId, 'p-willow', 'still in bed');
  ok(act('confirmDeparture', { caseId: 'case-willow' }, 'u-er-coord'));
  eq([S().patients['p-willow'].location.reason, text(describeLocation(S(), S().patients['p-willow']))], ['admit_ward', 'Departed (admitted to ward)'], 'departed to ward');
});

// ============================================================================
// Store: persistence, sync, reset
// ============================================================================
const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const testStorage = () => {
  try {
    const ls = globalThis.localStorage;
    ls.setItem('__sila_probe__', '1');
    if (ls.getItem('__sila_probe__') === '1') { ls.removeItem('__sila_probe__'); return ls; }
  } catch { /* unavailable or blocked */ }
  return memStorage();
};
const uniq = (p) => `${p}-${Math.random().toString(36).slice(2)}`;
const waitFor = (pred, ms = 2000) => new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => (pred() ? resolve() : Date.now() - start > ms ? reject(new Fail('timed out waiting for sync')) : setTimeout(tick, 10));
  tick();
});

test('Store', 'refresh restores demo state', () => {
  const storage = testStorage();
  const key = uniq('sila.test');
  const opened = [];
  const open = () => { const st = createStore({ key, storage, channelName: uniq('ch') }); opened.push(st); return st; };
  try {
    const a = open();
    const v = a.getState().beds['bed-er-04'].version;
    ok(a.dispatch('completeCleaning', { bedId: 'bed-er-04', expectedVersion: v }, 'u-housekeeping'));
    a.close();
    const b = open(); // a "reload"
    eq([b.getState().beds['bed-er-04'].cleaning.status, b.getState().meta.rev], ['complete', a.getState().meta.rev], 'restored from storage');
    assert(Object.isFrozen(b.getState().beds['bed-er-04']), 'state handed to the UI is read-only');
    storage.setItem(key, '{not json');
    const c = open();
    eq(checkInvariants(c.getState()), [], 'corrupt storage falls back to a fresh seed');
  } finally {
    opened.forEach((st) => st.close());
    storage.removeItem(key);
  }
});

test('Store', 'open tabs receive updates (BroadcastChannel)', async () => {
  if (typeof BroadcastChannel !== 'function') throw new Fail('BroadcastChannel not available in this runtime');
  const storage = memStorage(); // separate per-"tab" memory is not needed: messages carry the state
  const key = uniq('sila.test'), channelName = uniq('sila-ch');
  const a = createStore({ key, storage, channelName });
  const b = createStore({ key, storage: memStorage(), channelName });
  try {
    const seen = [];
    b.subscribe((s, info) => seen.push(info.source));
    const v = a.getState().cases['case-reed'].version;
    ok(a.dispatch('acknowledgeArrival', { caseId: 'case-reed', expectedVersion: v }, 'u-er-coord'));
    await waitFor(() => seen.includes('broadcast'));
    eq(b.getState().cases['case-reed'].assignedCoordinatorId, 'u-er-coord', 'other tab sees the change');
    eq(b.getState().meta.rev, a.getState().meta.rev, 'same revision');
  } finally {
    a.close(); b.close();
  }
});

test('Store', 'storage-event fallback syncs when BroadcastChannel is unavailable', () => {
  const storage = memStorage();
  const key = uniq('sila.test');
  const target = new EventTarget();
  const a = createStore({ key, storage, BroadcastChannelImpl: null, eventTarget: null });
  const b = createStore({ key, storage, BroadcastChannelImpl: null, eventTarget: target });
  let notified = 0;
  b.subscribe(() => { notified += 1; });
  ok(a.dispatch('completeCleaning', { bedId: 'bed-er-04', expectedVersion: a.getState().beds['bed-er-04'].version }, 'u-housekeeping'));
  target.dispatchEvent(Object.assign(new Event('storage'), { key }));
  eq([notified, b.getState().beds['bed-er-04'].cleaning.status], [1, 'complete'], 'adopted from the storage event');
  // A stale tab dispatching re-reads storage first, so it cannot overwrite newer state.
  const stale = createStore({ key, storage, BroadcastChannelImpl: null, eventTarget: null });
  ok(a.dispatch('verifyReadiness', { bedId: 'bed-er-04', expectedVersion: a.getState().beds['bed-er-04'].version }, 'u-er-nurse-1'));
  rejected(stale.dispatch('completeCleaning', { bedId: 'bed-er-04', expectedVersion: stale.getState().beds['bed-er-04'].version }, 'u-housekeeping'), 'conflict');
  a.close(); b.close(); stale.close();
});

test('Store', 'reset restores a consistent dataset', () => {
  const storage = memStorage();
  const s = createStore({ key: uniq('sila.test'), storage, BroadcastChannelImpl: null, eventTarget: null });
  ok(s.dispatch('completeCleaning', { bedId: 'bed-er-04', expectedVersion: s.getState().beds['bed-er-04'].version }, 'u-housekeeping'));
  const epoch = s.getState().meta.epoch;
  let notified = false;
  s.subscribe(() => { notified = true; });
  s.resetDemo();
  const st = s.getState();
  eq([checkInvariants(st), st.beds['bed-er-04'].cleaning.status, st.meta.rev, values(st, 'auditEvents').length], [[], 'required', 1, 1], 'seeded again');
  assert(notified && st.meta.epoch !== epoch, 'subscribers notified; new epoch so other tabs adopt it');
  eq(deriveErCounts(st, H, st.meta.seededAt), deriveErCounts(seed(st.meta.seededAt), H, st.meta.seededAt), 'counts match a fresh seed');
  s.close();
});

// ============================================================================
// Task 2 engine additions
// ============================================================================
test('Task 2', 'selectors: every ER dashboard count matches the seed', () => {
  const s = seed(T0);
  const d = erDashboard(s, H, T0);
  const expected = {
    incoming: ['case-moss', 'case-ivy', 'case-reed', 'case-laurel', 'case-thyme'], // sorted by ETA
    awaitingTriage: ['case-fern'], waiting: ['case-hazel'],
    inCare: ['bed-er-01', 'bed-er-02', 'bed-er-03', 'bed-er-05', 'bed-er-08', 'bed-er-11', 'bed-er-12'],
    available: ['bed-er-06', 'bed-er-09'], reserved: ['bed-er-10'], beingCleaned: ['bed-er-04'],
    blockedMaintenance: [], blockedEquipment: ['bed-er-07'], blockedStaffing: [], icuRequests: ['tr-301'], overdueTasks: [],
  };
  for (const [key, ids] of Object.entries(expected)) {
    eq(d[key].ids, ids, `${key} ids`);
    eq(d[key].count, ids.length, `${key} count`);
  }
  eq(Object.keys(d), Object.keys(expected), 'one selector per SPEC §8 tile');
  const later = addMinutes(T0, 100);
  eq(erDashboard(s, H, later).overdueTasks.ids, ['task-er04-clean', 'task-er04-verify', 'mt-er07-monitor', 'task-er07-verify'], 'overdue tasks and tickets after 100 min');
});

test('Task 2', 'addComment: staff at that hospital can comment; author, timestamp and timeline kept', () => {
  const { S, act, now } = setup();
  const v = S().beds['bed-er-04'].version;
  const r = ok(act('addComment', { targetType: 'bed', targetId: 'bed-er-04', text: '  Mattress cover torn — replacement requested  ' }, 'u-housekeeping'));
  const cm = S().comments[r.result.commentId];
  eq([cm.authorId, cm.body, cm.createdAt, cm.targetType, cm.targetId], ['u-housekeeping', 'Mattress cover torn — replacement requested', now(), 'bed', 'bed-er-04'], 'comment record');
  eq(S().beds['bed-er-04'].version, v, 'commenting does not bump the bed version');
  eq(commentsFor(S(), 'bed', 'bed-er-04').map((c) => c.id), [cm.id], 'listed for the bed');
  assert(historyFor(S(), 'bed', 'bed-er-04').some((e) => e.action === 'addComment' && e.actorId === 'u-housekeeping'), 'in the bed timeline');
  ok(act('addComment', { targetType: 'case', targetId: 'case-reed', text: 'Family called: arriving in 10 min' }, 'u-er-doc'));
  ok(act('addComment', { targetType: 'task', targetId: 'task-er04-clean', text: 'Starting after ER-02' }, 'u-housekeeping'));
  ok(act('addComment', { targetType: 'maintenanceTicket', targetId: 'mt-er07-monitor', text: 'Spare module on order' }, 'u-biomed'));
  eq(commentsFor(S(), 'case', 'case-moss').length, 1, 'case thread includes clarifications');
  rejected(act('addComment', { targetType: 'bed', targetId: 'bed-er-04', text: 'x' }, 'u-rimal-coord'), 'forbidden', 'own hospital');
  rejected(act('addComment', { targetType: 'case', targetId: 'case-reed', text: 'x' }, 'u-citizen-1'), 'forbidden', 'Only hospital staff');
  rejected(act('addComment', { targetType: 'bed', targetId: 'bed-er-04', text: '   ' }, 'u-er-nurse-1'), 'invalid', 'Write a comment');
  rejected(act('addComment', { targetType: 'bed', targetId: 'bed-er-04', text: 'x'.repeat(501) }, 'u-er-nurse-1'), 'invalid', '500');
  rejected(act('addComment', { targetType: 'bed', targetId: 'nope', text: 'x' }, 'u-er-nurse-1'), 'not_found');
  eq(targetOf(S(), 'addComment', { targetType: 'bed', targetId: 'bed-er-04' }), null, 'no expectedVersion needed');
});

test('Task 2', 'reportStaffingGap creates a blocker and a notification', () => {
  const { S, act, now } = setup();
  assert(ready(S, 'bed-er-06', now).available, 'ER-06 starts available');
  rejected(act('reportStaffingGap', { bedId: 'bed-er-06', reason: 'x' }, 'u-er-nurse-1'), 'forbidden', 'coordinator');
  rejected(act('reportStaffingGap', { bedId: 'bed-er-06', reason: 'x' }, 'u-icu-coord'), 'forbidden');
  rejected(act('reportStaffingGap', { bedId: 'bed-er-06' }, 'u-er-coord'), 'invalid', 'reason is required');
  ok(act('reportStaffingGap', { bedId: 'bed-er-06', reason: 'Daniel called to resus; no float nurse' }, 'u-er-coord'));
  const r = ready(S, 'bed-er-06', now);
  const staffing = r.blockers.find((b) => b.type === 'staffing');
  assert(!r.available && staffing && text(staffing.description).includes('no float nurse') && staffing.ownerRole === 'er_coordinator', 'staffing blocker with reason and owner');
  assert(values(S(), 'notifications').some((n) => n.type === 'staffing_gap' && n.to.role === 'er_coordinator' && n.ref.id === 'bed-er-06'), 'coordinators notified');
  assert(values(S(), 'notifications').some((n) => n.type === 'staffing_gap' && n.to.userId === 'u-er-nurse-1'), 'previous nurse notified');
  const task = values(S(), 'tasks').find((t) => t.category === 'staffing' && t.linked.bedId === 'bed-er-06');
  assert(task && task.requiredRole === 'er_coordinator' && task.dueAt, 'coordinator task with a due time');
  eq(forecastReadyTime(S().beds['bed-er-06'], S(), now()).estimatedReadyAt, task.dueAt, 'forecast uses the task due time');
  rejected(act('reportStaffingGap', { bedId: 'bed-er-06', reason: 'again' }, 'u-er-coord'), 'invalid', 'already marked unavailable');
  ok(act('confirmStaffing', { bedId: 'bed-er-06', nurseUserId: 'u-er-nurse-2' }, 'u-er-coord'));
  assert(ready(S, 'bed-er-06', now).available && S().tasks[task.id].status === 'done', 'cover confirmed: available again, task done');
  ok(act('reportStaffingGap', { bedId: 'bed-er-03', reason: 'Sickness' }, 'u-er-coord'));
  assert(values(S(), 'notifications').some((n) => n.type === 'staffing_gap' && n.urgent && n.ref.id === 'bed-er-03'), 'urgent on an occupied bed');
  eq(bedBoardStatus(S().beds['bed-er-03'], S(), now()).urgent, true, 'occupied bed flagged urgent on the board');
});

test('Task 2', 'assignCoordinator reassigns a case to another ER coordinator', () => {
  const { S, act } = setup();
  rejected(act('assignCoordinator', { caseId: 'case-moss', coordinatorId: 'u-er-coord-2' }, 'u-er-nurse-1'), 'forbidden', 'Only an ER coordinator');
  rejected(act('assignCoordinator', { caseId: 'case-moss', coordinatorId: 'u-er-coord' }, 'u-er-coord'), 'invalid', 'already the coordinator');
  rejected(act('assignCoordinator', { caseId: 'case-moss', coordinatorId: 'u-rimal-coord' }, 'u-er-coord'), 'invalid', 'at this hospital');
  ok(act('assignCoordinator', { caseId: 'case-moss', coordinatorId: 'u-er-coord-2' }, 'u-er-coord'));
  eq(S().cases['case-moss'].assignedCoordinatorId, 'u-er-coord-2', 'reassigned');
  assert(values(S(), 'notifications').some((n) => n.to.userId === 'u-er-coord-2' && n.type === 'assigned'), 'new coordinator notified');
});

test('Task 2', 'preflight gives the same verdict and reason as dispatch, without changing state', () => {
  const { S, act, now } = setup();
  const before = S();
  const pf = preflight(S(), 'verifyReadiness', { bedId: 'bed-er-04' }, 'u-maint', now());
  const d = dispatch('verifyReadiness', { bedId: 'bed-er-04', expectedVersion: S().beds['bed-er-04'].version }, 'u-maint');
  eq([pf.ok, pf.code, pf.reason], [false, d.code, d.error], 'forbidden reason matches');
  const pf2 = preflight(S(), 'verifyReadiness', { bedId: 'bed-er-04' }, 'u-er-nurse-1', now());
  const d2 = dispatch('verifyReadiness', { bedId: 'bed-er-04', expectedVersion: S().beds['bed-er-04'].version }, 'u-er-nurse-1');
  eq([pf2.code, pf2.reason], [d2.code, d2.error], 'transition reason matches');
  eq(preflight(S(), 'completeCleaning', { bedId: 'bed-er-04' }, 'u-housekeeping', now()).ok, true, 'allowed');
  assert(S() === before, 'preflight never changes state');
  eq(preflight(S(), 'cancelCase', { caseId: 'case-reed' }, 'u-er-coord', now()).code, 'invalid', 'reason missing');
  eq(preflight(S(), 'cancelCase', { caseId: 'case-reed' }, 'u-er-coord', now(), { permissionOnly: true }).ok, true, 'permission only');
  eq(text(preflight(S(), 'resolveFault', { ticketId: 'mt-er07-monitor' }, 'u-er-nurse-2', now(), { permissionOnly: true }).reason),
    'Only a biomedical technician can resolve equipment tickets.', 'nurse sees why');
  ok(act('completeCleaning', { bedId: 'bed-er-04' }, 'u-housekeeping'));
  eq(nextTaskStatuses(S().tasks['task-icu01-iv']), ['done', 'blocked'], 'treatment in progress → done/blocked');
  eq([nextTaskStatuses(S().tasks['task-er04-verify']), completionActionFor(S().tasks['task-er04-verify'])], [['accepted'], 'verifyReadiness'], 'verification completes via verifyReadiness');
  eq(completionActionFor(S().tasks['task-icu01-iv']), null, 'treatment completes via status');
});

test('Task 2', 'patient details are visible only to clinical and transport staff at the same hospital', () => {
  const s = seed(T0);
  const scope = { hospitalId: H };
  for (const id of ['u-er-coord', 'u-er-nurse-1', 'u-er-doc', 'u-icu-doc', 'u-diag', 'u-porter']) assert(can(s.users[id], 'viewPatientDetails', scope).allowed, `${id} can see`);
  for (const id of ['u-housekeeping', 'u-maint', 'u-biomed', 'u-admin', 'u-citizen-1']) {
    eq(text(can(s.users[id], 'viewPatientDetails', scope).reason), 'Patient details are limited to clinical and transport staff.', `${id} cannot see`);
  }
  eq(can(s.users['u-rimal-coord'], 'viewPatientDetails', scope).allowed, false, 'other hospital cannot see');
});

test('Task 2', 'bed board status, comments and My Tasks selectors', () => {
  const { S, act, now } = setup();
  const lvl = (id) => bedBoardStatus(S().beds[id], S(), now()).level;
  eq(['bed-er-06', 'bed-er-04', 'bed-er-07', 'bed-er-10', 'bed-er-01'].map(lvl), ['ready', 'pending', 'blocked', 'reserved', 'occupied'], 'levels');
  const st = bedBoardStatus(S().beds['bed-er-04'], S(), now());
  assert(st.forecast?.isEstimate && st.forecast.estimatedReadyAt && st.since, 'pending bed carries a forecast and time in state');
  eq(bedBoardStatus(S().beds['bed-er-06'], S(), now()).forecast, null, 'no forecast for a ready bed');
  eq(selectMyWork(S(), S().users['u-housekeeping'], now()).tasks.map((t) => t.id), ['task-er04-clean'], 'housekeeping work');
  eq(selectMyWork(S(), S().users['u-biomed'], now()).tickets.map((t) => t.id), ['mt-er07-monitor'], 'biomed ticket queue');
  eq(selectMyWork(S(), S().users['u-er-nurse-2'], now()).tasks.map((t) => t.id), ['task-er07-verify'], 'nurse sees only own or unclaimed tasks');
  ok(act('reportFault', { bedId: 'bed-er-06', kind: 'equipment', equipmentType: 'monitor', description: 'No display', severity: 'high' }, 'u-er-nurse-1'));
  eq(lvl('bed-er-06'), 'blocked', 'fault blocks the bed');
});

// ============================================================================
// Task 3: engine messages are codes
// ============================================================================
const ENGINE_FILES = ['data.js', 'messages.js', 'permissions.js', 'readiness.js', 'actions.js', 'selectors.js', 'store.js', 'vitals.js'];
async function engineSources() {
  if (globalThis.__SILA_SOURCES) return globalThis.__SILA_SOURCES; // bundled build embeds the sources
  if (typeof process !== 'undefined' && process.versions?.node) {
    const fs = await import('node:fs');
    return Object.fromEntries(ENGINE_FILES.map((f) => [f, fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')]));
  }
  const out = {};
  for (const f of ENGINE_FILES) out[f] = await (await fetch(new URL(`./${f}`, import.meta.url))).text();
  return out;
}
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('Task 3', 'every code the engine can emit has an i18n entry', async () => {
  const keys = new Set(allKeys());
  const sources = await engineSources();
  const codes = new Set();
  for (const [file, raw] of Object.entries(sources)) {
    const src = stripComments(raw);
    const calls = (src.match(/\bmsg\(/g) ?? []).length - (file === 'messages.js' ? 1 : 0); // minus the definition
    const literal = [...src.matchAll(/\bmsg\(\s*'([^']+)'/g)].map((m) => m[1]);
    eq(literal.length, calls, `${file}: every msg() call uses a string-literal code`);
    literal.forEach((c) => codes.add(c));
  }
  assert(codes.size > 400, `found ${codes.size} codes`);
  eq([...codes].filter((c) => !keys.has(c)), [], 'codes without English text');
  // Runtime cross-check: every message stored in a state produced by a full flow renders without a missing key.
  const { S, act } = setup();
  ok(act('reportFault', { bedId: 'bed-er-06', kind: 'equipment', equipmentType: 'monitor', description: 'No display', severity: 'high' }, 'u-er-nurse-1'));
  ok(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-03' }, 'u-icu-coord'));
  const seen = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') { if (isMsg(v)) seen.add(v.code); Object.values(v).forEach(walk); }
  };
  walk(S());
  eq([...seen].filter((c) => !keys.has(c)), [], 'stored message codes without English text');
});

test('Task 3', 'no engine module contains hard-coded English user-facing sentences', async () => {
  const sources = await engineSources();
  const offenders = [];
  const sentence = /['"`]([A-Za-z][^'"`]*\s[^'"`]*)['"`]/;
  const FIELD = /\b(reason|error|summary|description|title|message|detail|label|note|releaseReason|invalidatedReason|completionNotes|missing)\s*:\s*(['"`][^'"`]*['"`])/g;
  for (const [file, raw] of Object.entries(sources)) {
    const src = stripComments(raw);
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const where = `${file}:${i + 1}`;
      if (file !== 'data.js') {
        // Sentences returned or thrown as reasons/errors.
        if (/\breturn\s+['"`][A-Za-z][^'"`]*\s/.test(line)) offenders.push(`${where} return "${line.trim().slice(0, 60)}"`);
        if (/\bfail\([^,]+,\s*['"`]/.test(line)) offenders.push(`${where} fail(… "text")`);
        if (/\bthrow new Error\(['"`][A-Za-z][^'"`]*\s/.test(line) && file !== 'store.js') offenders.push(`${where} throw "text"`);
      }
      for (const m of line.matchAll(FIELD)) {
        // data.js may carry seed data (names, reported concerns, ticket descriptions); only system fields are checked there.
        if (file === 'data.js' && !['title', 'message', 'summary', 'detail', 'invalidatedReason', 'label'].includes(m[1])) continue;
        if (sentence.test(m[2])) offenders.push(`${where} ${m[1]}: ${m[2].slice(0, 50)}`);
      }
      if (/\bnotify\([^)]*,\s*'[a-z_]+',\s*['"`][A-Za-z][^'"`]*\s/.test(line)) offenders.push(`${where} notify(… "text")`);
    });
  }
  eq(offenders, [], 'hard-coded English in engine output fields');
});

test('Task 3', 'dispatch errors, permission reasons and blocker descriptions are codes with parameters', () => {
  const { S, act, now } = setup();
  const r = rejected(act('resolveFault', { ticketId: 'mt-er07-monitor', resolution: 'x' }, 'u-er-nurse-2'), 'forbidden');
  eq(r.error, { code: 'perm.biomedOnly', params: { verb: { code: 'verb.resolve' } } }, 'permission reason is a code');
  eq(text(r.error), 'Only a biomedical technician can resolve equipment tickets.', 'rendered exactly as before');
  const b = ready(S, 'bed-er-04', now).blockers.find((x) => x.type === 'cleaning');
  eq([b.description.code, text(b.description)], ['blockerDesc.cleaning', 'Cleaning required'], 'blocker description');
  const task = S().tasks['task-er04-clean'];
  eq([isMsg(task.title), text(task.title)], [true, 'Clean ER-04 after discharge'], 'task title');
  assert(values(S(), 'notifications').every((n) => isMsg(n.message)) && values(S(), 'auditEvents').every((e) => isMsg(e.summary)), 'notifications and audit summaries are codes');
});

// ============================================================================
// Task 3: capacity confirmation, cancel, diagnostics, comment alerts
// ============================================================================
test('Task 3', 'capacity confirmation is a separate ICU coordinator step after clinical acceptance', () => {
  const { S, act, now } = setup();
  const tr = () => S().transferRequests['tr-301'];
  rejected(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-03' }, 'u-icu-doc'), 'forbidden', 'ICU coordinator / charge nurse can confirm ICU capacity');
  rejected(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-03' }, 'u-er-coord'), 'forbidden');
  rejected(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-01' }, 'u-icu-coord'), 'invalid', 'ICU-01 is occupied by Aspen 11');
  rejected(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-er-06' }, 'u-icu-coord'), 'invalid', 'Choose an ICU bed');
  rejected(act('confirmCapacity', { transferId: 'tr-301' }, 'u-icu-coord'), 'invalid', 'Choose an ICU bed');
  const steps = transferSteps(tr(), S(), now());
  eq(steps.map((x) => x.status), ['done', 'done', 'current', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending'], 'tracker before capacity');
  eq([steps[2].ownerRole, steps[2].suggestedBedId, text(steps[2].reason)], ['icu_coordinator', 'bed-icu-03', 'Suggested: ICU-03 — awaiting ICU coordinator confirmation'], 'owner + suggestion');
  eq(values(S(), 'tasks').filter((t) => t.linked.transferId === 'tr-301').length, 0, 'no prep before confirmation');
  ok(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-05' }, 'u-icu-coord'), 'coordinator may pick another compatible bed');
  eq([tr().targetBedId, tr().capacity.by, tr().capacity.wasSuggested], ['bed-icu-05', 'u-icu-coord', false], 'capacity recorded');
  assert(values(S(), 'tasks').some((t) => t.linked.transferId === 'tr-301' && t.category === 'staffing' && t.linked.bedId === 'bed-icu-05'), 'prep linked to the confirmed bed');
  rejected(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-03' }, 'u-icu-coord'), 'invalid', 'already confirmed on ICU-05');
  rejected(act('reserveBed', { bedId: 'bed-icu-03', caseId: 'case-cedar' }, 'u-icu-coord'), 'invalid', 'reserve that bed');
  eq(transferSteps(tr(), S(), now()).map((x) => x.status).slice(0, 4), ['done', 'done', 'done', 'current'], 'tracker: bed being prepared');
});

test('Task 3', 'cancelTransferRequest releases the reservation and withdraws prep and handover work', () => {
  const { S, act } = setup();
  ok(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-03' }, 'u-icu-coord'));
  ok(act('verifyReadiness', { bedId: 'bed-icu-03' }, 'u-icu-nurse-1'));
  ok(act('reserveBed', { bedId: 'bed-icu-03', caseId: 'case-cedar' }, 'u-icu-coord'));
  const tr = S().transferRequests['tr-301'];
  const auditBefore = values(S(), 'auditEvents').length;
  rejected(act('cancelTransferRequest', { transferId: 'tr-301', reason: 'x' }, 'u-er-nurse-1'), 'forbidden', 'ER doctor or the ICU coordinator');
  rejected(act('cancelTransferRequest', { transferId: 'tr-301' }, 'u-er-doc'), 'invalid', 'reason is required');
  ok(act('cancelTransferRequest', { transferId: 'tr-301', reason: 'Improved on non-invasive support' }, 'u-er-doc'));
  const after = S().transferRequests['tr-301'];
  eq([after.status, S().reservations[tr.reservationId].status], ['canceled', 'released'], 'canceled, reservation released');
  assert(tr.handoverTaskIds.every((id) => S().tasks[id].status === 'canceled'), 'handover tasks canceled');
  assert(values(S(), 'tasks').filter((t) => t.prepFor === 'tr-301').every((t) => !['open', 'accepted', 'in_progress'].includes(t.status)), 'prep tasks withdrawn');
  eq([S().cases['case-cedar'].journey, S().patients['p-cedar'].location.bedId], ['in_care', 'bed-er-01'], 'patient stays in ER-01');
  assert(values(S(), 'auditEvents').length === auditBefore + 1 && values(S(), 'auditEvents').some((e) => e.action === 'cancelTransferRequest' && e.reason === 'Improved on non-invasive support'), 'audit kept with reason');
  eq(text(deriveTransferStatus(after, S(), T0).label), 'Canceled', 'status label');
  // ICU coordinator may cancel too; a request in transport cannot be canceled.
  const r = ok(act('requestTransfer', { caseId: 'case-basil', reason: 'Hypoxia' }, 'u-er-doc'));
  ok(act('cancelTransferRequest', { transferId: r.result.transferId, reason: 'Duplicate request' }, 'u-icu-coord'));
});

test('Task 3', 'a transfer in transport cannot be canceled', () => {
  const { S, act } = setup();
  ok(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-03' }, 'u-icu-coord'));
  ok(act('verifyReadiness', { bedId: 'bed-icu-03' }, 'u-icu-nurse-1'));
  ok(act('reserveBed', { bedId: 'bed-icu-03', caseId: 'case-cedar' }, 'u-icu-coord'));
  for (const id of S().transferRequests['tr-301'].handoverTaskIds) ok(act('updateTaskStatus', { taskId: id, status: 'done' }, S().tasks[id].department === 'ER' ? 'u-er-nurse-1' : 'u-icu-nurse-1'));
  ok(act('confirmDeparture', { caseId: 'case-cedar' }, 'u-er-nurse-1'));
  rejected(act('cancelTransferRequest', { transferId: 'tr-301', reason: 'x' }, 'u-er-doc'), 'invalid', 'complete the transfer instead');
});

test('Task 3', 'orderDiagnostic → diagnostics steps → doctor notified → acknowledgeReport', () => {
  const { S, act } = setup();
  rejected(act('orderDiagnostic', { patientId: 'p-basil', type: 'ct_head', reason: 'x' }, 'u-er-nurse-1'), 'forbidden', 'ER doctors can order diagnostics');
  rejected(act('orderDiagnostic', { patientId: 'p-basil', type: 'ct_head', reason: 'x' }, 'u-icu-doc'), 'forbidden', 'ER doctors');
  rejected(act('orderDiagnostic', { patientId: 'p-basil', type: 'mri', reason: 'x' }, 'u-er-doc'), 'invalid', 'Choose the investigation');
  rejected(act('orderDiagnostic', { patientId: 'p-ivy', type: 'ct_head', reason: 'x' }, 'u-er-doc'), 'forbidden');
  const r = ok(act('orderDiagnostic', { patientId: 'p-basil', type: 'ct_head', reason: 'New confusion' }, 'u-er-doc'));
  const t = () => S().tasks[r.result.taskId];
  eq([t().status, t().requiredRole, t().orderedBy, t().linked.bedId], ['requested', 'diagnostics', 'u-er-doc', 'bed-er-03'], 'requested task for diagnostics');
  assert(values(S(), 'notifications').some((n) => n.to.role === 'diagnostics' && n.ref.id === t().id), 'diagnostics notified');
  rejected(act('acknowledgeReport', { taskId: t().id }, 'u-er-doc'), 'invalid', 'not available yet');
  rejected(act('updateTaskStatus', { taskId: t().id, status: 'scheduled' }, 'u-er-doc'), 'forbidden');
  for (const status of ['scheduled', 'in_progress', 'report_available']) ok(act('updateTaskStatus', { taskId: t().id, status }, 'u-diag'));
  assert(values(S(), 'notifications').some((n) => n.to.userId === 'u-er-doc' && n.type === 'report_available'), 'ordering doctor notified');
  ok(act('acknowledgeReport', { taskId: t().id, note: 'Discussed with family' }, 'u-er-doc'));
  eq(t().reportAcknowledged.by, 'u-er-doc', 'acknowledged by the clinician');
  rejected(act('acknowledgeReport', { taskId: t().id }, 'u-er-doc'), 'invalid', 'already acknowledged');
  eq(S().beds['bed-er-03'].occupancy.patientId, 'p-basil', 'occupancy unchanged throughout');
});

test('Task 3', 'comments notify the record owners, never the author', () => {
  const { S, act } = setup();
  const notesFor = (pred) => values(S(), 'notifications').filter((n) => n.type === 'comment' && pred(n));
  ok(act('addComment', { targetType: 'bed', targetId: 'bed-er-04', text: 'Mattress cover torn' }, 'u-housekeeping'));
  eq(notesFor(() => true).map((n) => n.to), [{ userId: 'u-er-nurse-1' }], 'bed nurse notified');
  ok(act('addComment', { targetType: 'bed', targetId: 'bed-er-04', text: 'Replacement on its way' }, 'u-er-nurse-1'));
  assert(!notesFor((n) => n.to.userId === 'u-er-nurse-1').some((n) => text(n.message).includes('Replacement')), 'author not notified');
  assert(notesFor((n) => n.to.role === 'er_coordinator').length === 1, 'falls back to the coordinators when the author is the only owner');
  ok(act('addComment', { targetType: 'case', targetId: 'case-basil', text: 'Family arriving' }, 'u-er-doc'));
  const caseNotes = notesFor((n) => n.ref.id === 'case-basil');
  eq(caseNotes.map((n) => n.to.userId).sort(), ['u-er-nurse-1'], 'case: bed nurse (no coordinator assigned)');
  ok(act('addComment', { targetType: 'maintenanceTicket', targetId: 'mt-er07-monitor', text: 'Spare module ordered' }, 'u-er-coord'));
  assert(notesFor((n) => n.to.userId === 'u-biomed').length === 1, 'ticket assignee notified');
  eq(text(notesFor((n) => n.to.userId === 'u-biomed')[0].message), 'Mariam Al-Harbi commented on ticket BM-721: Spare module ordered', 'message');
});

test('Task 3', 'ICU dashboard selectors match the seed', () => {
  const s = seed(T0);
  const d = icuDashboard(s, H, T0);
  const expected = {
    incomingRequests: ['tr-301'], awaitingDecision: [], waitingCapacity: ['tr-301'], inTransit: [],
    occupied: ['bed-icu-01', 'bed-icu-02', 'bed-icu-04', 'bed-icu-07', 'bed-icu-08'], available: [], reserved: [],
    beingPrepared: ['bed-icu-03'], blocked: ['bed-icu-05', 'bed-icu-06'], expectedFree: ['bed-icu-02'], overdueTasks: [],
  };
  for (const [k, ids] of Object.entries(expected)) eq([d[k].ids, d[k].count], [ids, ids.length], `ICU ${k}`);
  eq(Object.keys(d), Object.keys(expected), 'one selector per ICU tile');
});

test('Task 3', 'support-team queues and porter jobs', () => {
  const { S, act, now } = setup();
  const hk = () => housekeepingQueue(S(), S().users['u-housekeeping'], now());
  eq(hk().required.map((t) => t.id), ['task-er04-clean'], 'required (unassigned)');
  ok(act('updateTaskStatus', { taskId: 'task-er04-clean', status: 'accepted' }, 'u-housekeeping'));
  eq([hk().required.length, hk().mine.map((t) => t.id)], [0, ['task-er04-clean']], 'mine');
  ok(act('completeCleaning', { bedId: 'bed-er-04' }, 'u-housekeeping'));
  eq(hk().doneToday.map((t) => t.id), ['task-er04-clean'], 'done today');
  const bm = biomedQueue(S(), S().users['u-biomed'], now());
  eq([bm.assigned.map((t) => t.id), bm.checks.length], [['mt-er07-monitor'], 0], 'biomed queue');
  eq(diagnosticsQueue(S(), S().users['u-diag'], now()).reportAvailable.map((t) => t.id), ['task-icu04-eeg'], 'diagnostics queue');
  ok(act('confirmCapacity', { transferId: 'tr-301', bedId: 'bed-icu-03' }, 'u-icu-coord'));
  ok(act('verifyReadiness', { bedId: 'bed-icu-03' }, 'u-icu-nurse-1'));
  ok(act('reserveBed', { bedId: 'bed-icu-03', caseId: 'case-cedar' }, 'u-icu-coord'));
  ok(act('assignPorter', { transferId: 'tr-301', porterUserId: 'u-porter' }, 'u-icu-coord'));
  eq(porterJobs(S(), S().users['u-porter'], now()).active.map((t) => t.id), ['tr-301'], 'porter job');
});

// ============================================================================
// Task 4: demo extraction, public hospital view, citizen ownership
// ============================================================================
test('Task 4', 'extractIntake reads each field from sample phrases and records why', () => {
  const r = extractIntake('My father is 72 years old. He has had a fever since this morning and now he seems confused. He is awake and breathing. '
    + 'He has diabetes and is allergic to penicillin. We are driving from Al Noor district. There are two people with him. Call me on 050 123 4567. He uses a wheelchair.');
  eq([r.fields.age, r.fields.onset, r.fields.awake, r.fields.breathing, r.fields.conditions, r.fields.allergies, r.fields.location, r.fields.transportMode, r.fields.patientCount, r.fields.contact, r.fields.assistance],
    ['72', 'since this morning', 'yes', 'yes', 'diabetes', 'penicillin', 'Al Noor district', 'private_car', '2', '050 123 4567', 'wheelchair'], 'fields');
  eq(r.fields.concern, 'He has had a fever since this morning and now he seems confused.', "concern in the caller's own words");
  eq([r.matches.age, r.matches.breathing, r.matches.transportMode], ['72 years old', 'and breathing', 'driving'], 'matches show the phrase used');
  eq(r.method, 'demo-rule-based', 'labelled as demo extraction');
  eq(extractIntake('She is about 45 and came by taxi').fields.age, '~45', 'approximate age');
  eq(extractIntake('My son is six.').fields.age, '6', 'number words');
  eq(extractIntake('He is in his seventies').fields.age, '70s', 'decade');
});

test('Task 4', 'extractIntake handles negation and defaults everything else to unknown', () => {
  const neg = extractIntake('He is not breathing and he is unconscious.').fields;
  eq([neg.breathing, neg.awake], ['no', 'no'], '"not breathing" is never read as breathing');
  eq(extractIntake('She stopped breathing a minute ago').fields.breathing, 'no', 'stopped breathing');
  eq(extractIntake("He isn't awake").fields.awake, 'no', "isn't awake");
  eq(extractIntake('She is not breathing well').fields.breathing, 'unknown', '"not breathing well" is difficulty, not absent breathing');
  const empty = extractIntake('Please help us.');
  eq(Object.values(empty.fields).every((v) => v === 'unknown'), true, 'every field defaults to unknown');
  eq(Object.keys(empty.matches), [], 'no matches');
  eq(Object.keys(empty.fields), INTAKE_FIELDS, 'fixed field set');
  const forbidden = /triage|diagnos|acuity|vital|priority|severity|heart.?rate|pressure|spo2|oxygen/i;
  for (const sample of ['Chest pain, sweating, he is 60', 'Fever 39.5 and heart rate 130, very sick', 'He is not breathing']) {
    const out = extractIntake(sample);
    assert(!Object.keys(out).some((k) => forbidden.test(k)) && !Object.keys(out.fields).some((k) => forbidden.test(k)), 'no triage/diagnosis/vitals keys');
  }
});

test('Task 4', 'transport mode needs a travel statement, not just a verb', () => {
  eq(['We will walk there.', 'We are walking over now', 'He has trouble walking.', "He can't walk"].map((x) => extractIntake(x).fields.transportMode),
    ['walking', 'walking', 'unknown', 'unknown'], 'walking only when the caller says they will walk');
  eq(extractIntake("He can't walk").fields.assistance, "can't walk", 'mobility need goes to assistance');
});

test('Task 4', 'extractIntake reads an Arabic sample (age and breathing)', () => {
  const r = extractIntake('والدتي عمرها ٦٨ سنة. عندها ضيق في التنفس منذ ساعتين لكنها واعية وتتنفس. عندها حساسية من البنسلين. سنأتي بالسيارة من حي الصفا.', 'ar');
  eq([r.fields.age, r.fields.breathing, r.fields.awake, r.fields.transportMode, r.fields.onset], ['68', 'yes', 'yes', 'private_car', 'منذ ساعتين'], 'Arabic fields');
  assert(r.fields.allergies.includes('حساسية'), 'allergy phrase kept');
  eq(extractIntake('لا يتنفس وغير واعي', 'ar').fields.breathing, 'no', 'Arabic negation');
  eq(extractIntake('غير واعي', 'ar').fields.awake, 'no', 'Arabic not conscious');
  eq(extractIntake('سيارة إسعاف', 'ar').fields.transportMode, 'ambulance', 'Arabic ambulance');
});

test('Task 4', 'public hospital view carries no patient, case or bed-level data', () => {
  const s = seed(T0);
  const pub = publicHospitals(s, T0);
  eq(pub.length, 3, 'three hospitals');
  for (const h of pub) {
    eq(Object.keys(h).sort(), [...PUBLIC_HOSPITAL_FIELDS].sort(), `${h.id}: public fields only`);
    assert(['low', 'medium', 'high'].includes(h.capacity) && h.erOpen === true && h.updatedAt, `${h.id}: capacity indicator and freshness`);
  }
  const text = JSON.stringify(pub);
  for (const leak of [...Object.keys(s.patients), ...Object.keys(s.cases), ...Object.keys(s.beds), ...values(s, 'patients').map((p) => p.alias), 'SL-20', 'ER-0', 'ICU-0', 'occupancy', 'reservation']) {
    assert(!text.includes(leak), `public view must not contain ${leak}`);
  }
  eq(pub.find((h) => h.id === H).capacity, 'medium', 'primary capacity derived from live ER readiness (2 of 12 ready)');
});

test('Task 4', 'hospitals are ranked by simulated distance only, never by capacity', () => {
  const s = seed(T0);
  const pub = publicHospitals(s, T0).map((h) => (h.id === 'h-qasr-bay' ? { ...h, capacity: 'low' } : { ...h, capacity: 'high' }));
  const ranked = rankHospitals(pub, { x: 2.5, y: 13 }, 'private_car'); // Al Safa, next to Qasr Bay
  eq([ranked[0].id, ranked[0].nearest, ranked[0].capacity], ['h-qasr-bay', true, 'low'], 'nearest stays first even with low capacity');
  assert(ranked.every((h, i) => i === 0 || h.trip.km >= ranked[i - 1].trip.km), 'ascending distance');
  eq(simulatedTrip({ x: 0, y: 0 }, { x: 3, y: 4 }, 'private_car'), { km: 6.5, minutes: 16 }, 'simulated trip model');
  const out = pointFromGeo(51.5, -0.12);
  eq([out.outside, typeof out.district.id], [true, 'string'], 'outside the demo area snaps to a district');
  eq(pointFromGeo(24.73, 46.68).outside, false, 'inside the demo area');
});

test('Task 4', 'a citizen device sees and changes only its own notices', () => {
  const { S, act } = setup();
  const A = 'device-aaaa';
  const B = 'device-bbbb';
  rejected(act('submitArrival', { destinationHospitalId: H, concern: 'Fever' }, 'u-citizen-public'), 'invalid', 'device could not be identified');
  const r = ok(act('submitArrival', { destinationHospitalId: H, concern: 'Fever and confusion', deviceRef: A, clientRef: 'A-1', awake: 'yes', breathing: 'yes', transcript: 'He is awake.' }, 'u-citizen-public'));
  const id = r.result.caseId;
  eq(citizenCases(S(), A).map((c) => c.id), [id], 'device A lists its case');
  eq(citizenCases(S(), B), [], 'device B lists nothing');
  eq(citizenCaseView(S(), id, B), null, 'device B cannot read it');
  eq([citizenCaseView(S(), id, A).ref, citizenCaseView(S(), id, A).status, citizenCaseView(S(), id, A).reported.breathing], [S().cases[id].ref, 'submitted', 'yes'], 'device A can');
  const pub = S().users['u-citizen-public'];
  eq(text(can(pub, 'viewCitizenCase', { assignedUserIds: ['u-citizen-public'], ownerDevice: A, requesterDevice: B }).reason), 'You can only see and change notices sent from this device.', 'read capability');
  rejected(act('cancelCase', { caseId: id, reason: 'Not mine', deviceRef: B }, 'u-citizen-public'), 'forbidden', 'can cancel this case');
  rejected(act('updateETA', { caseId: id, etaAt: addMinutes(T0, 5), deviceRef: B }, 'u-citizen-public'), 'forbidden');
  rejected(act('cancelCase', { caseId: 'case-reed', reason: 'x', deviceRef: A }, 'u-citizen-public'), 'forbidden');
  ok(act('updateETA', { caseId: id, etaAt: addMinutes(T0, 25), enRoute: true, deviceRef: A }, 'u-citizen-public'));
  ok(act('acknowledgeArrival', { caseId: id }, 'u-er-coord'));
  const ack = values(S(), 'notifications').filter((n) => n.type === 'acknowledged' && n.ref.id === id);
  eq(ack.map((n) => n.to), [{ deviceRef: A }], 'acknowledgment addressed to the device, not the shared account');
  rejected(act('markNotificationRead', { notificationId: ack[0].id, deviceRef: B }, 'u-citizen-public'), 'forbidden');
  ok(act('markNotificationRead', { notificationId: ack[0].id, deviceRef: A }, 'u-citizen-public'));
  ok(act('cancelCase', { caseId: id, reason: 'Feeling better', deviceRef: A }, 'u-citizen-public'));
  eq([citizenCaseView(S(), id, A).status, citizenCaseView(S(), id, A).cancelReason], ['canceled', 'Feeling better'], 'own cancel with reason');
});

test('Task 4', 'a citizen submission never creates a reservation, placement or ICU request', () => {
  const { S, act } = setup();
  const count = () => [values(S(), 'reservations').length, values(S(), 'placements').length, values(S(), 'transferRequests').length, values(S(), 'tasks').length];
  const before = count();
  ok(act('submitArrival', { destinationHospitalId: H, concern: 'Chest pain', deviceRef: 'device-cccc', clientRef: 'C-1' }, 'u-citizen-public'));
  ok(act('submitArrival', { destinationHospitalId: 'h-rimal', concern: 'Broken arm', deviceRef: 'device-cccc', clientRef: 'C-2' }, 'u-citizen-public'));
  ok(act('submitArrival', { clientRef: 'C-1', deviceRef: 'device-cccc', concern: 'Chest pain, now sweating' }, 'u-citizen-public'));
  eq(count(), before, 'no reservations, placements, transfers or tasks created');
  eq(citizenCases(S(), 'device-cccc').length, 2, 'resend updated the first notice instead of duplicating');
  rejected(act('submitArrival', { destinationHospitalId: H, concern: 'x', deviceRef: 'device-cccc', requestIcu: true }, 'u-citizen-public'), 'invalid', 'cannot request ICU');
});

// ============================================================================
// Task 5: ambulance crew
// ============================================================================
const crewRun = (extra = {}) => ({ destinationHospitalId: H, concern: 'Chest pain at rest', clientRef: `run-${Math.random().toString(36).slice(2, 8)}`, ...extra });

test('Task 5', "a crew sees only its own unit's cases and cannot read or update another unit's case", () => {
  const { S, act } = setup();
  const a12 = S().users['u-para-1'];
  const a07 = S().users['u-para-2'];
  eq([a12.ambulanceId, S().users['u-para-4'].ambulanceId, a07.ambulanceId, S().users['u-para-3'].ambulanceId], ['WN-A12', 'WN-A12', 'WN-A07', 'WN-A07'], 'two seeded units with named crews');
  eq(crewCases(S(), a12).map((c) => c.id), ['case-ivy'], 'WN-A12 sees only its case');
  eq(crewCases(S(), a07).map((c) => c.id).sort(), ['case-laurel', 'case-moss'], 'WN-A07 sees only its cases');
  assert(crewCaseView(S(), 'case-ivy', S().users['u-para-4']), 'a second crew member of the same unit sees the case');
  eq(crewCaseView(S(), 'case-ivy', a07), null, "another unit's case is not readable");
  eq(crewCaseView(S(), 'case-ivy', S().users['u-er-coord']), null, 'the crew view is for crews only');
  eq(text(can(a07, 'viewCrewCase', crewScope(S(), S().cases['case-ivy'])).reason), 'Only the ambulance crew assigned to this case can do this.', 'viewCrewCase denied across units');
  assert(can(a12, 'viewCrewCase', crewScope(S(), S().cases['case-ivy'])).allowed, 'viewCrewCase allowed for the unit');
  rejected(act('updateETA', { caseId: 'case-ivy', etaAt: addMinutes(T0, 5) }, 'u-para-2'), 'forbidden');
  rejected(act('submitArrival', { caseId: 'case-ivy', concern: 'x' }, 'u-para-2'), 'forbidden');
  rejected(act('updateCrewStatus', { caseId: 'case-ivy', status: 'arrived' }, 'u-para-3'), 'forbidden', 'Only the ambulance crew assigned');
  rejected(act('cancelCase', { caseId: 'case-ivy', reason: 'x' }, 'u-para-2'), 'forbidden');
  rejected(act('changeDestination', { caseId: 'case-ivy', toHospitalId: 'h-rimal', reason: 'x' }, 'u-para-2'), 'forbidden');
  // The other crew member of WN-A12 can act on it (the case belongs to the unit).
  ok(act('updateETA', { caseId: 'case-ivy', etaAt: addMinutes(T0, 6) }, 'u-para-4'));
  // Acknowledgments and clarifications reach only the unit whose case it is.
  ok(act('acknowledgeArrival', { caseId: 'case-laurel' }, 'u-er-coord'));
  ok(act('requestClarification', { caseId: 'case-laurel', question: 'Any blood thinners?' }, 'u-er-coord'));
  const about = (u) => notificationsFor(S(), S().users[u]).filter((n) => n.ref?.id === 'case-laurel' || S().comments[n.ref?.id]?.caseId === 'case-laurel').map((n) => n.type).sort();
  eq(about('u-para-2'), ['acknowledged', 'clarification'], 'WN-A07 crew is told');
  eq(about('u-para-3'), ['acknowledged', 'clarification'], 'both WN-A07 crew members are told');
  eq([about('u-para-1'), about('u-para-4')], [[], []], 'WN-A12 hears nothing about WN-A07 cases');
  const q = values(S(), 'comments').find((c) => c.caseId === 'case-laurel' && c.status === 'open');
  rejected(act('respondClarification', { commentId: q.id, answer: 'No' }, 'u-para-1'), 'forbidden');
  ok(act('respondClarification', { commentId: q.id, answer: 'No anticoagulants' }, 'u-para-3'));
});

test('Task 5', 'vitals: impossible values are rejected; readings are stored structured, appended, never interpreted', () => {
  const { S, act, advance } = setup();
  const bad = [
    [{ type: 'SpO2', value: 140, takenAt: T0 }, 'outside the physically possible range (0–100 %)'],
    [{ type: 'HR', value: 'fast', takenAt: T0 }, 'Enter Heart rate as a number'],
    [{ type: 'GCS', value: 2, takenAt: T0 }, 'GCS 2 is outside'],
    [{ type: 'RR', value: 18.5, takenAt: T0 }, 'whole number'],
    [{ type: 'BP', value: { systolic: 80, diastolic: 120 }, takenAt: T0 }, 'not physically possible'],
    [{ type: 'BP', value: '120/80', takenAt: T0 }, 'two whole numbers'],
    [{ type: 'Temp', value: 51, takenAt: T0 }, 'Temperature 51'],
    [{ type: 'HR', value: 90, takenAt: addMinutes(T0, 30) }, 'in the future'],
    [{ type: 'HR', value: 90 }, 'Enter the time'],
    [{ type: 'Pulse', value: 90, takenAt: T0 }, 'Choose a vital-sign type'],
  ];
  for (const [reading, text] of bad) {
    rejected(act('submitArrival', crewRun({ vitals: [reading] }), 'u-para-1'), 'invalid', text);
  }
  const caseCount = values(S(), 'cases').length;
  const first = ok(act('submitArrival', crewRun({ clientRef: 'v-1', vitals: [
    { type: 'HR', value: '112', takenAt: addMinutes(T0, -10), unit: 'beats', abnormal: true, score: 3 },
    { type: 'HR', value: 104, takenAt: T0 },
    { type: 'BP', value: { systolic: '150', diastolic: '92' }, takenAt: T0 },
    { type: 'Temp', value: '38.27', takenAt: T0 },
    { type: 'glucose', value: '5,4', takenAt: T0 },
  ] }), 'u-para-1'));
  const id = first.result.caseId;
  const n = () => S().arrivalNotices[S().cases[id].noticeId];
  const v = n().handover.vitals;
  eq(v.map((r) => Object.keys(r).sort().join(',')), Array(5).fill('enteredBy,id,takenAt,type,unit,value'), 'only the structured fields are stored');
  eq(v.map((r) => [r.type, r.value, r.unit]), [['HR', 112, 'bpm'], ['HR', 104, 'bpm'], ['BP', { systolic: 150, diastolic: 92 }, 'mmHg'], ['Temp', 38.3, '°C'], ['glucose', 5.4, 'mmol/L']], 'values normalized; unit comes from the type');
  eq([...new Set(v.map((r) => r.enteredBy))], ['u-para-1'], 'enteredBy is the signed-in crew member');
  const spoof = ok(act('submitArrival', crewRun({ vitals: [{ type: 'HR', value: 80, takenAt: T0, id: 'vs-ivy-1', enteredBy: 'u-er-doc' }] }), 'u-para-1'));
  const sv = S().arrivalNotices[S().cases[spoof.result.caseId].noticeId].handover.vitals[0];
  assert(sv.id !== 'vs-ivy-1' && sv.enteredBy === 'u-para-1', 'the engine assigns the reading id and enteredBy, not the client');
  // Readings over time are appended; a resend carrying already-sent readings does not duplicate them.
  advance(4);
  ok(act('submitArrival', { caseId: id, vitals: [...v, { type: 'SpO2', value: 91, takenAt: addMinutes(T0, 4) }] }, 'u-para-1'));
  eq(n().handover.vitals.map((r) => r.type), ['HR', 'HR', 'BP', 'Temp', 'glucose', 'SpO2'], 'new reading appended, old ones kept');
  rejected(act('submitArrival', { caseId: id, vitals: [{ type: 'SpO2', value: 140, takenAt: addMinutes(T0, 4) }] }, 'u-para-1'), 'invalid', 'SpO₂ 140');
  eq(values(S(), 'cases').length, caseCount + 2, 'one case per new handover; resends add none');
  // Nothing anywhere interprets a reading.
  const FORBIDDEN = /abnormal|flag|score|interpret|severity|alert|warning|news2|risk|normalRange|isHigh|isLow/i;
  const keys = [];
  const walk = (o) => { if (o && typeof o === 'object') for (const [k, val] of Object.entries(o)) { keys.push(k); walk(val); } };
  walk(n()); walk(S().cases[id]);
  eq(keys.filter((k) => FORBIDDEN.test(k)), [], 'no interpretation fields on the notice or case');
  for (const type of VITAL_TYPE_KEYS) {
    const sample = type === 'BP' ? { systolic: 300, diastolic: 200 } : { HR: 300, RR: 90, SpO2: 50, Temp: 45, GCS: 3, glucose: 70 }[type];
    eq(vitalProblem({ type, value: sample, takenAt: T0 }, T0), null, `${type}: an extreme but possible value is accepted without comment`);
    eq(Object.keys(normalizeReading({ type, value: sample, takenAt: T0 }, 'u-para-1', 'vs-x')).sort(), ['enteredBy', 'id', 'takenAt', 'type', 'unit', 'value'], `${type}: no extra keys`);
  }
});

test('Task 5', 'crew-reported acuity is stored with source crew and never copied into the staff triage field', () => {
  const { S, act } = setup();
  rejected(act('submitArrival', crewRun({ crewAcuity: 'urgent' }), 'u-para-1'), 'invalid', 'crew-reported acuity');
  const r = ok(act('submitArrival', crewRun({ clientRef: 'acu-1', crewAcuity: 'critical' }), 'u-para-1'));
  const id = r.result.caseId;
  const c = () => S().cases[id];
  const n = () => S().arrivalNotices[c().noticeId];
  eq([c().crewAcuity, n().handover.crewAcuity, c().triage], [{ level: 'critical', source: 'crew' }, { level: 'critical', source: 'crew' }, null], 'stored as crew-reported; triage untouched');
  ok(act('submitArrival', { caseId: id, crewAcuity: 'moderate' }, 'u-para-1'));
  eq([c().crewAcuity.level, c().triage], ['moderate', null], 'updating crew acuity still leaves triage empty');
  ok(act('updateCrewStatus', { caseId: id, status: 'en_route' }, 'u-para-1'));
  ok(act('updateCrewStatus', { caseId: id, status: 'arrived' }, 'u-para-1'));
  eq(c().triage, null, 'arrival does not derive triage from crew acuity');
  ok(act('recordTriage', { caseId: id, priority: 2 }, 'u-er-nurse-1'));
  eq([c().triage.priority, c().triage.source, c().crewAcuity], [2, 'staff-entered', { level: 'moderate', source: 'crew' }], 'staff triage recorded separately; crew acuity unchanged');
  // A citizen cannot supply a crew acuity.
  const cit = ok(act('submitArrival', { destinationHospitalId: H, concern: 'x', deviceRef: 'device-acu', crewAcuity: 'high' }, 'u-citizen-public'));
  eq(S().cases[cit.result.caseId].crewAcuity, null, 'only a crew can report acuity');
});

test('Task 5', 'handover resent twice stays one case with two "handover updated" entries listing the changed fields', () => {
  const { S, act, advance } = setup();
  const cases0 = values(S(), 'cases').length;
  const r = ok(act('submitArrival', crewRun({ clientRef: 'twice', crewAcuity: 'high', requirements: { monitor: true },
    vitals: [{ type: 'HR', value: 120, takenAt: T0 }], interventions: ['IV access'] }), 'u-para-1'));
  const id = r.result.caseId;
  const n = () => S().arrivalNotices[S().cases[id].noticeId];
  advance(3);
  ok(act('submitArrival', { clientRef: 'twice', vitals: [{ type: 'SpO2', value: 90, takenAt: addMinutes(T0, 3) }] }, 'u-para-1'));
  advance(3);
  ok(act('submitArrival', { caseId: id, history: 'Diabetes', requirements: { isolation: true }, etaAt: addMinutes(T0, 15) }, 'u-para-4'));
  rejected(act('submitArrival', { caseId: id, approxAge: 300 }, 'u-para-1'), 'invalid', 'age');
  eq(values(S(), 'cases').length, cases0 + 1, 'still one case');
  eq([n().revision, n().updates.length], [3, 2], 'version bumped twice, two update entries');
  eq(n().updates[0].changes, [{ field: 'vitals', readingId: n().handover.vitals[1].id, type: 'SpO2' }], 'first update lists the new reading');
  eq(n().updates[1].changes.map((ch) => ch.field), ['handover.history', 'requirements.isolation', 'etaAt'], 'second update lists its fields');
  eq(n().updates[1].by, 'u-para-4', 'who sent the update');
  const audits = auditLog(S(), { recordId: id, action: 'submitArrival' });
  eq(audits.length, 3, 'one audit entry per send');
  const updates = audits.filter((a) => a.summary.code === 'audit.handoverUpdated');
  eq(updates.length, 2, 'two "handover updated" audit entries');
  assert(text(updates.at(-1).summary).startsWith('Handover updated for'), 'plain-language summary');
  eq(updates.map((a) => a.details.length).sort(), [1, 3], 'audit entries list the changed fields');
  const notes = notificationsFor(S(), S().users['u-er-coord']).filter((x) => x.type === 'handover_updated' && x.ref?.id === id);
  eq(notes.length, 2, 'the ER is told about each update');
  assert(text(notes[0].message).includes('Handover updated'), 'notification text');
});

test('Task 5', 'crew status flow: sent → en route → arrived; acknowledged and handover complete belong to the ER; invalid jumps rejected', () => {
  const { S, act } = setup();
  const id = ok(act('submitArrival', crewRun({ clientRef: 'flow' }), 'u-para-1')).result.caseId;
  const st = () => S().arrivalNotices[S().cases[id].noticeId].status;
  eq(st(), 'submitted', 'sent');
  rejected(act('updateCrewStatus', { caseId: id, status: 'acknowledged' }, 'u-para-1'), 'invalid', 'Only the receiving ER can acknowledge');
  rejected(act('updateCrewStatus', { caseId: id, status: 'arrived' }, 'u-para-1'), 'invalid', 'The case is sent; it cannot move to arrived yet');
  rejected(act('updateCrewStatus', { caseId: id, status: 'handover_complete' }, 'u-para-1'), 'invalid', 'completed by the receiving ER');
  rejected(act('updateCrewStatus', { caseId: id, status: 'draft' }, 'u-para-1'), 'invalid', 'Choose en route or arrived');
  rejected(act('updateCrewStatus', { caseId: id, status: 'en_route' }, 'u-er-coord'), 'forbidden', 'Only the ambulance crew');
  rejected(act('acknowledgeArrival', { caseId: id }, 'u-para-1'), 'forbidden');
  ok(act('acknowledgeArrival', { caseId: id }, 'u-er-coord'));
  eq(st(), 'acknowledged', 'the ER acknowledged');
  ok(act('updateCrewStatus', { caseId: id, status: 'en_route' }, 'u-para-1'));
  eq([st(), S().ambulanceAssignments[S().cases[id].ambulanceAssignmentId].status], ['en_route', 'en_route'], 'en route');
  rejected(act('updateCrewStatus', { caseId: id, status: 'en_route' }, 'u-para-1'), 'invalid', 'it cannot move to en route');
  ok(act('updateCrewStatus', { caseId: id, status: 'arrived' }, 'u-para-1'));
  const loc = S().patients[S().cases[id].patientId].location;
  eq([st(), loc.kind, loc.hospitalId], ['arrived', 'er_waiting', H], 'arrived: one accurate location at the ER door');
  rejected(act('updateCrewStatus', { caseId: id, status: 'arrived' }, 'u-para-1'), 'invalid', 'already');
  rejected(act('updateCrewStatus', { caseId: id, status: 'en_route' }, 'u-para-1'), 'invalid');
  const task = values(S(), 'tasks').find((t) => t.category === 'ambulance_handover' && t.linked.caseId === id);
  assert(task, 'arrival creates the ER handover task');
  rejected(act('updateTaskStatus', { taskId: task.id, status: 'done' }, 'u-para-1'), 'forbidden');
  ok(act('updateTaskStatus', { taskId: task.id, status: 'done' }, 'u-er-nurse-1'));
  eq(st(), 'handover_complete', 'the ER completes the handover');
  assert(notificationsFor(S(), S().users['u-para-4']).some((x) => x.type === 'handover_complete' && x.ref?.id === id), 'the whole unit hears handover complete');
});

test('Task 5', 'admin can read the audit log but cannot perform any clinical action', () => {
  const { S, act } = setup();
  const admin = S().users['u-admin'];
  assert(can(admin, 'viewAuditLog', null).allowed, 'admin reads the audit log');
  for (const u of ['u-er-coord', 'u-er-nurse-1', 'u-para-1', 'u-citizen-public']) assert(!can(S().users[u], 'viewAuditLog', null).allowed, `${u} cannot read the audit log`);
  const before = JSON.stringify(S());
  const attempts = [
    ['acknowledgeArrival', { caseId: 'case-laurel' }], ['recordTriage', { caseId: 'case-reed', priority: 2 }], ['confirmArrival', { caseId: 'case-laurel' }],
    ['requestClarification', { caseId: 'case-laurel', question: 'x' }], ['assignCoordinator', { caseId: 'case-laurel', coordinatorId: 'u-er-coord' }],
    ['reserveBed', { bedId: 'bed-er-04', caseId: 'case-laurel' }], ['confirmPlacement', { bedId: 'bed-er-10', caseId: 'case-ivy' }],
    ['verifyReadiness', { bedId: 'bed-er-04' }], ['submitArrival', crewRun()], ['updateCrewStatus', { caseId: 'case-ivy', status: 'arrived' }],
    ['changeDestination', { caseId: 'case-ivy', toHospitalId: 'h-rimal', reason: 'x' }], ['cancelCase', { caseId: 'case-ivy', reason: 'x' }],
    ['requestTransfer', { caseId: 'case-reed', reason: 'x' }], ['orderDiagnostic', { patientId: 'p-reed', type: 'ct_head' }],
  ];
  for (const [name, payload] of attempts) {
    rejected(act(name, payload, 'u-admin'), 'forbidden');
    const pf = preflight(S(), name, payload, 'u-admin', T0, { permissionOnly: true });
    assert(!pf.ok && pf.code === 'forbidden', `${name}: preflight explains the disabled button`);
  }
  eq(JSON.stringify(S()), before, 'nothing changed');
  // The log reads in plain language and filters by user, record, action and date.
  ok(act('acknowledgeArrival', { caseId: 'case-laurel' }, 'u-er-coord'));
  const byUser = auditLog(S(), { userId: 'u-er-coord' });
  assert(byUser.length && byUser.every((e) => e.actorId === 'u-er-coord'), 'filter by user');
  eq(auditLog(S(), { recordId: 'case-laurel', action: 'acknowledgeArrival' }).map((e) => text(e.summary)), ['SL-2042 acknowledged; coordinator Amira Haddad'].map(() => text(byUser[0].summary)), 'filter by record and action');
  eq(auditLog(S(), { from: addMinutes(T0, 1) }).length, 0, 'filter by date');
});

// Must stay last: proves no action is a stub.
test('Coverage', 'every action in dispatch ran successfully at least once', () => {
  const missing = ACTION_NAMES().filter((n) => !succeeded.has(n));
  eq(missing, [], `actions never exercised successfully (${ACTION_NAMES().length - missing.length}/${ACTION_NAMES().length} covered)`);
});

// ============================================================================
export async function runAll() {
  const results = [];
  for (const t of tests) {
    const started = performance.now();
    try {
      await t.fn();
      results.push({ group: t.group, name: t.name, pass: true, error: null, ms: performance.now() - started });
    } catch (e) {
      results.push({ group: t.group, name: t.name, pass: false, error: e instanceof Fail ? e.message : `${e.name}: ${e.message}\n${e.stack}`, ms: performance.now() - started });
    }
  }
  return results;
}
