// SILA — pure read-only selectors for dashboards and lists (SPEC §8). Every count is derived from state;
// readiness itself always comes from deriveBedReadiness().

import { values, isOpenTask, isOpenTicket, ACTIVE_TRANSFER_STATUS } from './data.js';
import { msg } from './messages.js';
import { simulatedTrip } from './geo.js';
import { can } from './permissions.js';
import {
  deriveBedReadiness, forecastReadyTime, incomingCases, activeReservationForBed, myTasks, expectedToFreeSoon, suggestedBedFor,
} from './readiness.js';

const byLabel = (a, b) => a.label.localeCompare(b.label);
const ms = (iso) => Date.parse(iso);

export const BLOCKED_KINDS = {
  maintenance: ['technical_fault'],
  equipment: ['equipment_ticket', 'equipment_check'],
  staffing: ['staffing'],
};
// Blockers that are not routine turnover (cleaning / verification / reservation).
const HARD_BLOCKERS = Object.values(BLOCKED_KINDS).flat();

export function erBeds(state, hospitalId) {
  return values(state, 'beds').filter((b) => b.hospitalId === hospitalId && b.department === 'ER').sort(byLabel);
}

function erWaitingCases(state, hospitalId) {
  return values(state, 'cases').filter((c) => {
    const loc = state.patients[c.patientId]?.location;
    return c.status === 'active' && c.destinationHospitalId === hospitalId && loc?.kind === 'er_waiting' && loc.department === 'ER';
  }).sort((a, b) => ms(a.arrivedAt ?? a.createdAt) - ms(b.arrivedAt ?? b.createdAt));
}

const withReadiness = (state, hospitalId, now) => erBeds(state, hospitalId).map((b) => ({ b, r: deriveBedReadiness(b, state, now) }));
const hasBlocker = (r, types) => r.blockers.some((x) => types.includes(x.type));

export function selectIncoming(state, hospitalId) {
  const eta = (c) => ms(state.arrivalNotices[c.noticeId]?.etaAt ?? '9999-12-31T00:00:00Z');
  return incomingCases(state, hospitalId).sort((a, b) => eta(a) - eta(b));
}
export const selectAwaitingTriage = (state, hospitalId) => erWaitingCases(state, hospitalId).filter((c) => c.journey === 'triage_pending');
export const selectWaiting = (state, hospitalId) => erWaitingCases(state, hospitalId).filter((c) => c.journey !== 'triage_pending');
export const selectInCare = (state, hospitalId) => erBeds(state, hospitalId).filter((b) => b.occupancy.status === 'occupied');
export const selectAvailableBeds = (state, hospitalId, now) => withReadiness(state, hospitalId, now).filter(({ r }) => r.available).map(({ b }) => b);
export const selectReservedBeds = (state, hospitalId, now) => withReadiness(state, hospitalId, now).filter(({ r }) => hasBlocker(r, ['reserved'])).map(({ b }) => b);
export const selectBeingCleaned = (state, hospitalId, now) => withReadiness(state, hospitalId, now).filter(({ r }) => hasBlocker(r, ['cleaning'])).map(({ b }) => b);
// Includes occupied beds: a fault or staffing gap on an occupied bed is an urgent operational blocker.
export const selectBlockedBeds = (state, hospitalId, now, kind) =>
  withReadiness(state, hospitalId, now).filter(({ r }) => hasBlocker(r, BLOCKED_KINDS[kind] ?? HARD_BLOCKERS)).map(({ b }) => b);

export function selectIcuRequests(state, hospitalId) {
  return values(state, 'transferRequests')
    .filter((t) => t.hospitalId === hospitalId && t.fromDepartment === 'ER' && ACTIVE_TRANSFER_STATUS.includes(t.status))
    .sort((a, b) => ms(a.requestedAt) - ms(b.requestedAt));
}

// Overdue operational work for a department: open tasks and open tickets past their due time.
export function selectOverdueWork(state, hospitalId, now, department = 'ER') {
  const late = (x) => x.dueAt && ms(x.dueAt) < ms(now) && x.hospitalId === hospitalId && x.department === department;
  return [
    ...values(state, 'tasks').filter((t) => isOpenTask(t) && late(t)),
    ...values(state, 'maintenanceTickets').filter((t) => isOpenTicket(t) && late(t)),
  ].sort((a, b) => ms(a.dueAt) - ms(b.dueAt));
}

// One entry per ER dashboard tile: what it lists (cases, beds, transfers or work items) and the ids.
export const ER_TILE_KEYS = ['incoming', 'awaitingTriage', 'waiting', 'inCare', 'available', 'reserved', 'beingCleaned',
  'blockedMaintenance', 'blockedEquipment', 'blockedStaffing', 'icuRequests', 'overdueTasks'];

export function erDashboard(state, hospitalId, now) {
  const entry = (kind, list) => ({ kind, count: list.length, ids: list.map((x) => x.id) });
  return {
    incoming: entry('cases', selectIncoming(state, hospitalId)),
    awaitingTriage: entry('cases', selectAwaitingTriage(state, hospitalId)),
    waiting: entry('cases', selectWaiting(state, hospitalId)),
    inCare: entry('beds', selectInCare(state, hospitalId)),
    available: entry('beds', selectAvailableBeds(state, hospitalId, now)),
    reserved: entry('beds', selectReservedBeds(state, hospitalId, now)),
    beingCleaned: entry('beds', selectBeingCleaned(state, hospitalId, now)),
    blockedMaintenance: entry('beds', selectBlockedBeds(state, hospitalId, now, 'maintenance')),
    blockedEquipment: entry('beds', selectBlockedBeds(state, hospitalId, now, 'equipment')),
    blockedStaffing: entry('beds', selectBlockedBeds(state, hospitalId, now, 'staffing')),
    icuRequests: entry('transfers', selectIcuRequests(state, hospitalId)),
    overdueTasks: entry('work', selectOverdueWork(state, hospitalId, now)),
  };
}

// Compact counts (kept from Task 1's readiness.deriveErCounts, which now lives here).
export function deriveErCounts(state, hospitalId, now) {
  const d = erDashboard(state, hospitalId, now);
  return {
    incoming: d.incoming.count, awaitingTriage: d.awaitingTriage.count, waiting: d.waiting.count, inCare: d.inCare.count,
    availableStaffedBeds: d.available.count, reservedBeds: d.reserved.count, beingCleaned: d.beingCleaned.count,
    blockedBeds: selectBlockedBeds(state, hospitalId, now).length, icuRequests: d.icuRequests.count, overdueTasks: d.overdueTasks.count,
  };
}

// Presentation level for a bed card, derived from the shared readiness result:
// ready (green) · pending (amber: turnover work only) · blocked (red: fault, equipment or staffing) · reserved · occupied.
export function bedBoardStatus(bed, state, now) {
  const readiness = deriveBedReadiness(bed, state, now);
  const types = readiness.blockers.map((b) => b.type);
  const occupied = bed.occupancy.status === 'occupied';
  let level;
  if (readiness.available) level = 'ready';
  else if (occupied) level = 'occupied';
  else if (types.some((t) => HARD_BLOCKERS.includes(t))) level = 'blocked';
  else if (types.every((t) => t === 'reserved')) level = 'reserved';
  else level = 'pending';
  const urgent = occupied && types.some((t) => HARD_BLOCKERS.includes(t));
  const forecast = !occupied && !readiness.available && level !== 'reserved' ? forecastReadyTime(bed, state, now) : null;
  const since = [bed.occupancy.since, bed.cleaning.since, bed.nursingVerification.since, ...readiness.blockers.map((b) => b.since)]
    .filter(Boolean).reduce((a, b) => (ms(b) > ms(a) ? b : a));
  return { level, urgent, readiness, forecast, since, reservation: activeReservationForBed(state, bed.id, now) };
}

export function commentsFor(state, targetType, targetId) {
  return values(state, 'comments')
    .filter((c) => (c.targetType === targetType && c.targetId === targetId) || (targetType === 'case' && c.caseId === targetId))
    .sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
}

// Audit events that touched or referenced a record, newest first.
export function historyFor(state, entity, id) {
  return values(state, 'auditEvents')
    .filter((e) => e.refs?.some((r) => r.entity === entity && r.id === id) || e.changed?.includes(id))
    .sort((a, b) => ms(b.at) - ms(a.at));
}

// Care tasks for a patient (treatments, diagnostics, reviews, handovers) — separate from bed state.
const BED_WORK = ['cleaning', 'nursing_verification', 'staffing', 'equipment_check'];
export function careTasksForPatient(state, patientId) {
  return values(state, 'tasks').filter((t) => t.linked.patientId === patientId && !BED_WORK.includes(t.category))
    .sort((a, b) => Number(!isOpenTask(a)) - Number(!isOpenTask(b)) || ms(b.createdAt) - ms(a.createdAt));
}
export function bedWorkTasks(state, bedId) {
  return values(state, 'tasks').filter((t) => t.linked.bedId === bedId && BED_WORK.includes(t.category) && isOpenTask(t));
}

// "My tasks": open tasks for the user's role (unclaimed or mine) plus, for technicians, their ticket queue.
const TECH_KIND = { maintenance_tech: 'technical', biomed_tech: 'equipment' };
export function selectMyWork(state, user, now) {
  const due = (x) => (x.dueAt ? ms(x.dueAt) : Infinity);
  const tasks = myTasks(state, user).sort((a, b) => due(a) - due(b));
  const kind = TECH_KIND[user.role];
  const tickets = kind
    ? values(state, 'maintenanceTickets').filter((t) => t.kind === kind && isOpenTicket(t) && t.hospitalId === user.hospitalId
      && (!t.assignedTo || t.assignedTo === user.id)).sort((a, b) => due(a) - due(b))
    : [];
  const overdue = [...tasks, ...tickets].filter((x) => x.dueAt && ms(x.dueAt) < ms(now)).length;
  return { tasks, tickets, overdue };
}

export function unreadCount(notifications, user) {
  return notifications.filter((n) => !n.readBy.includes(user.id)).length;
}

// ---------------------------------------------------------------------------
// ICU dashboard
// ---------------------------------------------------------------------------
export function icuBeds(state, hospitalId) {
  return values(state, 'beds').filter((b) => b.hospitalId === hospitalId && b.department === 'ICU').sort(byLabel);
}

const icuTransfers = (state, hospitalId, statuses) => values(state, 'transferRequests')
  .filter((t) => t.hospitalId === hospitalId && t.toDepartment === 'ICU' && statuses.includes(t.status))
  .sort((a, b) => ms(a.requestedAt) - ms(b.requestedAt));

export const ICU_TILE_KEYS = ['incomingRequests', 'awaitingDecision', 'waitingCapacity', 'inTransit', 'occupied', 'available', 'reserved',
  'beingPrepared', 'blocked', 'expectedFree', 'overdueTasks'];

export function icuDashboard(state, hospitalId, now) {
  const entry = (kind, list) => ({ kind, count: list.length, ids: list.map((x) => x.id) });
  const beds = icuBeds(state, hospitalId).map((b) => ({ b, st: bedBoardStatus(b, state, now) }));
  const level = (l) => beds.filter(({ st }) => st.level === l).map(({ b }) => b);
  return {
    incomingRequests: entry('transfers', icuTransfers(state, hospitalId, ACTIVE_TRANSFER_STATUS)),
    awaitingDecision: entry('transfers', icuTransfers(state, hospitalId, ['requested'])),
    waitingCapacity: entry('transfers', icuTransfers(state, hospitalId, ['accepted']).filter((t) => !t.targetBedId)),
    inTransit: entry('transfers', icuTransfers(state, hospitalId, ['in_transit', 'arrived'])),
    occupied: entry('beds', beds.filter(({ b }) => b.occupancy.status === 'occupied').map(({ b }) => b)),
    available: entry('beds', level('ready')),
    reserved: entry('beds', level('reserved')),
    beingPrepared: entry('beds', level('pending')),
    blocked: entry('beds', beds.filter(({ b, st }) => b.occupancy.status === 'vacant' && st.level === 'blocked').map(({ b }) => b)),
    expectedFree: entry('beds', expectedToFreeSoon(state, hospitalId).sort(byLabel)),
    overdueTasks: entry('work', selectOverdueWork(state, hospitalId, now, 'ICU')),
  };
}

// ---------------------------------------------------------------------------
// ER → ICU transfer step tracker (SPEC §9 + amendment 1)
// Requested → Clinically accepted → Capacity confirmed → Bed ready → Reserved → Handover done → In transit → Arrived → Placed
// Each step: { key, status: done|current|pending|stopped, at, by, ownerRole, ownerDepartment, ownerUser, reason, ... }
// ---------------------------------------------------------------------------
export const TRANSFER_STEP_KEYS = ['requested', 'accepted', 'capacity', 'bedReady', 'reserved', 'handover', 'inTransit', 'arrived', 'placed'];

export function transferSteps(tr, state, now) {
  const order = ['requested', 'accepted', 'reserved', 'in_transit', 'arrived', 'completed'];
  const past = (status) => order.indexOf(tr.status) >= order.indexOf(status) && order.indexOf(tr.status) !== -1;
  const bed = tr.targetBedId ? state.beds[tr.targetBedId] : null;
  const res = tr.reservationId ? state.reservations[tr.reservationId] : null;
  const handovers = tr.handoverTaskIds.map((id) => state.tasks[id]).filter(Boolean);
  const handoverDone = handovers.length === 2 && handovers.every((t) => t.status === 'done');
  const doneAt = (t) => t.history.findLast?.((h) => h.status === 'done') ?? [...t.history].reverse().find((h) => h.status === 'done');
  const stopped = ['declined', 'canceled'].includes(tr.status);
  const steps = [];
  const push = (key, status, extra = {}) => steps.push({ key, status, at: null, by: null, ownerRole: null, ownerDepartment: null, ownerUser: null, reason: null, ...extra });
  let current = null; // first not-done step gets "current"; the rest are pending
  const next = (key, extra) => {
    if (stopped) return push(key, 'stopped', { reason: tr.status === 'declined' ? msg('common.text', { text: tr.clinicalDecision?.reason ?? '' }) : msg('common.text', { text: tr.cancelReason ?? '' }) });
    if (current) return push(key, 'pending', extra);
    current = key;
    return push(key, 'current', extra);
  };

  push('requested', 'done', { at: tr.requestedAt, by: tr.requestedBy, ownerRole: 'doctor', ownerDepartment: 'ER' });

  if (tr.clinicalDecision?.decision === 'accept') push('accepted', 'done', { at: tr.clinicalDecision.at, by: tr.clinicalDecision.by, ownerRole: 'doctor', ownerDepartment: 'ICU' });
  else if (tr.status === 'declined') push('accepted', 'stopped', { at: tr.clinicalDecision?.at, by: tr.clinicalDecision?.by, ownerRole: 'doctor', ownerDepartment: 'ICU', reason: msg('common.text', { text: tr.clinicalDecision?.reason ?? '' }) });
  else next('accepted', { ownerRole: 'doctor', ownerDepartment: 'ICU', reason: msg('trReason.awaitingIntensivist') });

  if (tr.capacity) push('capacity', 'done', { at: tr.capacity.at, by: tr.capacity.by, ownerRole: 'icu_coordinator', bedId: tr.capacity.bedId });
  else {
    const suggested = tr.status === 'accepted' ? suggestedBedFor(state, tr, now) : null;
    next('capacity', { ownerRole: 'icu_coordinator', suggestedBedId: suggested,
      reason: tr.status === 'accepted' ? (suggested ? msg('trReason.suggested', { bed: state.beds[suggested].label }) : msg('trReason.noCompatibleBed')) : null });
  }

  const readiness = bed ? deriveBedReadiness(bed, state, now) : null;
  if (bed && (past('reserved') || readiness.available)) {
    push('bedReady', 'done', { at: bed.nursingVerification.at, by: bed.nursingVerification.by, ownerRole: 'nurse', ownerDepartment: 'ICU', bedId: bed.id });
  } else {
    const first = readiness?.blockers[0];
    next('bedReady', { bedId: bed?.id ?? null, blockers: readiness?.blockers ?? [], ownerRole: first?.ownerRole ?? 'nurse', ownerUser: first?.ownerUser ?? null,
      ownerDepartment: 'ICU', reason: first?.description ?? null });
  }

  if (res && past('reserved')) push('reserved', 'done', { at: res.createdAt, by: res.createdBy, ownerRole: 'icu_coordinator', reservationId: res.id });
  else next('reserved', { ownerRole: 'icu_coordinator', reason: bed ? msg('trReason.reserve') : null });

  if (handoverDone) {
    const last = handovers.map(doneAt).sort((a, b) => ms(b.at) - ms(a.at))[0];
    push('handover', 'done', { at: last?.at, by: last?.by, ownerRole: 'nurse', taskIds: tr.handoverTaskIds });
  } else if (past('in_transit')) {
    push('handover', 'done', { ownerRole: 'nurse', taskIds: tr.handoverTaskIds });
  } else next('handover', { ownerRole: 'nurse', taskIds: tr.handoverTaskIds, reason: tr.status === 'reserved' ? msg('trReason.handoverDeparture') : null });

  if (tr.departedAt) push('inTransit', 'done', { at: tr.departedAt, by: tr.departedBy, ownerRole: tr.porterUserId ? 'porter' : 'er_coordinator' });
  else next('inTransit', { ownerRole: tr.porterUserId ? 'porter' : 'er_coordinator', ownerUser: tr.porterUserId ?? null });

  if (tr.droppedOffAt) push('arrived', 'done', { at: tr.droppedOffAt, by: tr.droppedOffBy, ownerRole: tr.porterUserId ? 'porter' : 'icu_coordinator' });
  else next('arrived', { ownerRole: tr.porterUserId ? 'porter' : 'icu_coordinator', ownerUser: tr.porterUserId ?? null, reason: tr.status === 'in_transit' ? msg('trReason.confirmArrival') : null });

  if (tr.completedAt) push('placed', 'done', { at: tr.completedAt, by: tr.completedBy, ownerRole: 'icu_coordinator', bedId: tr.targetBedId });
  else next('placed', { ownerRole: 'icu_coordinator', reason: tr.status === 'arrived' ? msg('trReason.confirmPlacement', { bed: bed?.label ?? '' }) : null });

  return steps;
}

// ---------------------------------------------------------------------------
// Support-team queues
// ---------------------------------------------------------------------------
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const lastChange = (t) => t.history.at(-1)?.at ?? t.updatedAt;

export function housekeepingQueue(state, user, now) {
  const all = values(state, 'tasks').filter((t) => t.category === 'cleaning' && t.hospitalId === user.hospitalId);
  return {
    required: all.filter((t) => t.status === 'open' && !t.ownerUserId),
    mine: all.filter((t) => t.ownerUserId === user.id && ['open', 'accepted'].includes(t.status)),
    inProgress: all.filter((t) => t.status === 'in_progress'),
    blocked: all.filter((t) => t.status === 'blocked'),
    doneToday: all.filter((t) => t.status === 'done' && sameDay(lastChange(t), now)),
  };
}

const ticketGroups = (tickets, now) => ({
  open: tickets.filter((t) => t.status === 'open'),
  assigned: tickets.filter((t) => t.status === 'assigned'),
  inProgress: tickets.filter((t) => t.status === 'in_progress'),
  resolvedToday: tickets.filter((t) => t.status === 'resolved' && t.resolvedAt && sameDay(t.resolvedAt, now)),
});

export function maintenanceQueue(state, user, now) {
  return ticketGroups(values(state, 'maintenanceTickets').filter((t) => t.kind === 'technical' && t.hospitalId === user.hospitalId), now);
}

export function biomedQueue(state, user, now) {
  return {
    ...ticketGroups(values(state, 'maintenanceTickets').filter((t) => t.kind === 'equipment' && t.hospitalId === user.hospitalId), now),
    checks: values(state, 'tasks').filter((t) => t.category === 'equipment_check' && t.hospitalId === user.hospitalId && isOpenTask(t)),
  };
}

export function diagnosticsQueue(state, user, now) {
  const all = values(state, 'tasks').filter((t) => t.category === 'diagnostic' && t.hospitalId === user.hospitalId);
  return {
    requested: all.filter((t) => t.status === 'requested'),
    scheduled: all.filter((t) => t.status === 'scheduled'),
    inProgress: all.filter((t) => t.status === 'in_progress'),
    reportAvailable: all.filter((t) => t.status === 'report_available' && (!t.reportAcknowledged || sameDay(t.reportAcknowledged.at, now))),
  };
}

export function porterJobs(state, user, now) {
  const mine = values(state, 'transferRequests').filter((t) => t.porterUserId === user.id);
  return {
    active: mine.filter((t) => ['reserved', 'in_transit', 'arrived'].includes(t.status)).sort((a, b) => ms(a.requestedAt) - ms(b.requestedAt)),
    doneToday: mine.filter((t) => t.status === 'completed' && t.completedAt && sameDay(t.completedAt, now)),
  };
}

// ---------------------------------------------------------------------------
// Public (citizen-facing) data — never patient, case or bed-level details
// ---------------------------------------------------------------------------
export const PUBLIC_HOSPITAL_FIELDS = ['id', 'name', 'nameAr', 'shortName', 'position', 'erOpen', 'services', 'capacity', 'updatedAt'];

// Capacity is a coarse public indicator: for hospitals with live bed data it is derived from the share of ER beds
// ready right now; otherwise the hospital's published level is used.
export function publicHospitals(state, now) {
  return values(state, 'hospitals').map((h) => {
    const beds = erBeds(state, h.id);
    let capacity = h.publicCapacity?.level ?? 'medium';
    let updatedAt = h.publicCapacity?.updatedAt ?? now;
    if (beds.length) {
      const ratio = selectAvailableBeds(state, h.id, now).length / beds.length;
      capacity = ratio >= 0.3 ? 'high' : ratio >= 0.1 ? 'medium' : 'low';
      updatedAt = now; // derived live from current bed readiness
    }
    return { id: h.id, name: h.name, nameAr: h.nameAr, shortName: h.shortName, position: { ...h.position },
      erOpen: h.publicCapacity?.erOpen !== false, services: [...h.services], capacity, updatedAt };
  });
}

// Nearest first by simulated distance only. Capacity never moves a farther hospital above a nearer one.
export function rankHospitals(list, point, mode) {
  return list.map((h) => ({ ...h, trip: simulatedTrip(point, h.position, mode) }))
    .sort((a, b) => a.trip.km - b.trip.km || a.name.localeCompare(b.name))
    .map((h, i) => ({ ...h, nearest: i === 0 }));
}

// A no-login citizen session sees only the cases its device submitted.
export function citizenCases(state, deviceRef) {
  if (!deviceRef) return [];
  return values(state, 'cases').filter((c) => c.deviceRef === deviceRef).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
}

// Citizen-safe view of one case (null unless this device owns it): status, destination, timeline, own report.
export function citizenCaseView(state, caseId, deviceRef) {
  const c = state.cases[caseId];
  if (!c || !deviceRef || c.deviceRef !== deviceRef) return null;
  const n = state.arrivalNotices[c.noticeId];
  const h = state.hospitals[c.destinationHospitalId];
  return {
    id: c.id, ref: c.ref, version: c.version, caseStatus: c.status, status: n?.status ?? 'submitted',
    destination: { id: h.id, name: h.name, shortName: h.shortName }, submittedAt: n?.submittedAt ?? c.createdAt,
    transportMode: n?.transportMode ?? 'unknown', etaAt: n?.etaAt ?? null, acknowledgedAt: n?.acknowledged?.at ?? null,
    timeline: [...(n?.timeline ?? [])].map(({ at, event, detail }) => ({ at, event, detail })),
    reported: { ...(n?.reported ?? {}) }, transcript: n?.transcript ?? null, cancelReason: c.cancelReason ?? null,
    clarifications: values(state, 'comments').filter((cm) => cm.caseId === c.id && cm.kind === 'clarification')
      .map((cm) => ({ id: cm.id, version: cm.version, question: cm.body, status: cm.status, answer: cm.answer, at: cm.createdAt })),
  };
}

export function deviceNotifications(state, deviceRef) {
  return values(state, 'notifications').filter((n) => n.to.deviceRef && n.to.deviceRef === deviceRef)
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
}

// Notices canceled before arrival in the last two hours, so the ER sees that an expected patient is no longer coming.
export function selectRecentlyCanceled(state, hospitalId, now, windowMinutes = 120) {
  return values(state, 'cases').filter((c) => c.status === 'canceled' && c.destinationHospitalId === hospitalId
    && ms(now) - ms(c.updatedAt) <= windowMinutes * 60000).sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
}

// ---------------------------------------------------------------------------
// Ambulance crews: a unit sees only the cases assigned to it
// ---------------------------------------------------------------------------
export function unitMembers(state, ambulanceId) {
  return values(state, 'users').filter((u) => u.role === 'paramedic' && u.ambulanceId === ambulanceId);
}

const unitOfCase = (state, c) => (c?.ambulanceAssignmentId ? state.ambulanceAssignments[c.ambulanceAssignmentId]?.ambulanceId ?? null : null);

export function crewCases(state, user) {
  if (user?.role !== 'paramedic' || !user.ambulanceId) return [];
  return values(state, 'cases').filter((c) => unitOfCase(state, c) === user.ambulanceId).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
}

// Permission scope for a crew read: the case belongs to every member of the unit it is assigned to.
export function crewScope(state, c) {
  const unit = unitOfCase(state, c);
  return { entity: 'case', hospitalId: c.destinationHospitalId, assignedUserIds: unit ? unitMembers(state, unit).map((u) => u.id) : [] };
}

// Full handover view of one case for its own crew (null for any other unit).
export function crewCaseView(state, caseId, user) {
  const c = state.cases[caseId];
  if (!c || !user || !can(user, 'viewCrewCase', crewScope(state, c)).allowed) return null;
  const n = state.arrivalNotices[c.noticeId];
  return {
    case: c, notice: n, patient: state.patients[c.patientId], assignment: state.ambulanceAssignments[c.ambulanceAssignmentId],
    destination: state.hospitals[c.destinationHospitalId], acknowledged: n?.acknowledged ?? null,
    clarifications: values(state, 'comments').filter((cm) => cm.caseId === c.id && cm.kind === 'clarification').sort((a, b) => ms(a.createdAt) - ms(b.createdAt)),
    reservation: values(state, 'reservations').find((r) => r.caseId === c.id && r.status === 'active') ?? null,
  };
}

// Audit log for the admin page, newest first, with optional filters.
export function auditLog(state, { userId = null, recordId = null, action = null, from = null, to = null } = {}) {
  return values(state, 'auditEvents')
    .filter((e) => (!userId || e.actorId === userId) && (!action || e.action === action)
      && (!recordId || e.refs?.some((r) => r.id === recordId) || e.changed?.includes(recordId))
      && (!from || ms(e.at) >= ms(from)) && (!to || ms(e.at) <= ms(to)))
    .sort((a, b) => ms(b.at) - ms(a.at));
}
