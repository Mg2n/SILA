// SILA — the ONE shared readiness derivation (SPEC §7), ICU bed candidates/suggestions, the ready-time forecast
// and read-only helpers. Availability is never stored; every screen and every action derives it from here.
// All user-facing text is returned as message codes ({ code, params }).

import { values, isOpenTask, isOpenTicket, ACTIVE_TRANSFER_STATUS } from './data.js';
import { msg, iso } from './messages.js';

const nowIso = () => new Date().toISOString();
const coordinatorRole = (dept) => (dept === 'ICU' ? 'icu_coordinator' : 'er_coordinator');
const later = (a, b) => (Date.parse(a) >= Date.parse(b) ? a : b);

const DEPT = { ER: msg('dept.ER'), ICU: msg('dept.ICU') };
const CLEANING_LOWER = { required: msg('cleaningLower.required'), assigned: msg('cleaningLower.assigned'), in_progress: msg('cleaningLower.in_progress') };
const TICKET_LOWER = { open: msg('ticketLower.open'), assigned: msg('ticketLower.assigned'), in_progress: msg('ticketLower.in_progress'), resolved: msg('ticketLower.resolved') };
const SEVERITY_LOWER = { low: msg('severityLower.low'), medium: msg('severityLower.medium'), high: msg('severityLower.high'), critical: msg('severityLower.critical') };
const EQUIP_LOWER = { monitor: msg('equipLower.monitor'), ventilator: msg('equipLower.ventilator'), infusion_pump: msg('equipLower.infusion_pump'), oxygen: msg('equipLower.oxygen') };
const CHECK_STATE = { failed: msg('checkState.failed'), invalid: msg('checkState.invalid'), missing: msg('checkState.missing') };
const REQUIREMENT_NEED = { isolation: msg('reqNeed.isolation'), ventilator: msg('reqNeed.ventilator'), monitor: msg('reqNeed.monitor') };
const NO_TEXT = msg('common.empty');

export function reservationState(res, now = nowIso()) {
  if (!res) return 'unreserved';
  if (res.status !== 'active') return res.status; // released | fulfilled | expired
  if (res.expiresAt && Date.parse(res.expiresAt) <= Date.parse(now)) return 'expired';
  return 'active';
}

export function activeReservationForBed(state, bedId, now = nowIso()) {
  return values(state, 'reservations').find((r) => r.bedId === bedId && reservationState(r, now) === 'active') ?? null;
}

export function activeReservationForCase(state, caseId, now = nowIso()) {
  return values(state, 'reservations').find((r) => r.caseId === caseId && reservationState(r, now) === 'active') ?? null;
}

export function openTicketsForBed(state, bedId) {
  return values(state, 'maintenanceTickets').filter((t) => t.bedId === bedId && isOpenTicket(t));
}

export function openTasksFor(state, predicate) {
  return values(state, 'tasks').filter((t) => isOpenTask(t) && predicate(t));
}

export function latestEquipmentCheck(state, bedId, equipment) {
  return values(state, 'equipmentChecks')
    .filter((c) => c.bedId === bedId && c.equipment === equipment)
    .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt) || b.id.localeCompare(a.id))[0] ?? null;
}

export function isCheckValid(check) {
  return !!check && check.result === 'passed' && !check.invalidatedAt;
}

export function confirmedStaffing(state, bedId) {
  return values(state, 'staffingAssignments').find((a) => a.bedId === bedId && a.status === 'confirmed') ?? null;
}

const workItem = (entity, rec) => (rec ? { entity, id: rec.id, dueAt: rec.dueAt ?? null } : null);

/**
 * deriveBedReadiness(bed, state[, now]) → { available, blockers: [{ type, description, ownerRole, ownerUser, since, workItem }] }
 * Available only if: vacant, cleaning complete/not required, no unresolved technical faults, no unresolved
 * equipment tickets, required equipment checks done, staffing confirmed, nursing readiness verified, not reserved.
 */
export function deriveBedReadiness(bed, state, now = nowIso()) {
  const blockers = [];
  const add = (b) => blockers.push({ ownerUser: null, workItem: null, ...b });
  const coord = coordinatorRole(bed.department);

  if (bed.occupancy.status === 'occupied') {
    const p = state.patients[bed.occupancy.patientId];
    const c = values(state, 'cases').find((x) => x.patientId === p?.id && x.status === 'active');
    const stepDown = c?.stepDown?.flagged;
    add({ type: 'occupied', ownerRole: coord, since: bed.occupancy.since,
      description: stepDown ? msg('blockerDesc.occupiedStepDown', { alias: p?.alias ?? '' }) : msg('blockerDesc.occupied', { alias: p?.alias ?? '' }),
      workItem: stepDown ? workItem('task', state.tasks[c.stepDown.taskId]) : null });
  }

  if (['required', 'assigned', 'in_progress'].includes(bed.cleaning.status)) {
    const t = openTasksFor(state, (x) => x.category === 'cleaning' && x.linked.bedId === bed.id)[0];
    const status = CLEANING_LOWER[bed.cleaning.status];
    add({ type: 'cleaning', ownerRole: 'housekeeping', ownerUser: t?.ownerUserId ?? null, since: bed.cleaning.since,
      description: t?.status === 'blocked'
        ? msg('blockerDesc.cleaningBlocked', { status, note: t.history.at(-1)?.note ?? '' })
        : msg('blockerDesc.cleaning', { status }),
      workItem: workItem('task', t) });
  }

  const tickets = openTicketsForBed(state, bed.id);
  for (const t of tickets) {
    const technical = t.kind === 'technical';
    add({ type: technical ? 'technical_fault' : 'equipment_ticket', ownerRole: technical ? 'maintenance_tech' : 'biomed_tech',
      ownerUser: t.assignedTo ?? null, since: t.reportedAt, workItem: workItem('maintenanceTicket', t),
      description: msg('blockerDesc.ticket', { ref: t.ref, category: t.category, description: t.description, status: TICKET_LOWER[t.status], severity: SEVERITY_LOWER[t.severity] }) });
  }

  for (const eq of bed.requiredEquipment) {
    const check = latestEquipmentCheck(state, bed.id, eq);
    if (isCheckValid(check)) continue;
    const ticket = tickets.find((t) => t.kind === 'equipment' && t.equipmentType === eq);
    const task = openTasksFor(state, (x) => x.category === 'equipment_check' && x.linked.bedId === bed.id && x.linked.equipment === eq)[0];
    const checkState = check ? (check.result === 'failed' ? CHECK_STATE.failed : CHECK_STATE.invalid) : CHECK_STATE.missing;
    add({ type: 'equipment_check', equipment: eq, ownerRole: 'biomed_tech', ownerUser: (ticket?.assignedTo ?? task?.ownerUserId) ?? null,
      since: check?.invalidatedAt ?? check?.checkedAt ?? bed.createdAt,
      description: msg('blockerDesc.check', { equipment: EQUIP_LOWER[eq], state: checkState, pending: ticket ? msg('blockerDesc.pendingTicket', { ref: ticket.ref }) : NO_TEXT }),
      workItem: ticket ? workItem('maintenanceTicket', ticket) : workItem('task', task) });
  }

  if (!confirmedStaffing(state, bed.id)) {
    const a = values(state, 'staffingAssignments').find((x) => x.bedId === bed.id);
    const t = openTasksFor(state, (x) => x.category === 'staffing' && x.linked.bedId === bed.id)[0];
    add({ type: 'staffing', ownerRole: coord, ownerUser: t?.ownerUserId ?? null, since: a?.updatedAt ?? bed.createdAt,
      description: a?.reason ? msg('blockerDesc.staffingReason', { reason: a.reason }) : msg('blockerDesc.staffing'), workItem: workItem('task', t) });
  }

  if (bed.occupancy.status === 'vacant' && bed.nursingVerification.status !== 'verified') {
    const t = openTasksFor(state, (x) => x.category === 'nursing_verification' && x.linked.bedId === bed.id)[0];
    add({ type: 'nursing_verification', ownerRole: 'nurse', ownerUser: t?.ownerUserId ?? confirmedStaffing(state, bed.id)?.nurseUserId ?? null,
      since: bed.nursingVerification.since, description: msg('blockerDesc.verification', { dept: DEPT[bed.department] }), workItem: workItem('task', t) });
  }

  const res = activeReservationForBed(state, bed.id, now);
  if (res) {
    const ref = state.cases[res.caseId]?.ref ?? res.caseId;
    add({ type: 'reserved', ownerRole: coord, ownerUser: res.createdBy, since: res.createdAt,
      description: res.expiresAt ? msg('blockerDesc.reserved', { ref }) : msg('blockerDesc.reservedHeld', { ref }) }); // expiry is shown separately
  }

  return { available: blockers.length === 0, blockers };
}

// Physical blockers are the ones nursing verification depends on (staffing and reservation are separate).
export const PHYSICAL_BLOCKERS = ['occupied', 'cleaning', 'technical_fault', 'equipment_ticket', 'equipment_check'];

/**
 * forecastReadyTime(bed, state[, now]) → { estimatedReadyAt, blockingStep, owner, isEstimate, summary }
 * Estimate only: the latest due time among open blocker work items. Any blocker without a due time → "Unknown".
 * A reservation is not readiness work, so it is reported separately as reservedUntil.
 */
export function forecastReadyTime(bed, state, now = nowIso()) {
  const { blockers } = deriveBedReadiness(bed, state, now);
  const work = blockers.filter((b) => b.type !== 'reserved');
  const reserved = blockers.find((b) => b.type === 'reserved');
  const reservedUntil = reserved ? (activeReservationForBed(state, bed.id, now)?.expiresAt ?? null) : null;
  const owner = (b) => ({ role: b.ownerRole, userId: b.ownerUser });
  const step = (b) => ({ type: b.type, description: b.description });

  if (!work.length) {
    return { estimatedReadyAt: now, blockingStep: null, owner: null, isEstimate: true, reservedUntil,
      summary: reserved ? msg('forecast.readyNowReserved') : msg('forecast.readyNow') };
  }
  const undated = work.find((b) => !b.workItem?.dueAt);
  if (undated) {
    return { estimatedReadyAt: null, blockingStep: step(undated), owner: owner(undated), isEstimate: true, reservedUntil,
      summary: msg('forecast.unknown', { step: undated.description }) };
  }
  const last = work.reduce((a, b) => (Date.parse(b.workItem.dueAt) > Date.parse(a.workItem.dueAt) ? b : a));
  const overdue = Date.parse(last.workItem.dueAt) < Date.parse(now);
  const estimatedReadyAt = later(last.workItem.dueAt, now);
  return { estimatedReadyAt, blockingStep: step(last), owner: owner(last), isEstimate: true, overdue, reservedUntil,
    summary: overdue ? msg('forecast.estimateOverdue', { time: iso(estimatedReadyAt), step: last.description }) : msg('forecast.estimate', { time: iso(estimatedReadyAt), step: last.description }) };
}

// ---------------------------------------------------------------------------
// ICU capacity: compatibility, candidate beds and suggestions
// ---------------------------------------------------------------------------
export const REQUIREMENT_KEYS = ['isolation', 'ventilator', 'monitor'];

export function compatibilityError(bed, requirements = {}) {
  const missing = REQUIREMENT_KEYS.find((k) => requirements?.[k] && !bed.capabilities[k]);
  return missing ? msg('err.incompatible', { bed: bed.label, need: REQUIREMENT_NEED[missing] }) : null;
}

// Why a bed cannot be confirmed as capacity for this transfer (null when it can).
export function icuBedProblem(s, tr, bed, now = nowIso()) {
  if (!bed || bed.department !== 'ICU' || bed.hospitalId !== tr.hospitalId) return msg('err.notIcuBed');
  if (bed.occupancy.status !== 'vacant') return msg('err.bedOccupied', { bed: bed.label, alias: s.patients[bed.occupancy.patientId]?.alias ?? '' });
  const res = activeReservationForBed(s, bed.id, now);
  if (res) return msg('err.bedReservedFor', { bed: bed.label, ref: s.cases[res.caseId]?.ref ?? '' });
  const other = values(s, 'transferRequests').find((t) => t.id !== tr.id && ACTIVE_TRANSFER_STATUS.includes(t.status) && t.targetBedId === bed.id);
  if (other) return msg('err.bedTargeted', { bed: bed.label, ref: other.ref });
  return compatibilityError(bed, tr.requirements);
}

// Compatible, vacant, unreserved ICU beds not confirmed for another transfer; fewest blockers first.
export function icuCandidates(s, tr, now = nowIso()) {
  return values(s, 'beds')
    .filter((b) => b.hospitalId === tr.hospitalId && b.department === 'ICU' && !icuBedProblem(s, tr, b, now))
    .map((b) => ({ b, n: deriveBedReadiness(b, s, now).blockers.length }))
    .sort((x, y) => x.n - y.n || x.b.label.localeCompare(y.b.label))
    .map((x) => x.b);
}

// Suggested bed per accepted transfer still waiting for capacity confirmation. Oldest request first, so a bed
// freed by a step-down departure goes to the oldest waiting request. Advisory only: the ICU coordinator confirms.
export function suggestedBeds(s, hospitalId, now = nowIso()) {
  const waiting = values(s, 'transferRequests')
    .filter((t) => t.hospitalId === hospitalId && t.status === 'accepted' && !t.targetBedId)
    .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  const taken = new Set();
  const out = {};
  for (const tr of waiting) {
    const bed = icuCandidates(s, tr, now).find((b) => !taken.has(b.id)) ?? null;
    out[tr.id] = bed?.id ?? null;
    if (bed) taken.add(bed.id);
  }
  return out;
}

export function suggestedBedFor(s, tr, now = nowIso()) {
  return suggestedBeds(s, tr.hospitalId, now)[tr.id] ?? null;
}

// ---------------------------------------------------------------------------
// Read-only helpers
// ---------------------------------------------------------------------------
export function activeCaseForPatient(state, patientId) {
  return values(state, 'cases').find((c) => c.patientId === patientId && c.status === 'active') ?? null;
}

export function activeTransferForCase(state, caseId) {
  return values(state, 'transferRequests').find((t) => t.caseId === caseId && ACTIVE_TRANSFER_STATUS.includes(t.status)) ?? null;
}

const DEPARTED = { discharge: msg('loc.departed.discharge'), admit_ward: msg('loc.departed.admit_ward'), step_down: msg('loc.departed.step_down') };
export function describeLocation(state, patient) {
  const l = patient.location;
  switch (l.kind) {
    case 'bed': return msg('loc.bed', { bed: state.beds[l.bedId]?.label ?? '' });
    case 'in_transit': return msg('loc.inTransit', { to: state.beds[l.toBedId]?.label ?? '' });
    case 'er_waiting': return msg('loc.erWaiting');
    case 'unit_arrival': return msg('loc.unitArrival', { dept: DEPT[l.department] ?? NO_TEXT });
    case 'pre_hospital': return msg('loc.preHospital');
    case 'departed': return DEPARTED[l.reason] ?? msg('loc.departed.other');
    default: return msg('loc.offSite');
  }
}

export function deriveTransferStatus(tr, state, now = nowIso()) {
  const bed = tr.targetBedId ? state.beds[tr.targetBedId] : null;
  switch (tr.status) {
    case 'requested': return { key: 'review', label: msg('trStatus.pendingReview'), ownerRole: 'doctor', ownerDepartment: 'ICU', reason: msg('trReason.awaitingIntensivist') };
    case 'declined': return { key: 'declined', label: msg('trStatus.declined'), ownerRole: 'doctor', ownerDepartment: 'ER', reason: msg('common.text', { text: tr.clinicalDecision?.reason ?? '' }) };
    case 'canceled': return { key: 'canceled', label: msg('trStatus.canceled'), ownerRole: null, reason: msg('common.text', { text: tr.cancelReason ?? '' }) };
    case 'accepted': {
      if (!bed) {
        const suggested = suggestedBedFor(state, tr, now);
        return { key: 'capacity', label: msg('trStatus.waitingCapacity'), ownerRole: 'icu_coordinator', suggestedBedId: suggested,
          reason: suggested ? msg('trReason.suggested', { bed: state.beds[suggested].label }) : msg('trReason.noCompatibleBed') };
      }
      const { available, blockers } = deriveBedReadiness(bed, state, now);
      if (available) return { key: 'reserve', label: msg('trStatus.readyToReserve', { bed: bed.label }), ownerRole: 'icu_coordinator', reason: msg('trReason.reserve') };
      return { key: 'prep', label: msg('trStatus.preparing', { bed: bed.label }), ownerRole: blockers[0].ownerRole, ownerUser: blockers[0].ownerUser,
        reason: blockers[0].description, blockerCount: blockers.length };
    }
    case 'reserved': return { key: 'handover', label: msg('trStatus.reserved', { bed: bed?.label ?? '' }), ownerRole: 'er_coordinator', reason: msg('trReason.handoverDeparture') };
    case 'in_transit': return { key: 'transit', label: msg('trStatus.inTransit'), ownerRole: tr.porterUserId ? 'porter' : 'icu_coordinator', ownerUser: tr.porterUserId, reason: msg('trReason.confirmArrival') };
    case 'arrived': return { key: 'arrived', label: msg('trStatus.arrived'), ownerRole: 'icu_coordinator', reason: msg('trReason.confirmPlacement', { bed: bed?.label ?? '' }) };
    default: return { key: 'placed', label: msg('trStatus.completed', { bed: bed?.label ?? '' }), ownerRole: null, reason: NO_TEXT };
  }
}

export function incomingCases(state, hospitalId) {
  return values(state, 'cases').filter((c) => c.status === 'active' && c.destinationHospitalId === hospitalId
    && state.patients[c.patientId]?.location.kind === 'pre_hospital');
}

export function expectedToFreeSoon(state, hospitalId) {
  return values(state, 'beds').filter((b) => b.hospitalId === hospitalId && b.department === 'ICU' && b.occupancy.status === 'occupied'
    && activeCaseForPatient(state, b.occupancy.patientId)?.stepDown?.flagged);
}

export function notificationsFor(state, user) {
  return values(state, 'notifications').filter((n) => (n.to.userId ? n.to.userId === user.id
    : n.to.role === user.role && (!n.to.hospitalId || n.to.hospitalId === user.hospitalId) && (!n.to.department || n.to.department === user.department)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function myTasks(state, user) {
  return values(state, 'tasks').filter((t) => isOpenTask(t) && t.hospitalId === user.hospitalId && t.requiredRole === user.role
    && (!t.department || !['nurse', 'doctor'].includes(user.role) || t.department === user.department)
    && (!t.ownerUserId || t.ownerUserId === user.id));
}
