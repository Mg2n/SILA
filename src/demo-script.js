// SILA — guided demo script (SPEC §14). Pure data: each step names the role, page and real control to highlight, and
// the engine actions that "Do it for me" dispatches — the very same actions and payloads the highlighted buttons send,
// checked by the same permission rules. Steps read everything they need from state, so Back/Skip/resume always work.
// Steps marked `ui` also need a client-side preparation (loading a sample, a crew draft) that the UI performs.

import { values, PRIMARY_HOSPITAL_ID as H, addMinutes } from './data.js';
import { deriveBedReadiness, activeTransferForCase, latestEquipmentCheck, isCheckValid } from './readiness.js';
import { extractIntake } from './extract.js';
import { simulatedTrip } from './geo.js';
import { DISTRICTS } from './config.js';
import { t } from './i18n.js';

export const DEMO_CITIZEN_REF = 'demo-citizen';
export const DEMO_CREW_REF = 'demo-crew';
export const DEMO_SAMPLE = 'fever';
export const DEMO_BED = 'bed-er-04';
export const DEMO_ICU_BED = 'bed-icu-08';
export const STEP_DOWN_CASE = 'case-poplar';

// ---------- Looking things up in state ----------
const caseByRef = (s, clientRef) => {
  const n = values(s, 'arrivalNotices').find((x) => x.clientRef === clientRef);
  return n ? s.cases[n.caseId] : null;
};
export const citizenCase = (s) => caseByRef(s, DEMO_CITIZEN_REF);
export const crewCase = (s) => caseByRef(s, DEMO_CREW_REF);
export const demoTicket = (s) => values(s, 'maintenanceTickets').filter((x) => x.bedId === DEMO_BED && x.kind === 'equipment')
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
export const demoTransfer = (s) => { const c = crewCase(s); return c ? activeTransferForCase(s, c.id) ?? values(s, 'transferRequests').find((x) => x.caseId === c.id) ?? null : null; };
const patientOf = (s, c) => (c ? s.patients[c.patientId] : null);
const inBed = (s, c, bedId) => patientOf(s, c)?.location.kind === 'bed' && patientOf(s, c).location.bedId === bedId;
const ready = (s, bedId, now) => deriveBedReadiness(s.beds[bedId], s, now).blockers.length === 0;
const openTask = (s, trId, dept) => {
  const tr = s.transferRequests[trId];
  return (tr?.handoverTaskIds ?? []).map((id) => s.tasks[id]).find((x) => x && x.department === dept) ?? null;
};
const resFor = (s, c) => (c ? values(s, 'reservations').find((r) => r.caseId === c.id && r.status === 'active') ?? null : null);

/** The citizen notice payload the UI's "Send" button builds, from a transcript and the nearest hospital. */
export function citizenNoticePayload(transcript, { deviceRef, now, districtId = 'al-noor', clientRef = DEMO_CITIZEN_REF }) {
  const lang = /[؀-ۿ]/.test(transcript) ? 'ar' : 'en';
  const f = extractIntake(transcript, lang).fields;
  const known = (k) => (f[k] && f[k] !== 'unknown' ? f[k] : null);
  const d = DISTRICTS.find((x) => x.id === districtId);
  const mode = ['private_car', 'taxi', 'walking'].includes(f.transportMode) ? f.transportMode : 'unknown';
  const both = f.awake === 'no' || f.breathing === 'no' ? 'no' : f.awake === 'yes' && f.breathing === 'yes' ? 'yes' : 'unknown';
  return { mode, district: d, build: (hospital) => ({
    destinationHospitalId: hospital.id, clientRef, deviceRef, concern: known('concern'), ageText: known('age'), onset: known('onset'),
    awake: f.awake, breathing: f.breathing, awakeBreathing: both, conditions: known('conditions'), allergies: known('allergies'),
    patientCount: known('patientCount') ?? 1, location: known('location'), contact: known('contact'), accessibilityNeeds: known('assistance'),
    transcript, extractionMethod: 'demo-rule-based', transportMode: mode, origin: { x: d.x, y: d.y },
    etaAt: addMinutes(now, simulatedTrip({ x: d.x, y: d.y }, hospital.position, mode).minutes),
  }) };
}
const nearestHospital = (s, district) => values(s, 'hospitals')
  .map((h) => ({ h, km: simulatedTrip({ x: district.x, y: district.y }, h.position).km })).sort((a, b) => a.km - b.km)[0].h;

/** What the crew types for the demo ambulance case, in the presenter's language. */
export function crewDraftFields(now) {
  return {
    concern: t('demo.data.crewConcern'), approxAge: '58', sex: 'male', history: t('demo.data.crewHistory'), allergies: t('demo.data.crewAllergies'),
    crewAcuity: 'high', chips: ['oxygen', 'iv'], requirements: { isolation: false, ventilator: false, monitor: true }, patientCount: '1',
    districtId: 'old-town', destinationHospitalId: H, etaMinutes: '8', crewNotes: t('demo.data.crewNotes'),
    vitals: [
      { type: 'HR', value: '118', takenAt: addMinutes(now, -6) },
      { type: 'BP', value: { systolic: '92', diastolic: '58' }, takenAt: addMinutes(now, -6) },
      { type: 'SpO2', value: '91', takenAt: addMinutes(now, -5) },
      { type: 'RR', value: '26', takenAt: addMinutes(now, -5) },
    ],
  };
}
export const crewPayload = (now) => {
  const d = crewDraftFields(now);
  return { destinationHospitalId: H, clientRef: DEMO_CREW_REF, concern: d.concern, approxAge: 58, sex: d.sex, history: d.history, allergies: d.allergies,
    crewNotes: d.crewNotes, receivingRequirements: null, patientCount: 1, interventions: d.chips, crewAcuity: d.crewAcuity, requirements: d.requirements,
    vitals: d.vitals, etaAt: addMinutes(now, 8), origin: (({ x, y }) => ({ x, y }))(DISTRICTS.find((x) => x.id === d.districtId)) };
};

// ---------- Building blocks ----------
const fk = (action, payload) => `[data-focus-key='${action}:${JSON.stringify(payload)}']`;
const caseDrawer = (c) => (c ? { type: 'case', id: c.id } : null);
const bedDrawer = (id) => ({ type: 'bed', id });
const trDrawer = (tr) => (tr ? { type: 'transfer', id: tr.id } : null);

// One engine action: who does it, where its real button is, how to tell it is already done.
const A = {
  citizenSend: {
    as: 'citizen', route: '#/citizen/hospitals', ui: 'citizenPrepareSend', target: () => '[data-focus-key="send"]', action: 'submitArrival',
    payload: (s, c) => { const p = citizenNoticePayload(t(`sample.${DEMO_SAMPLE}.text`), c); return p.build(nearestHospital(s, p.district)); },
    done: (s) => !!citizenCase(s),
  },
  erAck: {
    as: 'u-er-coord', route: '#/er', target: (s) => fk('acknowledgeArrival', { caseId: citizenCase(s)?.id }), action: 'acknowledgeArrival',
    payload: (s) => ({ caseId: citizenCase(s).id }), done: (s) => !!s.arrivalNotices[citizenCase(s)?.noticeId]?.acknowledged,
  },
  crewSend: {
    as: 'u-para-1', route: '#/crew/preview', ui: 'crewPrepareDraft', target: () => '[data-focus-key="crew-send"]', action: 'submitArrival',
    payload: (s, c) => crewPayload(c.now), done: (s) => !!crewCase(s),
  },
  reportFault: {
    as: 'u-er-nurse-1', route: '#/er', drawer: () => bedDrawer(DEMO_BED), target: () => fk('reportFault', { bedId: DEMO_BED }), action: 'reportFault',
    payload: () => ({ bedId: DEMO_BED, kind: 'equipment', equipmentType: 'monitor', description: t('demo.data.faultText'), severity: 'high' }),
    done: (s) => !!demoTicket(s),
  },
  wrongRole: {
    as: 'u-er-nurse-1', route: '#/er', drawer: () => bedDrawer(DEMO_BED), target: (s) => fk('resolveFault', { ticketId: demoTicket(s)?.id }), action: 'resolveFault',
    payload: (s) => ({ ticketId: demoTicket(s).id, resolution: t('demo.data.repair') }), expectReject: true,
  },
  resolveFault: {
    as: 'u-biomed', route: '#/queue', target: (s) => fk('resolveFault', { ticketId: demoTicket(s)?.id }), action: 'resolveFault',
    payload: (s) => ({ ticketId: demoTicket(s).id, resolution: t('demo.data.repair') }), done: (s) => demoTicket(s)?.status === 'resolved',
  },
  monitorCheck: {
    as: 'u-biomed', route: '#/er', drawer: () => bedDrawer(DEMO_BED), target: () => fk('recordEquipmentCheck', { bedId: DEMO_BED }), action: 'recordEquipmentCheck',
    payload: () => ({ bedId: DEMO_BED, equipment: 'monitor', result: 'passed' }), done: (s) => isCheckValid(latestEquipmentCheck(s, DEMO_BED, 'monitor')),
  },
  cleanErBed: {
    as: 'u-housekeeping', route: '#/queue', target: () => fk('completeCleaning', { bedId: DEMO_BED }), action: 'completeCleaning',
    payload: () => ({ bedId: DEMO_BED }), done: (s) => s.beds[DEMO_BED].cleaning.status === 'complete' || !!crewCase(s) && inBed(s, crewCase(s), DEMO_BED),
  },
  verifyErBed: {
    as: 'u-er-nurse-1', route: '#/er', drawer: () => bedDrawer(DEMO_BED), target: () => fk('verifyReadiness', { bedId: DEMO_BED }), action: 'verifyReadiness',
    payload: () => ({ bedId: DEMO_BED }), done: (s) => s.beds[DEMO_BED].nursingVerification.status === 'verified',
  },
  reserveErBed: {
    as: 'u-er-coord', route: '#/er', drawer: (s) => bedDrawer(DEMO_BED), target: () => fk('reserveBed', { bedId: DEMO_BED }), action: 'reserveBed',
    payload: (s) => ({ bedId: DEMO_BED, caseId: crewCase(s).id, minutes: 30 }), done: (s) => !!resFor(s, crewCase(s)) || inBed(s, crewCase(s), DEMO_BED),
  },
  confirmArrival: {
    as: 'u-er-nurse-1', route: '#/er', target: (s) => fk('confirmArrival', { caseId: crewCase(s)?.id }), action: 'confirmArrival',
    payload: (s) => ({ caseId: crewCase(s).id }), done: (s) => !!crewCase(s) && patientOf(s, crewCase(s)).location.kind !== 'pre_hospital',
  },
  triage: {
    as: 'u-er-nurse-1', route: '#/er', target: (s) => fk('recordTriage', { caseId: crewCase(s)?.id }), action: 'recordTriage',
    payload: (s) => ({ caseId: crewCase(s).id, priority: 2 }), done: (s) => !!crewCase(s)?.triage,
  },
  place: {
    as: 'u-er-nurse-1', route: '#/er', target: (s) => fk('confirmPlacement', { bedId: DEMO_BED, caseId: crewCase(s)?.id }), action: 'confirmPlacement',
    payload: (s) => ({ bedId: DEMO_BED, caseId: crewCase(s).id }), done: (s) => inBed(s, crewCase(s), DEMO_BED) || !!demoTransfer(s),
  },
  requestIcu: {
    as: 'u-er-doc', route: '#/er', drawer: (s) => caseDrawer(crewCase(s)), target: (s) => fk('requestTransfer', { caseId: crewCase(s)?.id }), action: 'requestTransfer',
    payload: (s) => ({ caseId: crewCase(s).id, reason: t('demo.data.icuReason'), requirements: { ventilator: true } }), done: (s) => !!demoTransfer(s),
  },
  acceptIcu: {
    as: 'u-icu-doc', route: '#/icu', drawer: (s) => trDrawer(demoTransfer(s)), target: (s) => fk('approveTransfer', { transferId: demoTransfer(s)?.id, decision: 'accept' }),
    action: 'approveTransfer', payload: (s) => ({ transferId: demoTransfer(s).id, decision: 'accept', reason: t('demo.data.acceptReason') }),
    done: (s) => !!demoTransfer(s) && !['requested'].includes(demoTransfer(s).status),
  },
  flagStepDown: {
    as: 'u-icu-doc', route: '#/icu', drawer: () => bedDrawer(DEMO_ICU_BED), target: () => fk('flagStepDown', { caseId: STEP_DOWN_CASE }), action: 'flagStepDown',
    payload: () => ({ caseId: STEP_DOWN_CASE, reason: t('demo.data.stepDownReason') }),
    done: (s) => !!s.cases[STEP_DOWN_CASE].stepDown?.flagged || s.cases[STEP_DOWN_CASE].status !== 'active' || s.patients[s.cases[STEP_DOWN_CASE].patientId].location.kind !== 'bed',
  },
  stepDownDepart: {
    as: 'u-icu-coord', route: '#/icu', drawer: () => bedDrawer(DEMO_ICU_BED), target: () => fk('confirmDeparture', { caseId: STEP_DOWN_CASE }), action: 'confirmDeparture',
    payload: () => ({ caseId: STEP_DOWN_CASE }), done: (s) => s.patients[s.cases[STEP_DOWN_CASE].patientId].location.kind !== 'bed',
  },
  confirmCapacity: {
    as: 'u-icu-coord', route: '#/icu', drawer: (s) => trDrawer(demoTransfer(s)), target: (s) => fk('confirmCapacity', { transferId: demoTransfer(s)?.id }), action: 'confirmCapacity',
    payload: (s) => ({ transferId: demoTransfer(s).id, bedId: DEMO_ICU_BED }), done: (s) => !!demoTransfer(s)?.targetBedId,
  },
  cleanIcuBed: {
    as: 'u-housekeeping', route: '#/queue', target: () => fk('completeCleaning', { bedId: DEMO_ICU_BED }), action: 'completeCleaning',
    payload: () => ({ bedId: DEMO_ICU_BED }), done: (s) => s.beds[DEMO_ICU_BED].cleaning.status === 'complete',
  },
  ventCheck: {
    as: 'u-biomed', route: '#/icu', drawer: () => bedDrawer(DEMO_ICU_BED), target: () => fk('recordEquipmentCheck', { bedId: DEMO_ICU_BED }), action: 'recordEquipmentCheck',
    payload: () => ({ bedId: DEMO_ICU_BED, equipment: 'ventilator', result: 'passed' }), done: (s) => isCheckValid(latestEquipmentCheck(s, DEMO_ICU_BED, 'ventilator')),
  },
  verifyIcuBed: {
    as: 'u-icu-nurse-1', route: '#/icu', drawer: () => bedDrawer(DEMO_ICU_BED), target: () => fk('verifyReadiness', { bedId: DEMO_ICU_BED }), action: 'verifyReadiness',
    payload: () => ({ bedId: DEMO_ICU_BED }), done: (s) => s.beds[DEMO_ICU_BED].nursingVerification.status === 'verified',
  },
  reserveIcuBed: {
    as: 'u-icu-coord', route: '#/icu', drawer: (s) => trDrawer(demoTransfer(s)), target: (s) => fk('reserveBed', { bedId: DEMO_ICU_BED, caseId: crewCase(s)?.id }), action: 'reserveBed',
    payload: (s) => ({ bedId: DEMO_ICU_BED, caseId: crewCase(s).id }), done: (s) => !!demoTransfer(s) && !['requested', 'accepted'].includes(demoTransfer(s).status),
  },
  handoverSend: {
    as: 'u-er-nurse-1', route: '#/er', drawer: (s) => trDrawer(demoTransfer(s)), target: (s) => fk('updateTaskStatus', { taskId: openTask(s, demoTransfer(s)?.id, 'ER')?.id, status: 'done' }),
    action: 'updateTaskStatus', payload: (s) => ({ taskId: openTask(s, demoTransfer(s).id, 'ER').id, status: 'done' }),
    done: (s) => openTask(s, demoTransfer(s)?.id, 'ER')?.status === 'done',
  },
  handoverReceive: {
    as: 'u-icu-nurse-1', route: '#/icu', drawer: (s) => trDrawer(demoTransfer(s)), target: (s) => fk('updateTaskStatus', { taskId: openTask(s, demoTransfer(s)?.id, 'ICU')?.id, status: 'done' }),
    action: 'updateTaskStatus', payload: (s) => ({ taskId: openTask(s, demoTransfer(s).id, 'ICU').id, status: 'done' }),
    done: (s) => openTask(s, demoTransfer(s)?.id, 'ICU')?.status === 'done',
  },
  assignPorter: {
    as: 'u-er-coord', route: '#/er', drawer: (s) => trDrawer(demoTransfer(s)), target: (s) => fk('assignPorter', { transferId: demoTransfer(s)?.id }), action: 'assignPorter',
    payload: (s) => ({ transferId: demoTransfer(s).id, porterUserId: 'u-porter' }), done: (s) => !!demoTransfer(s)?.porterUserId,
  },
  pickup: {
    as: 'u-porter', route: '#/transport', target: (s) => fk('confirmPickup', { transferId: demoTransfer(s)?.id }), action: 'confirmPickup',
    payload: (s) => ({ transferId: demoTransfer(s).id }), done: (s) => !!demoTransfer(s) && ['in_transit', 'arrived', 'completed'].includes(demoTransfer(s).status),
  },
  dropoff: {
    as: 'u-porter', route: '#/transport', target: (s) => fk('confirmDropoff', { transferId: demoTransfer(s)?.id }), action: 'confirmDropoff',
    payload: (s) => ({ transferId: demoTransfer(s).id }), done: (s) => !!demoTransfer(s) && ['arrived', 'completed'].includes(demoTransfer(s).status),
  },
  // After the porter's drop-off the transfer drawer offers "Confirm placement · ICU-08" — the step uses that same control.
  icuArrival: {
    as: 'u-icu-nurse-1', route: '#/icu', drawer: (s) => trDrawer(demoTransfer(s)), target: (s) => fk('confirmPlacement', { bedId: DEMO_ICU_BED, caseId: crewCase(s)?.id }),
    action: 'confirmPlacement', payload: (s) => ({ bedId: DEMO_ICU_BED, caseId: crewCase(s).id }), done: (s) => demoTransfer(s)?.status === 'completed',
  },
};

// Steps a presenter only needs to look at: the role, page and what to point at.
const V = {
  citizenSample: { as: 'citizen', route: '#/citizen', ui: 'citizenShowSamples', target: () => `[data-focus-key="sample:${DEMO_SAMPLE}"]`, uiAction: 'citizenLoadSample' },
  citizenReview: { as: 'citizen', route: '#/citizen/review', target: () => '[data-focus-key="reviewed"]', uiAction: 'citizenConfirmReview' },
  erSeesNotice: { as: 'u-er-coord', route: '#/er', target: (s) => `[data-focus-key="open:case:${citizenCase(s)?.id}"]` },
  erBedBlocked: { as: 'u-er-coord', route: '#/er', target: () => `[data-focus-key="open:bed:${DEMO_BED}"]` },
  finale: { as: 'u-housekeeping', route: '#/queue', target: () => fk('completeCleaning', { bedId: DEMO_BED }) },
};

// ---------- Steps ----------
const needCitizen = (s) => (citizenCase(s) ? null : 'demo.pre.citizenCase');
const needCrew = (s) => (crewCase(s) ? null : 'demo.pre.crewCase');
const needTicket = (s) => (demoTicket(s) && demoTicket(s).status !== 'resolved' ? null : 'demo.pre.ticket');
const needPlaced = (s) => (inBed(s, crewCase(s), DEMO_BED) || demoTransfer(s) ? null : 'demo.pre.placed');
const needTransfer = (s) => (demoTransfer(s) ? null : 'demo.pre.transfer');
const needCapacity = (s) => (demoTransfer(s)?.targetBedId ? null : 'demo.pre.capacity');
const needDemoBedFree = (s) => (s.beds[DEMO_BED].occupancy.status === 'vacant' || inBed(s, crewCase(s), DEMO_BED) ? null : 'demo.pre.bedTaken');

export const STEPS = {
  citizenSample: { view: V.citizenSample },
  citizenReview: { view: V.citizenReview },
  citizenSend: { actions: [A.citizenSend] },
  citizenReviewSend: { actions: [A.citizenSend], prepare: ['citizenConfirmReview'] },
  erSeesNotice: { view: V.erSeesNotice, pre: needCitizen },
  erAck: { actions: [A.erAck], pre: needCitizen },
  crewHandover: { actions: [A.crewSend] },
  erBedBlocked: { view: V.erBedBlocked, pre: needDemoBedFree },
  nurseReportsFault: { actions: [A.reportFault], pre: needDemoBedFree },
  wrongRole: { actions: [A.wrongRole], pre: needTicket },
  biomedResolves: { actions: [A.resolveFault, A.monitorCheck], pre: (s) => (demoTicket(s) ? null : 'demo.pre.ticket') },
  cleaning: { actions: [A.cleanErBed] },
  nurseVerifies: { actions: [A.verifyErBed] },
  reserve: { actions: [A.reserveErBed], pre: needCrew },
  arrivePlace: { actions: [A.confirmArrival, A.triage, A.place], pre: needCrew },
  reservePlace: { actions: [A.reserveErBed, A.confirmArrival, A.triage, A.place], pre: needCrew },
  icuRequest: { actions: [A.requestIcu], pre: needPlaced },
  icuApprove: { actions: [A.acceptIcu], pre: needTransfer },
  icuRequestAccept: { actions: [A.requestIcu, A.acceptIcu], pre: needPlaced },
  stepDownFlag: { actions: [A.flagStepDown] },
  icuCapacity: { actions: [A.stepDownDepart, A.confirmCapacity, A.cleanIcuBed, A.ventCheck, A.verifyIcuBed, A.reserveIcuBed], pre: needTransfer },
  icuCapacityStepDown: { actions: [A.flagStepDown, A.stepDownDepart, A.confirmCapacity, A.cleanIcuBed, A.ventCheck, A.verifyIcuBed, A.reserveIcuBed], pre: needTransfer },
  handoverMove: { actions: [A.handoverSend, A.handoverReceive, A.assignPorter, A.pickup, A.dropoff], pre: needCapacity },
  handoverMoveArrive: { actions: [A.handoverSend, A.handoverReceive, A.assignPorter, A.pickup, A.dropoff, A.icuArrival], pre: needCapacity },
  icuArrival: { actions: [A.icuArrival], pre: needTransfer },
  finale: { view: V.finale, pre: (s) => (demoTransfer(s)?.status === 'completed' ? null : 'demo.pre.finale') },
};

export const PATHS = {
  pitch: ['citizenSample', 'citizenReviewSend', 'erAck', 'crewHandover', 'nurseReportsFault', 'biomedResolves', 'cleaning', 'nurseVerifies',
    'reservePlace', 'icuRequestAccept', 'icuCapacityStepDown', 'handoverMoveArrive', 'finale'],
  tour: ['citizenSample', 'citizenReview', 'citizenSend', 'erSeesNotice', 'erAck', 'crewHandover', 'erBedBlocked', 'nurseReportsFault', 'wrongRole',
    'biomedResolves', 'cleaning', 'nurseVerifies', 'reserve', 'arrivePlace', 'icuRequest', 'icuApprove', 'stepDownFlag', 'icuCapacity',
    'handoverMove', 'icuArrival', 'finale'],
};

/**
 * The next action of a step that still needs doing, judged now (later actions can only be judged once earlier ones ran:
 * an occupied ICU room looks "clean" until the step-down departure). `attempted` holds expect-reject actions already tried.
 */
export function nextAction(stepId, s, attempted = new Set()) {
  return (STEPS[stepId].actions ?? []).find((a, i) => (a.expectReject ? !attempted.has(i) : !a.done(s))) ?? null;
}
export const actionIndex = (stepId, a) => (STEPS[stepId].actions ?? []).indexOf(a);
/** True when every action of an action step is reflected in state (view steps and the wrong-role attempt never are). */
export const stepDone = (stepId, s) => !!STEPS[stepId].actions && STEPS[stepId].actions.every((a) => a.done && a.done(s));
export const CITIZEN_DEMO_USER = 'u-citizen-public';
