// SILA — the single mutation entry point. dispatch(actionName, payload, user) → { ok, error?, code?, changed: [ids] }
// Every action runs, in order: (a) permission check, (b) expectedVersion check against the re-read record,
// (c) state-transition validation, (d) mutation with version bumps, (e) audit event, (f) notifications and
// follow-up tasks. Work happens on a structured clone; invariants are checked before anything is committed.
// Every user-facing text (errors, reasons, titles, notifications, audit summaries) is a message { code, params }.

import {
  COLLECTION_OF, SLA_MINUTES, RESERVATION_MINUTES, ACTIVE_TRANSFER_STATUS, DIAGNOSTIC_TYPES,
  addMinutes, nextId, nextRef, values, isOpenTask, isOpenTicket, checkInvariants,
} from './data.js';
import {
  msg, iso, DEPT_MSG, ROLE_MSG, CASE_STATUS_MSG, TRANSFER_STATUS_MSG, TASK_STATUS_MSG, TICKET_STATUS_MSG, RESERVATION_STATE_MSG,
  EQUIP_MSG, DIAG_MSG, SEVERITY_MSG, BLOCKER_TYPE_MSG, SOURCE_MSG, WHY_MSG, DECISION_MSG, NOTICE_STATUS_MSG, NO_TEXT,
} from './messages.js';
import { can } from './permissions.js';
import { vitalProblem, normalizeReading } from './vitals.js';
import {
  deriveBedReadiness, reservationState, activeReservationForBed, activeReservationForCase, openTasksFor, openTicketsForBed,
  latestEquipmentCheck, isCheckValid, confirmedStaffing, activeTransferForCase, PHYSICAL_BLOCKERS, compatibilityError,
  icuBedProblem, suggestedBeds, suggestedBedFor,
} from './readiness.js';

const ACTIONS = {};
const action = (name, def) => { ACTIONS[name] = def; };
export const ACTION_NAMES = () => Object.keys(ACTIONS);

// The record whose version an action checks (null for creates). The UI uses it to fill expectedVersion.
export function targetOf(state, actionName, payload = {}) {
  const def = ACTIONS[actionName];
  const t = def?.target ? def.target(state, payload) : null;
  return t?.noVersion ? null : t?.rec ?? null;
}

// Read-only check of steps (a) permission and (c) transition rules, without the version check or any mutation.
// The UI uses it to disable buttons and show the engine's own reason. `permissionOnly` skips (c) for actions
// whose form (e.g. a required reason) has not been filled in yet.
export function preflight(state, actionName, payload, user, now = new Date().toISOString(), { permissionOnly = false } = {}) {
  const def = ACTIONS[actionName];
  if (!def) return { ok: false, code: 'invalid', reason: msg('err.unknownAction', { action: actionName }) };
  const actor = state.users[typeof user === 'string' ? user : user?.id];
  if (!actor) return { ok: false, code: 'forbidden', reason: msg('err.unknownUser') };
  const p = payload ?? {};
  const target = def.target ? def.target(state, p, actor) : null;
  if (target && target.missing) return { ok: false, code: 'not_found', reason: target.missing };
  const rec = target?.rec ?? null;
  const perm = can(actor, actionName, def.scope ? def.scope(state, rec, p, actor) : {});
  if (!perm.allowed) return { ok: false, code: 'forbidden', reason: perm.reason };
  if (permissionOnly) return { ok: true, code: null, reason: null };
  const invalid = def.validate ? def.validate(state, rec, p, actor, now) : null;
  return invalid ? { ok: false, code: 'invalid', reason: invalid } : { ok: true, code: null, reason: null };
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------
class Tx {
  constructor(state, actor, now) {
    this.s = structuredClone(state);
    this.actor = actor;
    this.now = now;
    this.bumped = new Set();
    this.changed = new Set();
    this.phase = 'mutate';
    this.queue = [];
  }

  // Follow-up work requested during the mutation step runs in step (f), after the audit event.
  later(fn) {
    if (this.phase === 'mutate') this.queue.push(fn);
    else fn();
  }

  runFollowUps() {
    this.phase = 'effects';
    for (const fn of this.queue.splice(0)) fn();
  }

  // Bump a record's version once per action and mark it changed.
  touch(rec) {
    if (!this.bumped.has(rec.id)) { rec.version += 1; this.bumped.add(rec.id); }
    rec.updatedAt = this.now;
    this.changed.add(rec.id);
    return rec;
  }

  update(rec, patch) {
    this.touch(rec);
    Object.assign(rec, patch);
    return rec;
  }

  create(entity, fields, prefix = entity) {
    const id = fields.id ?? nextId(this.s, prefix);
    const rec = { id, entity, version: 1, createdAt: this.now, updatedAt: this.now, ...fields };
    this.s[COLLECTION_OF[entity]][id] = rec;
    this.bumped.add(id);
    this.changed.add(id);
    return rec;
  }

  notify(to, type, message, ref, urgent = false) {
    this.later(() => this.create('notification', { to, type, message, ref, urgent, readBy: [] }, 'n'));
  }

  task({ dueMinutes, ...fields }) {
    const status = fields.status ?? 'open';
    return this.create('task', {
      linked: {}, ownerUserId: null, ownerTeam: null, priority: 'normal', completionNotes: null, department: null,
      dueAt: dueMinutes != null ? addMinutes(this.now, dueMinutes) : null, ...fields, status,
      history: [{ at: this.now, by: this.actor.id, status, note: null }],
    }, 'task');
  }

  // `note` is user text (string) or a system message.
  setTaskStatus(task, status, note = null) {
    this.update(task, { status });
    task.history = [...task.history, { at: this.now, by: this.actor.id, status, note }];
    if (status === 'done' || status === 'canceled') task.completionNotes = note;
    return task;
  }

  timeline(notice, event, detail) {
    this.touch(notice);
    notice.timeline = [...notice.timeline, { at: this.now, by: this.actor.id, event, detail }];
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const fail = (code, error) => ({ ok: false, code, error, changed: [] });

// "bed ER-04" / "Bed ER-04" etc. as messages (the capitalised form starts a sentence).
function recordName(rec, capital = false) {
  switch (rec.entity) {
    case 'bed': return capital ? msg('recCap.bed', { label: rec.label }) : msg('rec.bed', { label: rec.label });
    case 'case': return capital ? msg('recCap.case', { ref: rec.ref }) : msg('rec.case', { ref: rec.ref });
    case 'maintenanceTicket': return capital ? msg('recCap.ticket', { ref: rec.ref }) : msg('rec.ticket', { ref: rec.ref });
    case 'transferRequest': return capital ? msg('recCap.transfer', { ref: rec.ref }) : msg('rec.transfer', { ref: rec.ref });
    case 'task': return capital ? msg('recCap.task', { title: rec.title }) : msg('rec.task', { title: rec.title });
    default: return capital ? msg('recCap.other', { id: rec.id }) : msg('rec.other', { id: rec.id });
  }
}

/** Pure core: returns { ok, error?, code?, changed, state? } without touching the input state. */
export function applyAction(state, actionName, payload, user, now = new Date().toISOString()) {
  const def = ACTIONS[actionName];
  if (!def) return fail('invalid', msg('err.unknownAction', { action: actionName }));
  const actor = state.users[typeof user === 'string' ? user : user?.id];
  if (!actor) return fail('forbidden', msg('err.unknownUser'));
  const p = payload ?? {};

  const target = def.target ? def.target(state, p, actor) : null;
  if (target && target.missing) return fail('not_found', target.missing);
  const rec = target?.rec ?? null;
  const versioned = rec && !target.noVersion; // context-only targets (e.g. a comment's subject) are not changed

  // (a) permission — evaluated against the live record's scope.
  const perm = can(actor, actionName, def.scope ? def.scope(state, rec, p, actor) : {});
  if (!perm.allowed) return fail('forbidden', perm.reason);

  // (b) optimistic concurrency on the re-read record.
  if (versioned) {
    if (p.expectedVersion === undefined || p.expectedVersion === null) {
      return fail('invalid', msg('version.required', { record: recordName(rec), current: rec.version }));
    }
    if (p.expectedVersion !== rec.version) {
      return fail('conflict', msg('version.conflict', { record: recordName(rec, true), seen: p.expectedVersion, current: rec.version }));
    }
  }

  // (c) state-transition validation.
  const invalid = def.validate ? def.validate(state, rec, p, actor, now) : null;
  if (invalid) return fail('invalid', invalid);

  // (d) mutate on a clone; the primary record always gets a version bump.
  const tx = new Tx(state, actor, now);
  const live = rec ? tx.s[COLLECTION_OF[rec.entity]][rec.id] : null;
  if (live && versioned) tx.touch(live);
  const ctx = def.apply(tx, live, p, actor) ?? {};

  // (e) audit — who / what / when / reason.
  const audit = tx.create('auditEvent', {
    at: now, actorId: actor.id, actorName: actor.name, actorRole: actor.role, action: actionName,
    summary: ctx.summary ?? msg('audit.generic', { action: actionName }), reason: ctx.reason ?? p.reason ?? null, details: ctx.details ?? null,
    refs: ctx.refs ?? (live ? [{ entity: live.entity, id: live.id }] : []), changed: [],
  }, 'audit');
  delete audit.version; // audit events are immutable and unversioned
  audit.changed = [...tx.changed].filter((id) => id !== audit.id);
  const beforeEffects = new Set(tx.changed);

  // (f) notifications and follow-up tasks.
  tx.runFollowUps();
  if (def.effects) def.effects(tx, live, p, actor, ctx);
  audit.followUps = [...tx.changed].filter((id) => !beforeEffects.has(id));

  const problems = checkInvariants(tx.s);
  if (problems.length) return fail('invalid', msg('err.consistency', { details: problems.join('; ') }));
  tx.s.meta.rev = (tx.s.meta.rev ?? 0) + 1;
  return { ok: true, changed: [...tx.changed], result: ctx.result ?? null, state: tx.s };
}

// The engine binding: the store wires its persisted state in; tests can bind an in-memory holder.
let engine = null;
export function bindEngine({ getState, commit, now = () => new Date().toISOString() }) {
  engine = { getState, commit, now };
}
export function memoryEngine(state, now) {
  let current = state;
  bindEngine({ getState: () => current, commit: (s) => { current = s; }, now });
  return { getState: () => current };
}

export function dispatch(actionName, payload, user) {
  if (!engine) return fail('invalid', msg('err.notBound'));
  const res = applyAction(engine.getState(), actionName, payload, user, engine.now());
  if (!res.ok) return { ok: false, code: res.code, error: res.error, changed: [] };
  engine.commit(res.state, { action: actionName, changed: res.changed });
  return { ok: true, changed: res.changed, result: res.result };
}

// ---------------------------------------------------------------------------
// Lookups and scopes
// ---------------------------------------------------------------------------
const NOT_FOUND = {
  case: msg('notFound.case'), bed: msg('notFound.bed'), transferRequest: msg('notFound.transfer'), maintenanceTicket: msg('notFound.ticket'),
  task: msg('notFound.task'), reservation: msg('notFound.reservation'), comment: msg('notFound.clarification'),
  notification: msg('notFound.notification'), patient: msg('notFound.patient'),
};
const find = (state, entity, id) => {
  const rec = id ? state[COLLECTION_OF[entity]][id] : null;
  return rec ? { rec } : { missing: NOT_FOUND[entity] };
};

// The crew of a case is every member of the assigned ambulance unit (plus anyone recorded on the assignment).
const crewOf = (s, c) => {
  const a = c.ambulanceAssignmentId ? s.ambulanceAssignments[c.ambulanceAssignmentId] : null;
  if (!a) return [];
  const unit = values(s, 'users').filter((u) => u.role === 'paramedic' && u.ambulanceId === a.ambulanceId).map((u) => u.id);
  return [...new Set([...(a.crewUserIds ?? []), ...unit])];
};
const caseParties = (s, c) => [...new Set([c.submittedBy, ...crewOf(s, c)].filter(Boolean))];
const patientOf = (s, c) => s.patients[c.patientId];
const currentDept = (s, c) => patientOf(s, c)?.location.department ?? 'ER';
const caseOfPatient = (s, pid) => values(s, 'cases').find((c) => c.patientId === pid && c.status === 'active') ?? null;

const caseScope = (s, c, p = {}) => ({ entity: 'case', hospitalId: c.destinationHospitalId, department: currentDept(s, c), assignedUserIds: caseParties(s, c),
  ownerDevice: c.deviceRef ?? null, requesterDevice: p?.deviceRef ?? null });
// Notification targets for a case's submitter and crew; a shared citizen session is addressed by its device.
const partyTargets = (s, c) => caseParties(s, c).map((uid) => (s.users[uid]?.shared ? (c.deviceRef ? { deviceRef: c.deviceRef } : null) : { userId: uid })).filter(Boolean);
const bedScope = (s, b) => ({ entity: 'bed', hospitalId: b.hospitalId, department: b.department });
const ticketScope = (s, t) => ({ entity: 'maintenanceTicket', hospitalId: t.hospitalId, department: t.department, ticketKind: t.kind });
const transferScope = (s, t) => ({ entity: 'transferRequest', hospitalId: t.hospitalId, department: 'ICU', porterUserId: t.porterUserId });

const hospitalName = (s, id) => s.hospitals[id]?.shortName ?? id;
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const validIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
// A list of blockers for an error message: "description (owner: Role)" items.
const blockerItems = (blockers) => blockers.map((b) => msg('blockerItem', { description: b.description, owner: ROLE_MSG[b.ownerRole] }));
const blockerTypes = (blockers) => blockers.map((b) => BLOCKER_TYPE_MSG[b.type]);

const toCoordinators = (hospitalId, dept) => ({ role: dept === 'ICU' ? 'icu_coordinator' : 'er_coordinator', hospitalId });
const toRole = (role, hospitalId, department) => (department ? { role, hospitalId, department } : { role, hospitalId });

// ---------------------------------------------------------------------------
// Shared state transitions (only ever called from inside an action's apply/effects)
// ---------------------------------------------------------------------------

// Nursing verification is a sign-off on the current physical state; any new blocker on a vacant bed resets it.
// ER beds get an eager verification task; ICU prep tasks are only created after capacity is confirmed for a transfer.
function resetVerification(tx, bed, why) {
  if (bed.occupancy.status !== 'vacant') return;
  if (bed.nursingVerification.status === 'verified') {
    tx.update(bed, { nursingVerification: { status: 'pending', by: null, at: null, since: tx.now, reason: why } });
  }
  if (bed.department !== 'ER') return;
  tx.later(() => {
    if (openTasksFor(tx.s, (t) => t.category === 'nursing_verification' && t.linked.bedId === bed.id).length) return;
    tx.task({ category: 'nursing_verification', title: msg('taskTitle.verify', { bed: bed.label }), linked: { bedId: bed.id },
      requiredRole: 'nurse', department: bed.department, hospitalId: bed.hospitalId,
      ownerUserId: confirmedStaffing(tx.s, bed.id)?.nurseUserId ?? null, dueMinutes: SLA_MINUTES.nursing_verification });
  });
}

function placeInBed(tx, patient, bed, caseRec) {
  tx.update(bed, { occupancy: { status: 'occupied', patientId: patient.id, since: tx.now } });
  tx.update(patient, { location: { kind: 'bed', hospitalId: bed.hospitalId, department: bed.department, bedId: bed.id, since: tx.now } });
  return tx.create('placement', { patientId: patient.id, caseId: caseRec.id, bedId: bed.id, hospitalId: bed.hospitalId,
    status: 'active', startedAt: tx.now, endedAt: null, placedBy: tx.actor.id }, 'pl');
}

// Physical departure from a bed: vacant, placement ended, cleaning required (with a task), verification reset.
// ICU turnover also needs the ventilator re-checked (circuit change between patients).
function vacateBed(tx, bed, why) {
  const placement = values(tx.s, 'placements').find((pl) => pl.bedId === bed.id && pl.status === 'active');
  if (placement) tx.update(placement, { status: 'ended', endedAt: tx.now, endedBy: tx.actor.id });
  tx.update(bed, { occupancy: { status: 'vacant', patientId: null, since: tx.now }, cleaning: { status: 'required', since: tx.now, taskId: null } });
  if (bed.department === 'ICU') {
    const vent = latestEquipmentCheck(tx.s, bed.id, 'ventilator');
    if (isCheckValid(vent)) tx.update(vent, { invalidatedAt: tx.now, invalidatedReason: msg('check.invalidatedTurnover') });
  }
  tx.later(() => {
    const clean = tx.task({ category: 'cleaning', title: msg('taskTitle.clean', { bed: bed.label, why }), linked: { bedId: bed.id },
      requiredRole: 'housekeeping', ownerTeam: 'housekeeping', priority: 'high', department: bed.department,
      hospitalId: bed.hospitalId, dueMinutes: SLA_MINUTES.cleaning });
    bed.cleaning = { ...bed.cleaning, taskId: clean.id };
  });
  resetVerification(tx, bed, msg('why.vacated', { why }));
  tx.notify(toRole('housekeeping', bed.hospitalId), 'cleaning_required', msg('notifMsg.cleaningRequired', { bed: bed.label }), { entity: 'bed', id: bed.id });
}

// A reservation past its expiry keeps status "active" until something needs the slot; then it is closed as expired.
function expireStale(tx, predicate) {
  for (const r of values(tx.s, 'reservations')) {
    if (r.status === 'active' && reservationState(r, tx.now) === 'expired' && predicate(r)) tx.update(r, { status: 'expired', expiredAt: r.expiresAt });
  }
}

// Releases a reservation (including one past its expiry) through the normal workflow. `reason`: user text or message.
function releaseReservationFor(tx, res, reason) {
  tx.update(res, { status: 'released', releasedAt: tx.now, releasedBy: tx.actor.id, releaseReason: reason });
  if (res.transferId) {
    const tr = tx.s.transferRequests[res.transferId];
    if (tr && tr.status === 'reserved') {
      tx.update(tr, { status: 'accepted', reservationId: null });
      for (const id of tr.handoverTaskIds) {
        const t = tx.s.tasks[id];
        if (t && isOpenTask(t)) tx.setTaskStatus(t, 'canceled', msg('note.reservationReleased', { reason }));
      }
    }
  }
  const bed = tx.s.beds[res.bedId];
  tx.notify(toCoordinators(res.hospitalId, res.department), 'reservation_released', msg('notifMsg.reservationReleased', { bed: bed.label, reason }), { entity: 'bed', id: bed.id });
  return res;
}

function anyActiveReservationRecord(s, caseId) {
  return values(s, 'reservations').find((r) => r.caseId === caseId && r.status === 'active') ?? null;
}

function cancelCaseTasks(tx, caseId, note) {
  for (const t of openTasksFor(tx.s, (x) => x.linked.caseId === caseId)) tx.setTaskStatus(t, 'canceled', note);
}

// Bed-prep work once capacity is confirmed: link existing work items, create the missing ones (marked prepFor so a
// canceled request can withdraw them). Never runs before clinical acceptance and capacity confirmation.
function createPrepItems(tx, tr, bed) {
  const items = [];
  const link = (task) => {
    tx.update(task, { linked: { ...task.linked, transferId: tr.id } });
    items.push({ entity: 'task', id: task.id });
  };
  const ensureTask = (category, predicate, fields) => {
    const existing = openTasksFor(tx.s, (t) => t.category === category && t.linked.bedId === bed.id && predicate(t))[0];
    if (existing) return link(existing);
    const t = tx.task({ category, linked: { bedId: bed.id, transferId: tr.id }, hospitalId: bed.hospitalId, department: bed.department,
      priority: 'high', prepFor: tr.id, ...fields });
    items.push({ entity: 'task', id: t.id });
    tx.notify(fields.requiredRole === 'nurse' ? toRole('nurse', bed.hospitalId, 'ICU') : toRole(fields.requiredRole, bed.hospitalId),
      'prep_task', t.title, { entity: 'task', id: t.id });
  };
  for (const b of deriveBedReadiness(bed, tx.s, tx.now).blockers) {
    if (b.type === 'cleaning') ensureTask('cleaning', () => true, { title: msg('taskTitle.cleanFor', { bed: bed.label, ref: tr.ref }), requiredRole: 'housekeeping', ownerTeam: 'housekeeping', dueMinutes: SLA_MINUTES.cleaning });
    if (b.type === 'technical_fault' || b.type === 'equipment_ticket') {
      const ticket = tx.s.maintenanceTickets[b.workItem.id];
      tx.update(ticket, { linkedTransferId: tr.id });
      items.push({ entity: 'maintenanceTicket', id: ticket.id });
    }
    if (b.type === 'equipment_check' && b.workItem?.entity !== 'maintenanceTicket') {
      const eq = b.equipment;
      ensureTask('equipment_check', (t) => t.linked.equipment === eq, { title: msg('taskTitle.checkFor', { equipment: EQUIP_MSG[eq], bed: bed.label, ref: tr.ref }),
        requiredRole: 'biomed_tech', linked: { bedId: bed.id, transferId: tr.id, equipment: eq }, dueMinutes: SLA_MINUTES.equipment_check });
    }
    if (b.type === 'staffing') ensureTask('staffing', () => true, { title: msg('taskTitle.staffFor', { bed: bed.label, ref: tr.ref }), requiredRole: 'icu_coordinator', dueMinutes: SLA_MINUTES.staffing });
    if (b.type === 'nursing_verification') ensureTask('nursing_verification', () => true, { title: msg('taskTitle.verifyFor', { bed: bed.label, ref: tr.ref }),
      requiredRole: 'nurse', ownerUserId: confirmedStaffing(tx.s, bed.id)?.nurseUserId ?? null, dueMinutes: SLA_MINUTES.nursing_verification });
  }
  tx.update(tr, { prepItems: [...(tr.prepItems ?? []), ...items] });
  return items;
}

// ===========================================================================
// Arrival notices and cases (citizen / ambulance → ER board)
// ===========================================================================
const ICU_REQUEST_FIELDS = ['icuRequest', 'requestIcu', 'icuTransfer', 'transferToIcu', 'icuAdmission'];
const REPORTED_FIELDS = ['ageText', 'concern', 'onset', 'awake', 'breathing', 'awakeBreathing', 'conditions', 'allergies', 'patientCount', 'location', 'contact', 'accessibilityNeeds'];
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const caseStatusError = (c) => msg('err.caseStatus', { ref: c.ref, status: CASE_STATUS_MSG[c.status] });

const CREW_ACUITY = ['critical', 'high', 'moderate', 'low'];
const SEXES = ['female', 'male', 'unknown'];
const HANDOVER_TEXT = ['history', 'allergies', 'receivingRequirements', 'crewNotes'];
const REQ_KEYS = ['isolation', 'ventilator', 'monitor'];
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Every new reading must be well-formed and physically possible; readings already sent are kept as they were.
function vitalsError(p, existing, now) {
  const known = new Set((existing ?? []).map((v) => v.id));
  for (const r of p.vitals ?? []) {
    if (r.id && known.has(r.id)) continue;
    const problem = vitalProblem(r, now);
    if (problem) return problem;
  }
  return null;
}

action('submitArrival', {
  // Create a new notice, or — when the same device resends (same caseId or clientRef) — update it without duplicating.
  target: (s, p) => {
    if (p.caseId) return find(s, 'case', p.caseId);
    const existing = p.clientRef && values(s, 'arrivalNotices').find((n) => n.clientRef === p.clientRef);
    return existing ? { rec: s.cases[existing.caseId] } : null;
  },
  scope: (s, c, p) => (c ? caseScope(s, c, p) : {}),
  validate: (s, c, p, actor, now) => {
    if (ICU_REQUEST_FIELDS.some((k) => p[k]) || p.requirements?.icu) return msg('err.arrivalNoIcu');
    if (p.etaAt !== undefined && p.etaAt !== null && !validIso(p.etaAt)) return msg('err.etaInvalid');
    if (actor.role === 'paramedic' && !actor.ambulanceId) return msg('err.crewNoAmbulance');
    if (actor.shared && !c && !nonEmpty(p.deviceRef)) return msg('err.deviceRequired');
    if (p.crewAcuity !== undefined && p.crewAcuity !== null && !CREW_ACUITY.includes(p.crewAcuity)) return msg('err.crewAcuity');
    if (p.sex !== undefined && p.sex !== null && !SEXES.includes(p.sex)) return msg('err.sex');
    if (p.approxAge !== undefined && p.approxAge !== null && !(Number.isInteger(p.approxAge) && p.approxAge >= 0 && p.approxAge <= 120)) return msg('err.approxAge');
    if (p.vitals !== undefined && !Array.isArray(p.vitals)) return msg('err.vitalType');
    if (c) {
      if (c.status !== 'active') return msg('err.caseClosedForUpdate', { ref: c.ref, status: CASE_STATUS_MSG[c.status] });
      if (patientOf(s, c).location.kind !== 'pre_hospital') return msg('err.caseArrivedUpdate', { ref: c.ref });
      if (p.destinationHospitalId && p.destinationHospitalId !== c.destinationHospitalId) return msg('err.useChangeDestination');
      return vitalsError(p, s.arrivalNotices[c.noticeId]?.handover?.vitals, now);
    }
    if (!s.hospitals[p.destinationHospitalId]) return msg('err.chooseDestination');
    if (!nonEmpty(p.concern)) return msg('err.describeConcern');
    return vitalsError(p, [], now);
  },
  apply: (tx, c, p, actor) => {
    const crew = actor.role === 'paramedic';
    const newReadings = (existing) => {
      const known = new Set(existing.map((v) => v.id));
      return (p.vitals ?? []).filter((r) => !r.id || !known.has(r.id)).map((r) => normalizeReading(r, actor.id, nextId(tx.s, 'vs')));
    };

    if (c) {
      const notice = tx.s.arrivalNotices[c.noticeId];
      const before = structuredClone({ reported: notice.reported, handover: notice.handover, etaAt: notice.etaAt, requirements: c.requirements, crewAcuity: c.crewAcuity, transcript: notice.transcript });
      const added = crew ? newReadings(notice.handover?.vitals ?? []) : [];
      const handover = crew ? {
        ...notice.handover,
        ...pick(p, HANDOVER_TEXT),
        ...(p.interventions ? { interventions: [...p.interventions] } : {}),
        ...(p.crewAcuity ? { crewAcuity: { level: p.crewAcuity, source: 'crew' } } : {}),
        vitals: [...(notice.handover?.vitals ?? []), ...added], // readings over time are appended, never overwritten
      } : notice.handover;
      tx.update(notice, {
        reported: { ...notice.reported, ...pick(p, REPORTED_FIELDS) },
        handover,
        transcript: p.transcript ?? notice.transcript,
        etaAt: p.etaAt ?? notice.etaAt,
        revision: notice.revision + 1,
      });
      if (p.concern) c.reportedConcern = p.concern;
      if (crew && p.crewAcuity) c.crewAcuity = { level: p.crewAcuity, source: 'crew' }; // never touches the staff triage field
      if (crew && p.requirements) c.requirements = { ...c.requirements, ...pick(p.requirements, REQ_KEYS) };
      const patient = patientOf(tx.s, c);
      const beforePatient = { approxAge: patient.approxAge ?? null, sex: patient.sex ?? null };
      if (p.approxAge !== undefined || p.sex !== undefined) tx.update(patient, { approxAge: p.approxAge ?? patient.approxAge, sex: p.sex ?? patient.sex ?? null });

      // Which fields changed, for the audit entry and the ER's "What changed" list.
      const changes = [];
      for (const k of ['approxAge', 'sex']) if (!sameJson(beforePatient[k], patient[k] ?? null)) changes.push({ field: `patient.${k}` });
      for (const k of Object.keys({ ...before.reported, ...notice.reported })) if (!sameJson(before.reported?.[k], notice.reported[k])) changes.push({ field: `reported.${k}` });
      for (const k of [...HANDOVER_TEXT, 'interventions']) if (!sameJson(before.handover?.[k], notice.handover?.[k])) changes.push({ field: `handover.${k}` });
      if (!sameJson(before.crewAcuity, c.crewAcuity)) changes.push({ field: 'crewAcuity', level: c.crewAcuity?.level });
      for (const k of REQ_KEYS) if (!sameJson(before.requirements?.[k], c.requirements?.[k])) changes.push({ field: `requirements.${k}`, value: !!c.requirements?.[k] });
      if (!sameJson(before.etaAt, notice.etaAt)) changes.push({ field: 'etaAt', value: notice.etaAt });
      if (!sameJson(before.transcript, notice.transcript)) changes.push({ field: 'transcript' });
      for (const v of added) changes.push({ field: 'vitals', readingId: v.id, type: v.type });
      notice.updates = [...(notice.updates ?? []), { revision: notice.revision, at: tx.now, by: actor.id, changes }];
      tx.timeline(notice, 'updated', msg('tl.revisionChanges', { n: notice.revision, count: changes.length }));
      return { summary: msg('audit.handoverUpdated', { ref: c.ref, n: notice.revision, count: changes.length }), details: changes,
        result: { caseId: c.id, created: false }, noticeId: notice.id, caseRec: c, changes };
    }

    const ref = nextRef(tx.s, 'SL');
    const patient = tx.create('patient', { alias: p.patientAlias ?? ref, approxAge: p.approxAge ?? null, sex: p.sex ?? null,
      location: { kind: 'pre_hospital', hospitalId: null, department: null, since: tx.now } }, 'p');
    const caseRec = tx.create('case', {
      ref, patientId: patient.id, source: crew ? 'ambulance' : 'citizen', destinationHospitalId: p.destinationHospitalId, department: 'ER', deviceRef: crew ? null : p.deviceRef ?? null,
      status: 'active', journey: 'expected', triage: null, disposition: null, stepDown: null, transferId: null, arrivedAt: null,
      crewAcuity: crew && p.crewAcuity ? { level: p.crewAcuity, source: 'crew' } : null,
      requirements: { isolation: false, ventilator: false, monitor: false, ...(crew ? pick(p.requirements ?? {}, REQ_KEYS) : {}) },
      reportedConcern: p.concern, assignedCoordinatorId: null, submittedBy: actor.id, noticeId: null, ambulanceAssignmentId: null,
      destinationHistory: [{ hospitalId: p.destinationHospitalId, at: tx.now, by: actor.id, reason: null }],
    }, 'case');
    const handover = crew ? { crewNotes: null, interventions: [], receivingRequirements: null, history: null, allergies: null,
      ...pick(p, HANDOVER_TEXT), ...(p.interventions ? { interventions: [...p.interventions] } : {}),
      crewAcuity: p.crewAcuity ? { level: p.crewAcuity, source: 'crew' } : null, vitals: newReadings([]) } : null;
    const notice = tx.create('arrivalNotice', {
      caseId: caseRec.id, source: caseRec.source, submittedBy: actor.id, submittedAt: tx.now, clientRef: p.clientRef ?? null, deviceRef: caseRec.deviceRef,
      status: 'submitted', acknowledged: null, etaAt: p.etaAt ?? null, transportMode: crew ? 'ambulance' : (p.transportMode ?? 'unknown'),
      reported: { ageText: null, onset: null, awake: 'unknown', breathing: 'unknown', awakeBreathing: 'unknown', conditions: null, allergies: null, patientCount: 1,
        location: null, contact: null, accessibilityNeeds: null, ...pick(p, REPORTED_FIELDS) },
      transcript: p.transcript ?? null, extractionMethod: p.extractionMethod ?? (crew ? 'crew-entered' : 'manual'),
      clinicallyVerified: false, handover, revision: 1, updates: [],
      timeline: [{ at: tx.now, by: actor.id, event: 'submitted', detail: msg('tl.sent', { hospital: hospitalName(tx.s, p.destinationHospitalId) }) }],
    }, 'an');
    caseRec.noticeId = notice.id;
    if (crew) {
      const amb = tx.create('ambulanceAssignment', { ambulanceId: actor.ambulanceId, crewUserIds: [actor.id], caseId: caseRec.id,
        destinationHospitalId: p.destinationHospitalId, status: 'sent', currentLocation: p.currentLocation ?? null }, 'amb');
      caseRec.ambulanceAssignmentId = amb.id;
    }
    return { summary: msg('audit.noticeSubmitted', { source: SOURCE_MSG[caseRec.source], ref, hospital: hospitalName(tx.s, p.destinationHospitalId) }),
      result: { caseId: caseRec.id, created: true }, refs: [{ entity: 'case', id: caseRec.id }], caseRec, noticeId: notice.id };
  },
  effects: (tx, _c, p, actor, ctx) => {
    const c = ctx.caseRec;
    const eta = tx.s.arrivalNotices[ctx.noticeId].etaAt;
    if (!ctx.result.created) {
      tx.notify(toCoordinators(c.destinationHospitalId, 'ER'), 'handover_updated', msg('notifMsg.handoverUpdatedFields', { ref: c.ref, count: ctx.changes.length }), { entity: 'case', id: c.id });
      return;
    }
    const message = eta ? msg('notifMsg.newNoticeEta', { source: SOURCE_MSG[c.source], ref: c.ref, eta: iso(eta) }) : msg('notifMsg.newNotice', { source: SOURCE_MSG[c.source], ref: c.ref });
    tx.notify(toCoordinators(c.destinationHospitalId, 'ER'), 'incoming_handover', message, { entity: 'case', id: c.id });
  },
});

action('acknowledgeArrival', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p) => {
    const n = s.arrivalNotices[c.noticeId];
    if (!n) return msg('err.noNotice', { ref: c.ref });
    if (c.status !== 'active') return caseStatusError(c);
    if (n.acknowledged) return msg('err.alreadyAcknowledged', { ref: c.ref });
    if (p.coordinatorId) {
      const u = s.users[p.coordinatorId];
      if (!u || u.role !== 'er_coordinator' || u.hospitalId !== c.destinationHospitalId) return msg('err.coordinatorInvalid');
    }
    return null;
  },
  apply: (tx, c, p, actor) => {
    const n = tx.s.arrivalNotices[c.noticeId];
    tx.update(n, { acknowledged: { by: actor.id, at: tx.now }, status: n.status === 'submitted' ? 'acknowledged' : n.status });
    tx.timeline(n, 'acknowledged', msg('tl.acknowledgedNotAcceptance'));
    c.assignedCoordinatorId = p.coordinatorId ?? actor.id;
    return { summary: msg('audit.acknowledged', { ref: c.ref, name: tx.s.users[c.assignedCoordinatorId].name }) };
  },
  effects: (tx, c) => {
    for (const to of partyTargets(tx.s, c)) {
      tx.notify(to, 'acknowledged', msg('notifMsg.acknowledged', { hospital: hospitalName(tx.s, c.destinationHospitalId), ref: c.ref }), { entity: 'case', id: c.id });
    }
  },
});

action('updateETA', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p) => {
    if (c.status !== 'active') return caseStatusError(c);
    if (patientOf(s, c).location.kind !== 'pre_hospital') return msg('err.caseArrived', { ref: c.ref });
    if (!validIso(p.etaAt)) return msg('err.etaInvalid');
    return null;
  },
  apply: (tx, c, p) => {
    const n = tx.s.arrivalNotices[c.noticeId];
    const prev = n.etaAt;
    tx.update(n, { etaAt: p.etaAt, status: p.enRoute && ['submitted', 'acknowledged'].includes(n.status) ? 'en_route' : n.status });
    tx.timeline(n, 'eta_updated', msg('tl.eta', { from: prev ? iso(prev) : msg('common.unknownLower'), to: iso(p.etaAt), reason: p.reason ? msg('tl.reasonSuffix', { reason: p.reason }) : NO_TEXT }));
    if (p.enRoute && c.ambulanceAssignmentId) tx.update(tx.s.ambulanceAssignments[c.ambulanceAssignmentId], { status: 'en_route' });
    return { summary: msg('audit.eta', { ref: c.ref, eta: iso(p.etaAt) }) };
  },
  effects: (tx, c, p) => {
    tx.notify(toCoordinators(c.destinationHospitalId, 'ER'), 'eta_changed', msg('notifMsg.etaChanged', { ref: c.ref, eta: iso(p.etaAt) }), { entity: 'case', id: c.id });
  },
});

action('requestClarification', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p) => {
    if (c.status !== 'active') return caseStatusError(c);
    if (!c.noticeId) return msg('err.noSubmitter', { ref: c.ref });
    if (!nonEmpty(p.question)) return msg('err.writeQuestion');
    return null;
  },
  apply: (tx, c, p, actor) => {
    const cm = tx.create('comment', { caseId: c.id, kind: 'clarification', body: p.question.trim(), authorId: actor.id,
      status: 'open', answer: null, answeredBy: null, answeredAt: null }, 'cm');
    tx.timeline(tx.s.arrivalNotices[c.noticeId], 'clarification_requested', msg('tl.clarificationRequested', { text: p.question.trim() }));
    return { summary: msg('audit.clarificationRequested', { ref: c.ref }), result: { commentId: cm.id }, commentId: cm.id };
  },
  effects: (tx, c, p, _a, ctx) => {
    for (const to of partyTargets(tx.s, c)) tx.notify(to, 'clarification', msg('notifMsg.clarification', { ref: c.ref, question: p.question.trim() }), { entity: 'comment', id: ctx.commentId });
  },
});

action('respondClarification', {
  target: (s, p) => find(s, 'comment', p.commentId),
  scope: (s, cm, p) => caseScope(s, s.cases[cm.caseId], p),
  validate: (s, cm, p) => {
    if (cm.kind !== 'clarification') return msg('err.notClarification');
    if (cm.status !== 'open') return msg('err.alreadyAnswered');
    if (!nonEmpty(p.answer)) return msg('err.writeAnswer');
    return null;
  },
  apply: (tx, cm, p, actor) => {
    tx.update(cm, { status: 'answered', answer: p.answer.trim(), answeredBy: actor.id, answeredAt: tx.now });
    const c = tx.s.cases[cm.caseId];
    tx.timeline(tx.s.arrivalNotices[c.noticeId], 'clarification_answered', msg('tl.clarificationAnswered', { text: p.answer.trim() }));
    return { summary: msg('audit.clarificationAnswered', { ref: c.ref }), refs: [{ entity: 'comment', id: cm.id }, { entity: 'case', id: c.id }] };
  },
  effects: (tx, cm) => {
    tx.notify({ userId: cm.authorId }, 'clarification_answered', msg('notifMsg.clarificationAnswered', { ref: tx.s.cases[cm.caseId].ref, answer: cm.answer }), { entity: 'case', id: cm.caseId });
  },
});

action('changeDestination', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p) => {
    if (c.status !== 'active') return caseStatusError(c);
    if (patientOf(s, c).location.kind !== 'pre_hospital') return msg('err.caseArrivedNoRedirect', { ref: c.ref });
    if (!s.hospitals[p.toHospitalId]) return msg('err.chooseNewDestination');
    if (p.toHospitalId === c.destinationHospitalId) return msg('err.alreadyHeading');
    if (!nonEmpty(p.reason)) return msg('err.reasonRequiredDestination');
    return null;
  },
  apply: (tx, c, p, actor) => {
    const from = c.destinationHospitalId;
    const to = hospitalName(tx.s, p.toHospitalId);
    const res = anyActiveReservationRecord(tx.s, c.id);
    if (res) releaseReservationFor(tx, res, msg('release.destinationChanged', { hospital: to, reason: p.reason }));
    cancelCaseTasks(tx, c.id, msg('note.destinationChanged', { reason: p.reason }));
    c.destinationHospitalId = p.toHospitalId;
    c.assignedCoordinatorId = null;
    c.journey = 'expected';
    c.destinationHistory = [...c.destinationHistory, { hospitalId: p.toHospitalId, at: tx.now, by: actor.id, reason: p.reason, from }];
    const n = tx.s.arrivalNotices[c.noticeId];
    if (n) {
      tx.update(n, { acknowledged: null, status: n.status === 'acknowledged' ? 'submitted' : n.status });
      tx.timeline(n, 'destination_changed', msg('tl.destinationChanged', { from: hospitalName(tx.s, from), to, reason: p.reason }));
    }
    if (c.ambulanceAssignmentId) tx.update(tx.s.ambulanceAssignments[c.ambulanceAssignmentId], { destinationHospitalId: p.toHospitalId });
    return { summary: msg('audit.destinationChanged', { ref: c.ref, from: hospitalName(tx.s, from), to }), reason: p.reason, from, releasedReservation: res?.id ?? null };
  },
  effects: (tx, c, p, _a, ctx) => {
    tx.notify(toCoordinators(ctx.from, 'ER'), 'redirected', msg('notifMsg.redirectedAway', { ref: c.ref, hospital: hospitalName(tx.s, p.toHospitalId), reason: p.reason }), { entity: 'case', id: c.id });
    tx.notify(toCoordinators(p.toHospitalId, 'ER'), 'incoming_handover', msg('notifMsg.redirectedIn', { ref: c.ref, reason: p.reason }), { entity: 'case', id: c.id });
  },
});

action('cancelCase', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p) => {
    if (c.status !== 'active') return msg('err.caseAlready', { ref: c.ref, status: CASE_STATUS_MSG[c.status] });
    if (patientOf(s, c).location.kind !== 'pre_hospital') return msg('err.caseArrivedNoCancel', { ref: c.ref });
    if (!nonEmpty(p.reason)) return msg('err.reasonRequiredCancel');
    return null;
  },
  apply: (tx, c, p) => {
    const res = anyActiveReservationRecord(tx.s, c.id);
    if (res) releaseReservationFor(tx, res, msg('release.caseCanceled', { ref: c.ref, reason: p.reason }));
    cancelCaseTasks(tx, c.id, msg('note.caseCanceled', { reason: p.reason }));
    c.status = 'canceled';
    c.cancelReason = p.reason;
    const n = tx.s.arrivalNotices[c.noticeId];
    if (n) { tx.update(n, { status: 'canceled' }); tx.timeline(n, 'canceled', msg('tl.canceled', { reason: p.reason })); }
    if (c.ambulanceAssignmentId) tx.update(tx.s.ambulanceAssignments[c.ambulanceAssignmentId], { status: 'canceled' });
    tx.update(patientOf(tx.s, c), { location: { kind: 'off_site', hospitalId: null, department: null, since: tx.now } });
    return { summary: msg('audit.caseCanceled', { ref: c.ref }), reason: p.reason, releasedReservation: res?.id ?? null };
  },
  effects: (tx, c, p, actor) => {
    tx.notify(toCoordinators(c.destinationHospitalId, 'ER'), 'canceled', msg('notifMsg.caseCanceled', { ref: c.ref, reason: p.reason }), { entity: 'case', id: c.id });
    if (!['citizen', 'paramedic'].includes(actor.role)) for (const to of partyTargets(tx.s, c)) tx.notify(to, 'canceled', msg('notifMsg.caseCanceledByEr', { ref: c.ref, reason: p.reason }), { entity: 'case', id: c.id });
  },
});

action('recordTriage', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p) => {
    const loc = patientOf(s, c).location;
    if (c.status !== 'active') return caseStatusError(c);
    if (loc.department !== 'ER' || !['er_waiting', 'bed'].includes(loc.kind)) return msg('err.triageNotArrived');
    if (!Number.isInteger(p.priority) || p.priority < 1 || p.priority > 5) return msg('err.triagePriority');
    return null;
  },
  apply: (tx, c, p, actor) => {
    c.triage = { priority: p.priority, by: actor.id, at: tx.now, source: 'staff-entered', note: p.note ?? null };
    if (c.journey === 'triage_pending') c.journey = activeReservationForCase(tx.s, c.id, tx.now) ? 'assigned' : 'waiting';
    return { summary: msg('audit.triage', { ref: c.ref, priority: p.priority }) };
  },
});

action('confirmArrival', {
  // { caseId } → arrival at the ER door. { transferId } → arrival AND placement in the reserved ICU bed.
  target: (s, p) => (p.transferId ? find(s, 'transferRequest', p.transferId) : find(s, 'case', p.caseId)),
  scope: (s, r) => (r.entity === 'transferRequest' ? transferScope(s, r) : caseScope(s, r)),
  validate: (s, r) => {
    if (r.entity === 'case') {
      if (r.status !== 'active') return caseStatusError(r);
      if (patientOf(s, r).location.kind !== 'pre_hospital') return msg('err.caseOnSite', { ref: r.ref });
      return null;
    }
    if (!['in_transit', 'arrived'].includes(r.status)) return msg('err.transferNotDeparted', { ref: r.ref, status: TRANSFER_STATUS_MSG[r.status] });
    const res = s.reservations[r.reservationId];
    if (!res || res.status !== 'active' || res.bedId !== r.targetBedId) return msg('err.noHeldReservation', { ref: r.ref });
    const bed = s.beds[r.targetBedId];
    if (bed.occupancy.status !== 'vacant') return msg('err.bedOccupiedShort', { bed: bed.label });
    return compatibilityError(bed, r.requirements);
  },
  apply: (tx, r, p, actor) => {
    if (r.entity === 'case') {
      arriveAtEr(tx, r);
      return { summary: msg('audit.arrivedEr', { ref: r.ref }), caseRec: r };
    }
    const c = tx.s.cases[r.caseId];
    const bed = tx.s.beds[r.targetBedId];
    placeInBed(tx, patientOf(tx.s, c), bed, c);
    tx.update(tx.s.reservations[r.reservationId], { status: 'fulfilled', fulfilledAt: tx.now });
    tx.update(r, { status: 'completed', completedAt: tx.now, completedBy: actor.id, droppedOffAt: r.droppedOffAt ?? tx.now, droppedOffBy: r.droppedOffBy ?? actor.id });
    tx.update(c, { journey: 'in_care', department: 'ICU' });
    return { summary: msg('audit.arrivedIcu', { ref: c.ref, bed: bed.label }), refs: [{ entity: 'transferRequest', id: r.id }, { entity: 'case', id: c.id }, { entity: 'bed', id: bed.id }], caseRec: c };
  },
  effects: (tx, r, _p, _a, ctx) => {
    const c = ctx.caseRec;
    if (r.entity === 'case') {
      afterErArrival(tx, c);
      return;
    }
    tx.notify(toCoordinators(r.hospitalId, 'ER'), 'transfer_complete', msg('notifMsg.transferPlaced', { ref: c.ref, bed: tx.s.beds[r.targetBedId].label }), { entity: 'transferRequest', id: r.id });
  },
});

// ===========================================================================
// Beds: reservation, placement, cleaning, faults, equipment, staffing, verification
// ===========================================================================
const reservationScope = (s, r) => ({ entity: 'reservation', hospitalId: r.hospitalId, department: r.department });

action('reserveBed', {
  target: (s, p) => find(s, 'bed', p.bedId),
  scope: (s, b) => bedScope(s, b),
  validate: (s, bed, p, actor, now) => {
    const c = s.cases[p.caseId];
    if (!c) return NOT_FOUND.case;
    if (c.status !== 'active') return caseStatusError(c);
    const patient = patientOf(s, c);
    let requirements = c.requirements;
    if (bed.department === 'ICU') {
      const tr = activeTransferForCase(s, c.id);
      if (!tr || tr.hospitalId !== bed.hospitalId) return msg('err.icuNeedsTransfer');
      if (tr.status === 'requested') return msg('err.icuBeforeAcceptance', { ref: tr.ref });
      if (tr.status !== 'accepted') return msg('err.transferNoNewReservation', { ref: tr.ref, status: TRANSFER_STATUS_MSG[tr.status] });
      if (!tr.targetBedId) return msg('err.confirmCapacityFirst', { ref: tr.ref, bed: bed.label });
      if (tr.targetBedId !== bed.id) return msg('err.capacityOtherBed', { ref: tr.ref, bed: s.beds[tr.targetBedId].label });
      requirements = tr.requirements;
    } else {
      if (c.destinationHospitalId !== bed.hospitalId) return msg('err.notHeadingHere', { ref: c.ref });
      if (patient.location.kind === 'bed') return msg('err.alreadyInBed', { alias: patient.alias, bed: s.beds[patient.location.bedId].label });
      if (!['pre_hospital', 'er_waiting'].includes(patient.location.kind)) return msg('err.cannotGetErBed', { alias: patient.alias });
    }
    const existing = activeReservationForCase(s, c.id, now);
    if (existing) return msg('err.alreadyReserved', { ref: c.ref, bed: s.beds[existing.bedId].label });
    const { available, blockers } = deriveBedReadiness(bed, s, now);
    if (!available) return msg('err.notAvailable', { bed: bed.label, blockers: blockerItems(blockers) });
    if (p.minutes !== undefined && !(Number.isFinite(p.minutes) && p.minutes > 0 && p.minutes <= 240)) return msg('err.reservationMinutes');
    return compatibilityError(bed, requirements);
  },
  apply: (tx, bed, p, actor) => {
    const c = tx.s.cases[p.caseId];
    expireStale(tx, (r) => r.bedId === bed.id || r.caseId === c.id);
    const tr = bed.department === 'ICU' ? activeTransferForCase(tx.s, c.id) : null;
    const res = tx.create('reservation', { bedId: bed.id, caseId: c.id, patientId: c.patientId, hospitalId: bed.hospitalId, department: bed.department,
      transferId: tr?.id ?? null, status: 'active', createdBy: actor.id, expiresAt: addMinutes(tx.now, p.minutes ?? RESERVATION_MINUTES[bed.department]),
      releasedAt: null, releaseReason: null, fulfilledAt: null, extensions: [] }, 'res');
    if (tr) tx.update(tr, { status: 'reserved', reservationId: res.id });
    else if (c.journey === 'waiting') tx.update(c, { journey: 'assigned' });
    return { summary: msg('audit.reserved', { bed: bed.label, ref: c.ref, until: iso(res.expiresAt) }), result: { reservationId: res.id },
      refs: [{ entity: 'bed', id: bed.id }, { entity: 'case', id: c.id }], caseRec: c, tr };
  },
  effects: (tx, bed, p, actor, { caseRec: c, tr }) => {
    if (!tr) {
      const nurse = confirmedStaffing(tx.s, bed.id)?.nurseUserId;
      if (nurse) tx.notify({ userId: nurse }, 'reserved', msg('notifMsg.reserved', { bed: bed.label, ref: c.ref }), { entity: 'bed', id: bed.id });
      return;
    }
    // Sending and receiving handover tasks (SPEC §9 step 5) — both must be done before departure.
    const send = tx.task({ category: 'handover_send', title: msg('taskTitle.handoverSend', { ref: c.ref, tr: tr.ref }), linked: { caseId: c.id, patientId: c.patientId, transferId: tr.id },
      requiredRole: 'nurse', department: 'ER', hospitalId: tr.hospitalId, priority: 'high', dueMinutes: SLA_MINUTES.handover,
      ownerUserId: tr.fromBedId ? confirmedStaffing(tx.s, tr.fromBedId)?.nurseUserId ?? null : null });
    const receive = tx.task({ category: 'handover_receive', title: msg('taskTitle.handoverReceive', { ref: c.ref, bed: bed.label }), linked: { caseId: c.id, patientId: c.patientId, transferId: tr.id, bedId: bed.id },
      requiredRole: 'nurse', department: 'ICU', hospitalId: tr.hospitalId, priority: 'high', dueMinutes: SLA_MINUTES.handover,
      ownerUserId: confirmedStaffing(tx.s, bed.id)?.nurseUserId ?? null });
    tx.update(tr, { handoverTaskIds: [send.id, receive.id] });
    tx.notify(toCoordinators(tr.hospitalId, 'ER'), 'icu_bed_reserved', msg('notifMsg.icuReservedCoordinator', { bed: bed.label, tr: tr.ref }), { entity: 'transferRequest', id: tr.id });
    tx.notify({ userId: tr.requestedBy }, 'icu_bed_reserved', msg('notifMsg.icuReservedDoctor', { bed: bed.label, ref: c.ref }), { entity: 'transferRequest', id: tr.id });
  },
});

action('extendReservation', {
  target: (s, p) => find(s, 'reservation', p.reservationId),
  scope: (s, r) => reservationScope(s, r),
  validate: (s, r, p, actor, now) => {
    const state = reservationState(r, now);
    if (state !== 'active') return msg('err.reservationState', { state: RESERVATION_STATE_MSG[state] });
    if (!r.expiresAt) return msg('err.reservationHeld');
    if (!(Number.isFinite(p.minutes) && p.minutes > 0 && p.minutes <= 240)) return msg('err.extendMinutes');
    if (!nonEmpty(p.reason)) return msg('err.reasonRequiredExtend');
    return null;
  },
  apply: (tx, r, p, actor) => {
    const expiresAt = addMinutes(r.expiresAt, p.minutes);
    tx.update(r, { expiresAt, extensions: [...(r.extensions ?? []), { by: actor.id, at: tx.now, minutes: p.minutes, reason: p.reason }] });
    return { summary: msg('audit.extended', { bed: tx.s.beds[r.bedId].label, until: iso(expiresAt) }), reason: p.reason };
  },
});

action('releaseReservation', {
  target: (s, p) => find(s, 'reservation', p.reservationId),
  scope: (s, r) => reservationScope(s, r),
  validate: (s, r, p) => {
    if (r.status !== 'active') return msg('err.reservationAlready', { state: RESERVATION_STATE_MSG[r.status] });
    const tr = r.transferId ? s.transferRequests[r.transferId] : null;
    if (tr && ['in_transit', 'arrived'].includes(tr.status)) return msg('err.inTransportHeld');
    if (!nonEmpty(p.reason)) return msg('err.reasonRequiredRelease');
    return null;
  },
  apply: (tx, r, p) => {
    releaseReservationFor(tx, r, p.reason);
    const c = tx.s.cases[r.caseId];
    if (c.journey === 'assigned') tx.update(c, { journey: 'waiting' });
    return { summary: msg('audit.released', { bed: tx.s.beds[r.bedId].label, ref: c.ref }), reason: p.reason };
  },
});

action('confirmPlacement', {
  target: (s, p) => find(s, 'bed', p.bedId),
  scope: (s, b) => bedScope(s, b),
  validate: (s, bed, p, actor, now) => {
    const c = s.cases[p.caseId];
    if (!c) return NOT_FOUND.case;
    if (c.status !== 'active') return caseStatusError(c);
    const patient = patientOf(s, c);
    const loc = patient.location;
    if (bed.occupancy.status === 'occupied') return msg('err.bedOccupiedBy', { bed: bed.label, alias: s.patients[bed.occupancy.patientId].alias });
    if (loc.kind === 'bed') return msg('err.alreadyInBedDepart', { alias: patient.alias, bed: s.beds[loc.bedId].label });
    if (loc.kind === 'in_transit') return msg('err.inTransitConfirmArrival', { alias: patient.alias });
    if (loc.kind === 'pre_hospital') return msg('err.notArrived', { alias: patient.alias });
    if (loc.hospitalId !== bed.hospitalId) return msg('err.notAtHospital', { alias: patient.alias });
    const res = activeReservationForBed(s, bed.id, now);
    if (res && res.caseId !== c.id) return msg('err.reservedForOther', { bed: bed.label, ref: s.cases[res.caseId].ref });
    const elsewhere = activeReservationForCase(s, c.id, now);
    if (elsewhere && elsewhere.bedId !== bed.id) return msg('err.holdsOtherReservation', { ref: c.ref, bed: s.beds[elsewhere.bedId].label });
    let requirements = c.requirements;
    if (bed.department === 'ICU') {
      const tr = activeTransferForCase(s, c.id);
      if (!tr || !res || tr.reservationId !== res.id) return msg('err.icuPlacementNeedsTransfer');
      if (loc.kind !== 'unit_arrival') return msg('err.notArrivedIcu', { alias: patient.alias });
      requirements = tr.requirements;
    } else if (loc.kind !== 'er_waiting' || loc.department !== 'ER') {
      return msg('err.notWaitingEr', { alias: patient.alias });
    }
    const blockers = deriveBedReadiness(bed, s, now).blockers.filter((b) => !(b.type === 'reserved' && res?.caseId === c.id));
    if (blockers.length) return msg('err.notReady', { bed: bed.label, blockers: blockerItems(blockers) });
    return compatibilityError(bed, requirements);
  },
  apply: (tx, bed, p, actor) => {
    const c = tx.s.cases[p.caseId];
    const res = activeReservationForBed(tx.s, bed.id, tx.now);
    placeInBed(tx, patientOf(tx.s, c), bed, c);
    if (res) tx.update(res, { status: 'fulfilled', fulfilledAt: tx.now });
    const tr = bed.department === 'ICU' ? activeTransferForCase(tx.s, c.id) : null;
    if (tr) tx.update(tr, { status: 'completed', completedAt: tx.now, completedBy: actor.id });
    tx.update(c, { journey: 'in_care', department: bed.department });
    return { summary: msg('audit.placed', { ref: c.ref, bed: bed.label }), refs: [{ entity: 'bed', id: bed.id }, { entity: 'case', id: c.id }], caseRec: c };
  },
  effects: (tx, bed, p, actor, { caseRec: c }) => {
    const nurse = confirmedStaffing(tx.s, bed.id)?.nurseUserId;
    if (nurse && nurse !== actor.id) tx.notify({ userId: nurse }, 'placed', msg('notifMsg.placed', { ref: c.ref, bed: bed.label }), { entity: 'bed', id: bed.id });
  },
});

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
action('reportFault', {
  target: (s, p) => find(s, 'bed', p.bedId),
  scope: (s, b) => bedScope(s, b),
  validate: (s, bed, p) => {
    if (!['technical', 'equipment'].includes(p.kind)) return msg('err.faultKind');
    if (!nonEmpty(p.description)) return msg('err.describeFault');
    if (!SEVERITIES.includes(p.severity)) return msg('err.severity');
    if (p.kind === 'equipment' && !nonEmpty(p.equipmentType)) return msg('err.equipmentName');
    return null;
  },
  apply: (tx, bed, p, actor) => {
    const equipment = p.kind === 'equipment';
    const ticket = tx.create('maintenanceTicket', {
      ref: nextRef(tx.s, equipment ? 'BM' : 'MT'), kind: p.kind, bedId: bed.id, hospitalId: bed.hospitalId, department: bed.department,
      category: p.category ?? (equipment ? msg('category.medicalEquipment') : msg('category.facilities')), equipmentType: equipment ? p.equipmentType : null,
      description: p.description.trim(), severity: p.severity, attachmentName: p.attachmentName ?? null,
      status: 'open', assignedTo: null, reportedBy: actor.id, reportedAt: tx.now, dueAt: addMinutes(tx.now, SLA_MINUTES.ticket[p.severity]),
      resolution: null, resolvedAt: null, resolvedBy: null, linkedTransferId: null, reopenCount: 0,
      history: [{ at: tx.now, by: actor.id, status: 'open', note: null }],
    }, 'mt');
    if (equipment) {
      const check = latestEquipmentCheck(tx.s, bed.id, p.equipmentType);
      if (isCheckValid(check)) tx.update(check, { invalidatedAt: tx.now, invalidatedReason: msg('check.invalidatedByTicket', { ref: ticket.ref }) });
    }
    resetVerification(tx, bed, msg('why.faultReported', { ref: ticket.ref }));
    return { summary: (equipment ? msg('audit.equipmentFault', { ref: ticket.ref, bed: bed.label }) : msg('audit.technicalFault', { ref: ticket.ref, bed: bed.label })), result: { ticketId: ticket.id }, ticket,
      refs: [{ entity: 'maintenanceTicket', id: ticket.id }, { entity: 'bed', id: bed.id }] };
  },
  effects: (tx, bed, p, actor, { ticket }) => {
    const team = ticket.kind === 'equipment' ? 'biomed_tech' : 'maintenance_tech';
    tx.notify(toRole(team, bed.hospitalId), 'fault_reported', msg('notifMsg.faultReported', { ref: ticket.ref, category: ticket.category, bed: bed.label, severity: SEVERITY_MSG[ticket.severity] }),
      { entity: 'maintenanceTicket', id: ticket.id }, ticket.severity === 'critical');
    if (bed.occupancy.status === 'occupied') {
      tx.notify(toCoordinators(bed.hospitalId, bed.department), 'urgent_blocker', msg('notifMsg.urgentFault', { ref: ticket.ref, bed: bed.label }), { entity: 'bed', id: bed.id }, true);
    }
  },
});

action('updateTicketStatus', {
  target: (s, p) => find(s, 'maintenanceTicket', p.ticketId),
  scope: (s, t) => ticketScope(s, t),
  validate: (s, t, p) => {
    const allowed = { open: ['assigned', 'in_progress'], assigned: ['in_progress'], in_progress: [], resolved: [] }[t.status];
    if (t.status === 'resolved') return msg('err.ticketResolvedReopen', { ref: t.ref });
    if (!allowed.includes(p.status)) return msg('err.ticketTransition', { ref: t.ref, from: TICKET_STATUS_MSG[t.status], to: TICKET_STATUS_MSG[p.status] ?? String(p.status) });
    return null;
  },
  apply: (tx, t, p, actor) => {
    tx.update(t, { status: p.status, assignedTo: t.assignedTo ?? actor.id, history: [...t.history, { at: tx.now, by: actor.id, status: p.status, note: p.note ?? null }] });
    return { summary: msg('audit.ticketStatus', { ref: t.ref, status: TICKET_STATUS_MSG[p.status] }) };
  },
});

action('resolveFault', {
  target: (s, p) => find(s, 'maintenanceTicket', p.ticketId),
  scope: (s, t) => ticketScope(s, t),
  validate: (s, t, p) => {
    if (t.status === 'resolved') return msg('err.ticketAlreadyResolved', { ref: t.ref });
    if (!nonEmpty(p.resolution)) return msg('err.documentRepair');
    return null;
  },
  apply: (tx, t, p, actor) => {
    tx.update(t, { status: 'resolved', resolution: p.resolution.trim(), resolvedAt: tx.now, resolvedBy: actor.id, assignedTo: t.assignedTo ?? actor.id,
      history: [...t.history, { at: tx.now, by: actor.id, status: 'resolved', note: p.resolution.trim() }] });
    // A biomedical repair includes a function check of that item only; other tickets and blockers are untouched.
    if (t.kind === 'equipment') {
      tx.create('equipmentCheck', { bedId: t.bedId, hospitalId: t.hospitalId, equipment: t.equipmentType, result: 'passed', checkedBy: actor.id,
        checkedAt: tx.now, viaTicketId: t.id, invalidatedAt: null, invalidatedReason: null }, 'eqc');
    }
    return { summary: msg('audit.resolved', { ref: t.ref }), reason: p.resolution };
  },
  effects: (tx, t) => {
    const bed = tx.s.beds[t.bedId];
    const remaining = deriveBedReadiness(bed, tx.s, tx.now).blockers;
    tx.notify(toCoordinators(bed.hospitalId, bed.department), 'fault_resolved', remaining.length
      ? msg('notifMsg.faultResolvedBlocked', { ref: t.ref, bed: bed.label, blockers: blockerTypes(remaining) })
      : msg('notifMsg.faultResolvedAvailable', { ref: t.ref, bed: bed.label }), { entity: 'bed', id: bed.id });
  },
});

action('reopenTicket', {
  target: (s, p) => find(s, 'maintenanceTicket', p.ticketId),
  scope: (s, t) => ticketScope(s, t),
  validate: (s, t, p) => {
    if (t.status !== 'resolved') return msg('err.ticketNotResolved', { ref: t.ref });
    if (!nonEmpty(p.reason)) return msg('err.reasonRequiredReopen');
    return null;
  },
  apply: (tx, t, p, actor) => {
    tx.update(t, { status: 'open', reopenCount: t.reopenCount + 1, resolvedAt: null, resolvedBy: null,
      history: [...t.history, { at: tx.now, by: actor.id, status: 'open', note: msg('note.reopened', { reason: p.reason }) }] });
    const bed = tx.s.beds[t.bedId];
    if (t.kind === 'equipment') {
      const check = latestEquipmentCheck(tx.s, bed.id, t.equipmentType);
      if (isCheckValid(check)) tx.update(check, { invalidatedAt: tx.now, invalidatedReason: msg('check.ticketReopened', { ref: t.ref }) });
    }
    resetVerification(tx, bed, msg('why.ticketReopened', { ref: t.ref }));
    return { summary: msg('audit.reopened', { ref: t.ref, bed: bed.label }), reason: p.reason };
  },
  effects: (tx, t, p) => {
    tx.notify(toRole(t.kind === 'equipment' ? 'biomed_tech' : 'maintenance_tech', t.hospitalId), 'ticket_reopened', msg('notifMsg.ticketReopened', { ref: t.ref, reason: p.reason }), { entity: 'maintenanceTicket', id: t.id });
  },
});

action('completeCleaning', {
  target: (s, p) => find(s, 'bed', p.bedId),
  scope: (s, b) => bedScope(s, b),
  validate: (s, bed) => (['required', 'assigned', 'in_progress'].includes(bed.cleaning.status) ? null : msg('err.noCleaningPending', { bed: bed.label })),
  apply: (tx, bed, p, actor) => {
    tx.update(bed, { cleaning: { status: 'complete', since: tx.now, taskId: bed.cleaning.taskId, by: actor.id } });
    for (const t of openTasksFor(tx.s, (x) => x.category === 'cleaning' && x.linked.bedId === bed.id)) tx.setTaskStatus(t, 'done', p.note ?? msg('note.cleaningComplete'));
    return { summary: msg('audit.cleaningComplete', { bed: bed.label }) };
  },
  effects: (tx, bed) => {
    const remaining = deriveBedReadiness(bed, tx.s, tx.now).blockers;
    tx.notify(toRole('nurse', bed.hospitalId, bed.department), 'cleaning_complete', remaining.length
      ? msg('notifMsg.cleaningCompleteRemaining', { bed: bed.label, blockers: blockerTypes(remaining) })
      : msg('notifMsg.cleaningComplete', { bed: bed.label }), { entity: 'bed', id: bed.id });
  },
});

action('verifyReadiness', {
  target: (s, p) => find(s, 'bed', p.bedId),
  scope: (s, b) => bedScope(s, b),
  validate: (s, bed, p, actor, now) => {
    if (bed.nursingVerification.status === 'verified' && bed.occupancy.status === 'vacant') return msg('err.alreadyVerified', { bed: bed.label });
    const physical = deriveBedReadiness(bed, s, now).blockers.filter((b) => PHYSICAL_BLOCKERS.includes(b.type));
    if (physical.length) return msg('err.cannotVerify', { bed: bed.label, blockers: blockerItems(physical) });
    return null;
  },
  apply: (tx, bed, p, actor) => {
    tx.update(bed, { nursingVerification: { status: 'verified', by: actor.id, at: tx.now, since: tx.now } });
    for (const t of openTasksFor(tx.s, (x) => x.category === 'nursing_verification' && x.linked.bedId === bed.id)) tx.setTaskStatus(t, 'done', p.note ?? msg('note.verified'));
    return { summary: msg('audit.verified', { bed: bed.label }) };
  },
  effects: (tx, bed) => {
    const { available, blockers } = deriveBedReadiness(bed, tx.s, tx.now);
    const tr = values(tx.s, 'transferRequests').find((t) => t.status === 'accepted' && t.targetBedId === bed.id);
    const message = !available ? msg('notifMsg.bedVerifiedBlocked', { bed: bed.label, blockers: blockerTypes(blockers) })
      : tr ? msg('notifMsg.bedReadyReserve', { bed: bed.label, ref: tr.ref }) : msg('notifMsg.bedReady', { bed: bed.label });
    tx.notify(toCoordinators(bed.hospitalId, bed.department), available ? 'bed_ready' : 'bed_verified', message, { entity: 'bed', id: bed.id });
  },
});

action('confirmStaffing', {
  target: (s, p) => find(s, 'bed', p.bedId),
  scope: (s, b) => bedScope(s, b),
  validate: (s, bed, p) => {
    const nurse = s.users[p.nurseUserId];
    if (!nurse || nurse.role !== 'nurse' || !nurse.active) return msg('err.chooseNurse');
    if (nurse.hospitalId !== bed.hospitalId || nurse.department !== bed.department) return msg('err.nurseWrongDept', { name: nurse.name, dept: DEPT_MSG[bed.department] });
    if (confirmedStaffing(s, bed.id)?.nurseUserId === nurse.id) return msg('err.nurseAlreadyConfirmed', { name: nurse.name, bed: bed.label });
    return null;
  },
  apply: (tx, bed, p, actor) => {
    const name = tx.s.users[p.nurseUserId].name;
    const existing = values(tx.s, 'staffingAssignments').find((a) => a.bedId === bed.id);
    const fields = { nurseUserId: p.nurseUserId, status: 'confirmed', confirmedBy: actor.id, confirmedAt: tx.now, reason: null };
    if (existing) tx.update(existing, fields);
    else tx.create('staffingAssignment', { bedId: bed.id, hospitalId: bed.hospitalId, department: bed.department, ...fields }, 'staff');
    for (const t of openTasksFor(tx.s, (x) => x.category === 'staffing' && x.linked.bedId === bed.id)) tx.setTaskStatus(t, 'done', msg('note.confirmedNurse', { name }));
    return { summary: msg('audit.staffingConfirmed', { bed: bed.label, name }) };
  },
  effects: (tx, bed, p) => {
    tx.notify({ userId: p.nurseUserId }, 'staffing', msg('notifMsg.assignedToBed', { bed: bed.label }), { entity: 'bed', id: bed.id });
  },
});

action('recordEquipmentCheck', {
  target: (s, p) => find(s, 'bed', p.bedId),
  scope: (s, b) => bedScope(s, b),
  validate: (s, bed, p) => {
    if (!bed.requiredEquipment.includes(p.equipment)) return msg('err.notRequiredEquipment', { equipment: EQUIP_MSG[p.equipment] ?? String(p.equipment), bed: bed.label });
    if (!['passed', 'failed'].includes(p.result)) return msg('err.checkResult');
    const open = openTicketsForBed(s, bed.id).find((t) => t.kind === 'equipment' && t.equipmentType === p.equipment);
    if (p.result === 'passed' && open) return msg('err.resolveTicketFirst', { ref: open.ref, equipment: EQUIP_MSG[p.equipment] });
    if (p.result === 'failed' && !nonEmpty(p.note)) return msg('err.describeCheckFailure');
    return null;
  },
  apply: (tx, bed, p, actor) => {
    tx.create('equipmentCheck', { bedId: bed.id, hospitalId: bed.hospitalId, equipment: p.equipment, result: p.result, checkedBy: actor.id,
      checkedAt: tx.now, note: p.note ?? null, invalidatedAt: null, invalidatedReason: null }, 'eqc');
    if (p.result === 'passed') {
      for (const t of openTasksFor(tx.s, (x) => x.category === 'equipment_check' && x.linked.bedId === bed.id && x.linked.equipment === p.equipment)) tx.setTaskStatus(t, 'done', msg('note.checkPassed'));
    } else {
      resetVerification(tx, bed, msg('why.checkFailed', { equipment: EQUIP_MSG[p.equipment] }));
    }
    return { summary: (p.result === 'passed' ? msg('audit.checkPassed', { equipment: EQUIP_MSG[p.equipment], bed: bed.label }) : msg('audit.checkFailed', { equipment: EQUIP_MSG[p.equipment], bed: bed.label })), reason: p.note ?? null };
  },
  effects: (tx, bed, p) => {
    if (p.result === 'failed') tx.notify(toCoordinators(bed.hospitalId, bed.department), 'equipment_check_failed', msg('notifMsg.checkFailed', { equipment: EQUIP_MSG[p.equipment], bed: bed.label, note: p.note }), { entity: 'bed', id: bed.id }, true);
  },
});

// ===========================================================================
// ER → ICU transfer: request → clinical decision → capacity confirmation → prep → reservation → handover → move
// ===========================================================================
action('requestTransfer', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p) => {
    if (c.status !== 'active') return caseStatusError(c);
    const loc = patientOf(s, c).location;
    if (loc.department !== 'ER' || !['bed', 'er_waiting'].includes(loc.kind)) return msg('err.transferOnlyInEr');
    const existing = activeTransferForCase(s, c.id);
    if (existing) return msg('err.transferExists', { ref: c.ref, tr: existing.ref });
    if (!nonEmpty(p.reason)) return msg('err.reasonRequiredTransfer');
    return null;
  },
  apply: (tx, c, p, actor) => {
    const loc = patientOf(tx.s, c).location;
    const tr = tx.create('transferRequest', {
      ref: nextRef(tx.s, 'TR'), caseId: c.id, patientId: c.patientId, hospitalId: loc.hospitalId, fromDepartment: 'ER', toDepartment: 'ICU',
      fromBedId: loc.bedId ?? null, status: 'requested', reason: p.reason.trim(),
      requirements: { ventilator: !!p.requirements?.ventilator, isolation: !!p.requirements?.isolation, monitor: !!p.requirements?.monitor },
      requestedBy: actor.id, requestedAt: tx.now, clinicalDecision: null, targetBedId: null, capacity: null, prepItems: [], reservationId: null,
      porterUserId: null, handoverTaskIds: [], departedAt: null, departedBy: null, droppedOffAt: null, droppedOffBy: null,
      completedAt: null, completedBy: null, cancelReason: null,
    }, 'tr');
    c.transferId = tr.id;
    return { summary: msg('audit.transferRequested', { tr: tr.ref, ref: c.ref }), reason: p.reason, result: { transferId: tr.id }, tr,
      refs: [{ entity: 'transferRequest', id: tr.id }, { entity: 'case', id: c.id }] };
  },
  effects: (tx, c, p, actor, { tr }) => {
    tx.notify(toRole('doctor', tr.hospitalId, 'ICU'), 'icu_request', msg('notifMsg.icuRequestDoctor', { tr: tr.ref, ref: c.ref }), { entity: 'transferRequest', id: tr.id });
    tx.notify(toCoordinators(tr.hospitalId, 'ICU'), 'icu_request', msg('notifMsg.icuRequestCoordinator', { tr: tr.ref }), { entity: 'transferRequest', id: tr.id });
  },
});

// The intensivist records the clinical decision only. Capacity (which bed) is the ICU coordinator's separate step.
action('approveTransfer', {
  target: (s, p) => find(s, 'transferRequest', p.transferId),
  scope: (s, t) => transferScope(s, t),
  validate: (s, tr, p) => {
    if (tr.status !== 'requested') return msg('err.alreadyDecided', { ref: tr.ref, status: TRANSFER_STATUS_MSG[tr.status] });
    if (!['accept', 'decline'].includes(p.decision)) return msg('err.decision');
    if (p.decision === 'decline' && !nonEmpty(p.reason)) return msg('err.reasonRequiredDecline');
    return null;
  },
  apply: (tx, tr, p, actor) => {
    const c = tx.s.cases[tr.caseId];
    tx.update(tr, { clinicalDecision: { decision: p.decision, by: actor.id, at: tx.now, reason: p.reason ?? null } });
    if (p.decision === 'decline') {
      tx.update(tr, { status: 'declined' });
      return { summary: msg('audit.transferDeclined', { tr: tr.ref }), reason: p.reason };
    }
    tx.update(tr, { status: 'accepted' });
    tx.update(c, { journey: 'awaiting_transfer' });
    return { summary: msg('audit.transferAccepted', { tr: tr.ref }), reason: p.reason ?? null };
  },
  effects: (tx, tr) => {
    const accepted = tr.status === 'accepted';
    tx.notify({ userId: tr.requestedBy }, 'icu_decision', (accepted ? msg('notifMsg.icuAccepted', { tr: tr.ref }) : msg('notifMsg.icuDeclined', { tr: tr.ref })), { entity: 'transferRequest', id: tr.id });
    if (accepted) {
      const suggested = suggestedBedFor(tx.s, tr, tx.now);
      tx.notify(toCoordinators(tr.hospitalId, 'ICU'), 'icu_decision', suggested
        ? msg('notifMsg.capacityNeededSuggested', { tr: tr.ref, bed: tx.s.beds[suggested].label })
        : msg('notifMsg.capacityNeededNone', { tr: tr.ref }), { entity: 'transferRequest', id: tr.id });
    }
  },
});

// SPEC §9 step 3: the ICU coordinator confirms the suggested bed or picks another compatible one. Prep starts here.
action('confirmCapacity', {
  target: (s, p) => find(s, 'transferRequest', p.transferId),
  scope: (s, t) => transferScope(s, t),
  validate: (s, tr, p, actor, now) => {
    if (tr.status !== 'accepted') return msg('err.capacityWrongStatus', { ref: tr.ref, status: TRANSFER_STATUS_MSG[tr.status] });
    if (tr.targetBedId) return msg('err.capacityAlreadyConfirmed', { ref: tr.ref, bed: s.beds[tr.targetBedId].label });
    if (!p.bedId) return msg('err.chooseIcuBed');
    return icuBedProblem(s, tr, s.beds[p.bedId], now);
  },
  apply: (tx, tr, p, actor) => {
    const bed = tx.s.beds[p.bedId];
    const suggested = suggestedBedFor(tx.s, tr, tx.now);
    tx.update(tr, { targetBedId: bed.id, capacity: { bedId: bed.id, by: actor.id, at: tx.now, wasSuggested: suggested === bed.id } });
    return { summary: msg('audit.capacityConfirmed', { tr: tr.ref, bed: bed.label }), bed };
  },
  effects: (tx, tr, p, actor, { bed }) => {
    createPrepItems(tx, tr, bed);
    tx.notify({ userId: tr.requestedBy }, 'capacity_confirmed', msg('notifMsg.capacityConfirmed', { tr: tr.ref, bed: bed.label }), { entity: 'transferRequest', id: tr.id });
    tx.notify(toCoordinators(tr.hospitalId, 'ER'), 'capacity_confirmed', msg('notifMsg.capacityConfirmed', { tr: tr.ref, bed: bed.label }), { entity: 'transferRequest', id: tr.id });
  },
});

action('cancelTransferRequest', {
  target: (s, p) => find(s, 'transferRequest', p.transferId),
  scope: (s, t) => transferScope(s, t),
  validate: (s, tr, p) => {
    if (['in_transit', 'arrived'].includes(tr.status)) return msg('err.cancelInTransport', { ref: tr.ref });
    if (!['requested', 'accepted', 'reserved'].includes(tr.status)) return msg('err.cancelTransferStatus', { ref: tr.ref, status: TRANSFER_STATUS_MSG[tr.status] });
    if (!nonEmpty(p.reason)) return msg('err.reasonRequiredCancelTransfer');
    return null;
  },
  apply: (tx, tr, p, actor) => {
    const res = tr.reservationId ? tx.s.reservations[tr.reservationId] : null;
    if (res && res.status === 'active') releaseReservationFor(tx, res, msg('release.transferCanceled', { tr: tr.ref, reason: p.reason }));
    const note = msg('note.transferCanceled', { tr: tr.ref, reason: p.reason });
    for (const id of tr.handoverTaskIds) { const t = tx.s.tasks[id]; if (t && isOpenTask(t)) tx.setTaskStatus(t, 'canceled', note); }
    // Prep created for this request is withdrawn; existing bed work it had linked (e.g. turnover cleaning) stays, unlinked.
    for (const t of values(tx.s, 'tasks').filter((x) => x.linked.transferId === tr.id && isOpenTask(x))) {
      if (t.prepFor === tr.id) tx.setTaskStatus(t, 'canceled', note);
      else tx.update(t, { linked: { ...t.linked, transferId: null } });
    }
    for (const k of values(tx.s, 'maintenanceTickets').filter((x) => x.linkedTransferId === tr.id)) tx.update(k, { linkedTransferId: null });
    tx.update(tr, { status: 'canceled', cancelReason: p.reason, canceledBy: actor.id, canceledAt: tx.now });
    const c = tx.s.cases[tr.caseId];
    if (c.journey === 'awaiting_transfer') tx.update(c, { journey: patientOf(tx.s, c).location.kind === 'bed' ? 'in_care' : 'waiting' });
    return { summary: msg('audit.transferCanceled', { tr: tr.ref }), reason: p.reason };
  },
  effects: (tx, tr, p, actor) => {
    const message = msg('notifMsg.transferCanceled', { tr: tr.ref, reason: p.reason });
    if (tr.requestedBy !== actor.id) tx.notify({ userId: tr.requestedBy }, 'transfer_canceled', message, { entity: 'transferRequest', id: tr.id });
    tx.notify(toCoordinators(tr.hospitalId, 'ICU'), 'transfer_canceled', message, { entity: 'transferRequest', id: tr.id });
    if (tr.porterUserId) tx.notify({ userId: tr.porterUserId }, 'transfer_canceled', message, { entity: 'transferRequest', id: tr.id });
  },
});

action('assignPorter', {
  target: (s, p) => find(s, 'transferRequest', p.transferId),
  scope: (s, t) => transferScope(s, t),
  validate: (s, tr, p) => {
    if (tr.status !== 'reserved') return msg('err.porterNeedsReserved', { ref: tr.ref, status: TRANSFER_STATUS_MSG[tr.status] });
    const u = s.users[p.porterUserId];
    if (!u || u.role !== 'porter' || !u.active || u.hospitalId !== tr.hospitalId) return msg('err.choosePorter');
    if (tr.porterUserId === u.id) return msg('err.porterAlready', { name: u.name });
    return null;
  },
  apply: (tx, tr, p) => {
    tx.update(tr, { porterUserId: p.porterUserId });
    return { summary: msg('audit.porterAssigned', { name: tx.s.users[p.porterUserId].name, tr: tr.ref }) };
  },
  effects: (tx, tr) => {
    tx.notify({ userId: tr.porterUserId }, 'porter_assigned', msg('notifMsg.transportJob', { tr: tr.ref, from: tx.s.beds[tr.fromBedId]?.label ?? msg('dept.ER'), to: tx.s.beds[tr.targetBedId].label }), { entity: 'transferRequest', id: tr.id });
  },
});

function transferDepartureError(s, tr, now) {
  if (tr.status !== 'reserved') return msg('err.departureNeedsReserved', { ref: tr.ref, status: TRANSFER_STATUS_MSG[tr.status] });
  const res = s.reservations[tr.reservationId];
  const state = reservationState(res, now);
  if (state !== 'active') return msg('err.icuReservationState', { ref: tr.ref, state: RESERVATION_STATE_MSG[state] });
  const pending = tr.handoverTaskIds.map((id) => s.tasks[id]).filter((t) => t && isOpenTask(t));
  if (pending.length) return msg('err.handoverIncomplete', { tasks: pending.map((t) => t.title) });
  const loc = s.patients[tr.patientId].location;
  if (loc.department !== 'ER' || !['bed', 'er_waiting'].includes(loc.kind)) return msg('err.patientNotInEr');
  return null;
}

// Departure from the ER for an ICU transfer: ER bed vacated (cleaning), patient "in transit", ICU bed held.
function departForTransfer(tx, tr) {
  const patient = tx.s.patients[tr.patientId];
  const fromBed = patient.location.kind === 'bed' ? tx.s.beds[patient.location.bedId] : null;
  tx.update(patient, { location: { kind: 'in_transit', hospitalId: tr.hospitalId, department: null, transferId: tr.id,
    fromBedId: fromBed?.id ?? null, toBedId: tr.targetBedId, since: tx.now } });
  if (fromBed) vacateBed(tx, fromBed, msg('why.transfer', { ref: tr.ref }));
  tx.update(tx.s.reservations[tr.reservationId], { expiresAt: null, heldDuringTransport: true });
  tx.update(tr, { status: 'in_transit', departedAt: tx.now, departedBy: tx.actor.id });
  return fromBed;
}

function departureMode(s, c, now) {
  if (c.status !== 'active') return { error: caseStatusError(c) };
  const loc = patientOf(s, c).location;
  if (!['bed', 'er_waiting'].includes(loc.kind)) return { error: msg('err.notInBedHere', { alias: patientOf(s, c).alias }) };
  const tr = activeTransferForCase(s, c.id);
  if (tr?.status === 'reserved') {
    const error = transferDepartureError(s, tr, now);
    return error ? { error } : { mode: 'transfer', tr };
  }
  if (loc.department === 'ICU' && c.stepDown?.flagged) return { mode: 'step_down' };
  if (c.disposition) return { mode: c.disposition.decision };
  if (tr) return { error: msg('err.noIcuBedYet', { ref: tr.ref, status: TRANSFER_STATUS_MSG[tr.status] }) };
  return { error: msg('err.nothingAuthorises', { ref: c.ref }) };
}

action('confirmDeparture', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p, actor, now) => departureMode(s, c, now).error ?? null,
  apply: (tx, c) => {
    const { mode, tr } = departureMode(tx.s, c, tx.now);
    if (mode === 'transfer') {
      const fromBed = departForTransfer(tx, tx.s.transferRequests[tr.id]);
      return { summary: msg('audit.departedTransfer', { ref: c.ref, bed: fromBed?.label ?? msg('dept.ER'), tr: tr.ref }), mode, trId: tr.id };
    }
    const patient = patientOf(tx.s, c);
    const bed = patient.location.kind === 'bed' ? tx.s.beds[patient.location.bedId] : null;
    tx.update(patient, { location: { kind: 'departed', hospitalId: patient.location.hospitalId, department: null, reason: mode, since: tx.now } });
    if (bed) vacateBed(tx, bed, WHY_MSG[mode]);
    const res = anyActiveReservationRecord(tx.s, c.id);
    if (res) releaseReservationFor(tx, res, msg('release.departed', { ref: c.ref }));
    if (mode === 'step_down' && c.stepDown.taskId) tx.setTaskStatus(tx.s.tasks[c.stepDown.taskId], 'done', msg('note.departedWard'));
    cancelCaseTasks(tx, c.id, msg('note.departed', { why: WHY_MSG[mode] }));
    c.status = 'closed';
    c.journey = 'departed';
    const n = c.noticeId ? tx.s.arrivalNotices[c.noticeId] : null;
    if (n && n.status !== 'canceled') { tx.update(n, { status: 'closed' }); tx.timeline(n, 'closed', msg('tl.closed', { why: WHY_MSG[mode] })); }
    return { summary: msg('audit.departed', { ref: c.ref, bed: bed?.label ?? msg('dept.ER'), why: WHY_MSG[mode] }), mode, bedId: bed?.id ?? null };
  },
  effects: (tx, c, p, actor, ctx) => {
    if (ctx.mode === 'transfer') {
      const tr = tx.s.transferRequests[ctx.trId];
      tx.notify(toCoordinators(tr.hospitalId, 'ICU'), 'in_transit', msg('notifMsg.inTransit', { ref: c.ref, bed: tx.s.beds[tr.targetBedId].label }), { entity: 'transferRequest', id: tr.id });
      return;
    }
    const bed = ctx.bedId ? tx.s.beds[ctx.bedId] : null;
    if (bed?.department === 'ICU') {
      // A freed ICU bed becomes the suggestion for the oldest request waiting for capacity (the coordinator confirms).
      const suggestions = suggestedBeds(tx.s, bed.hospitalId, tx.now);
      const trId = Object.keys(suggestions).find((id) => suggestions[id] === bed.id);
      if (trId) tx.notify(toCoordinators(bed.hospitalId, 'ICU'), 'bed_suggested', msg('notifMsg.bedFreedSuggestion', { bed: bed.label, tr: tx.s.transferRequests[trId].ref }), { entity: 'transferRequest', id: trId });
    }
  },
});

action('confirmPickup', {
  target: (s, p) => find(s, 'transferRequest', p.transferId),
  scope: (s, t) => transferScope(s, t),
  validate: (s, tr, p, actor, now) => transferDepartureError(s, tr, now),
  apply: (tx, tr) => {
    const fromBed = departForTransfer(tx, tr);
    return { summary: msg('audit.pickup', { ref: tx.s.cases[tr.caseId].ref, bed: fromBed?.label ?? msg('dept.ER'), tr: tr.ref }) };
  },
  effects: (tx, tr) => {
    tx.notify(toCoordinators(tr.hospitalId, 'ICU'), 'in_transit', msg('notifMsg.pickedUp', { tr: tr.ref, bed: tx.s.beds[tr.targetBedId].label }), { entity: 'transferRequest', id: tr.id });
  },
});

action('confirmDropoff', {
  target: (s, p) => find(s, 'transferRequest', p.transferId),
  scope: (s, t) => transferScope(s, t),
  validate: (s, tr) => (tr.status === 'in_transit' ? null : msg('err.notInTransit', { ref: tr.ref })),
  apply: (tx, tr, p, actor) => {
    tx.update(tr, { status: 'arrived', droppedOffAt: tx.now, droppedOffBy: actor.id });
    tx.update(tx.s.patients[tr.patientId], { location: { kind: 'unit_arrival', hospitalId: tr.hospitalId, department: 'ICU', transferId: tr.id, since: tx.now } });
    return { summary: msg('audit.dropoff', { ref: tx.s.cases[tr.caseId].ref }) };
  },
  effects: (tx, tr) => {
    tx.notify(toCoordinators(tr.hospitalId, 'ICU'), 'arrived', msg('notifMsg.droppedOff', { tr: tr.ref, bed: tx.s.beds[tr.targetBedId].label }), { entity: 'transferRequest', id: tr.id });
  },
});

action('flagStepDown', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p) => {
    const loc = patientOf(s, c).location;
    if (c.status !== 'active') return caseStatusError(c);
    if (loc.kind !== 'bed' || loc.department !== 'ICU') return msg('err.stepDownIcuOnly');
    if (c.stepDown?.flagged) return msg('err.alreadyFlagged', { ref: c.ref });
    if (!nonEmpty(p.reason)) return msg('err.reasonRequiredStepDown');
    return null;
  },
  apply: (tx, c, p, actor) => {
    c.stepDown = { flagged: true, reason: p.reason.trim(), by: actor.id, at: tx.now, taskId: null };
    return { summary: msg('audit.stepDown', { ref: c.ref }), reason: p.reason };
  },
  effects: (tx, c, p) => {
    const bed = tx.s.beds[patientOf(tx.s, c).location.bedId];
    const t = tx.task({ category: 'ward_transfer', title: msg('taskTitle.wardStepDown', { alias: patientOf(tx.s, c).alias }),
      linked: { caseId: c.id, patientId: c.patientId, bedId: bed.id }, requiredRole: 'icu_coordinator', department: 'ICU',
      hospitalId: bed.hospitalId, dueMinutes: p.expectedWithinMinutes ?? null });
    c.stepDown = { ...c.stepDown, taskId: t.id };
    tx.notify(toCoordinators(bed.hospitalId, 'ICU'), 'step_down', msg('notifMsg.expectedFree', { bed: bed.label, ref: c.ref }), { entity: 'task', id: t.id });
  },
});

action('recordDisposition', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p) => {
    if (c.status !== 'active') return caseStatusError(c);
    if (!['bed', 'er_waiting'].includes(patientOf(s, c).location.kind)) return msg('err.decisionOnSite');
    if (!['discharge', 'admit_ward'].includes(p.decision)) return msg('err.decisionChoice');
    const tr = activeTransferForCase(s, c.id);
    if (tr) return msg('err.decisionActiveTransfer', { ref: c.ref, tr: tr.ref });
    if (c.disposition?.decision === p.decision) return msg('err.decisionAlready');
    return null;
  },
  apply: (tx, c, p, actor) => {
    c.disposition = { decision: p.decision, note: p.note ?? null, by: actor.id, at: tx.now };
    return { summary: msg('audit.disposition', { decision: DECISION_MSG[p.decision], ref: c.ref }), reason: p.note ?? null };
  },
  effects: (tx, c, p) => {
    const loc = patientOf(tx.s, c).location;
    tx.notify(toCoordinators(loc.hospitalId, loc.department), 'disposition', msg('notifMsg.disposition', { ref: c.ref, decision: DECISION_MSG[p.decision] }), { entity: 'case', id: c.id });
  },
});

// ===========================================================================
// Tasks, diagnostics, notifications
// ===========================================================================
const TASK_FLOWS = {
  cleaning: { open: ['accepted', 'in_progress', 'blocked'], accepted: ['in_progress', 'blocked'], in_progress: ['blocked'], blocked: ['accepted', 'in_progress'] },
  diagnostic: { requested: ['scheduled', 'canceled'], scheduled: ['in_progress', 'canceled'], in_progress: ['report_available'] },
  ward_transfer: { open: ['accepted', 'in_progress'], accepted: ['in_progress'] },
  nursing_verification: { open: ['accepted'] },
  staffing: { open: ['accepted'] },
  equipment_check: { open: ['accepted'] },
  report_review: { open: ['accepted'] },
  default: { open: ['accepted', 'in_progress', 'done'], accepted: ['in_progress', 'done'], in_progress: ['done', 'blocked'], blocked: ['in_progress'] },
};
const COMPLETED_BY = { cleaning: 'completeCleaning', nursing_verification: 'verifyReadiness', staffing: 'confirmStaffing',
  equipment_check: 'recordEquipmentCheck', ward_transfer: 'confirmDeparture', report_review: 'acknowledgeReport' };
const ACTION_MSG = { completeCleaning: msg('actionName.completeCleaning'), verifyReadiness: msg('actionName.verifyReadiness'), confirmStaffing: msg('actionName.confirmStaffing'),
  recordEquipmentCheck: msg('actionName.recordEquipmentCheck'), confirmDeparture: msg('actionName.confirmDeparture'), acknowledgeReport: msg('actionName.acknowledgeReport') };

// The next statuses a task may take, and the dedicated action that completes it (if any). The UI offers
// exactly these, so it never re-implements the task workflow.
export function nextTaskStatuses(task) {
  return [...((TASK_FLOWS[task.category] ?? TASK_FLOWS.default)[task.status] ?? [])];
}
export function completionActionFor(task) {
  if (task.category === 'diagnostic') return task.status === 'report_available' && !task.reportAcknowledged ? 'acknowledgeReport' : null;
  return COMPLETED_BY[task.category] ?? null;
}

const taskScope = (s, t) => ({ entity: 'task', hospitalId: t.hospitalId, department: t.department, requiredRole: t.requiredRole });

action('updateTaskStatus', {
  target: (s, p) => find(s, 'task', p.taskId),
  scope: (s, t) => taskScope(s, t),
  validate: (s, t, p) => {
    if (!isOpenTask(t)) return msg('err.taskAlready', { status: TASK_STATUS_MSG[t.status] });
    const flow = TASK_FLOWS[t.category] ?? TASK_FLOWS.default;
    if (!(flow[t.status] ?? []).includes(p.status)) {
      if (p.status === 'done' && COMPLETED_BY[t.category]) return msg('err.taskCompletesVia', { action: ACTION_MSG[COMPLETED_BY[t.category]] });
      return msg('err.taskTransition', { from: TASK_STATUS_MSG[t.status], to: TASK_STATUS_MSG[p.status] ?? String(p.status) });
    }
    if (p.status === 'blocked' && !nonEmpty(p.note)) return msg('err.describeBlocker');
    if (p.status === 'canceled' && !nonEmpty(p.note)) return msg('err.reasonRequiredCancelTask');
    return null;
  },
  apply: (tx, t, p, actor) => {
    tx.setTaskStatus(t, p.status, p.note ?? null);
    if (['accepted', 'in_progress', 'scheduled', 'done'].includes(p.status) && !t.ownerUserId) t.ownerUserId = actor.id;
    if (t.category === 'cleaning' && t.linked.bedId && p.status !== 'blocked') {
      const bed = tx.s.beds[t.linked.bedId];
      tx.update(bed, { cleaning: { ...bed.cleaning, status: p.status === 'accepted' ? 'assigned' : 'in_progress', since: tx.now } });
    }
    if (t.category === 'ambulance_handover' && p.status === 'done') {
      const c = tx.s.cases[t.linked.caseId];
      const n = tx.s.arrivalNotices[c.noticeId];
      if (n) { tx.update(n, { status: 'handover_complete' }); tx.timeline(n, 'handover_complete', msg('tl.handoverComplete')); }
      if (c.ambulanceAssignmentId) tx.update(tx.s.ambulanceAssignments[c.ambulanceAssignmentId], { status: 'handover_complete' });
    }
    return { summary: msg('audit.taskStatus', { title: t.title, status: TASK_STATUS_MSG[p.status] }), reason: p.note ?? null };
  },
  effects: (tx, t, p) => {
    if (t.category === 'diagnostic' && p.status === 'report_available') {
      const type = DIAG_MSG[t.diagnosticType] ?? msg('diag.other');
      const alias = tx.s.patients[t.linked.patientId]?.alias ?? '';
      const orderer = tx.s.users[t.orderedBy];
      const review = tx.task({ category: 'report_review', title: msg('taskTitle.reportReview', { type }), linked: { ...t.linked, taskId: t.id },
        requiredRole: 'doctor', department: t.department, hospitalId: t.hospitalId, priority: 'high', dueMinutes: 60,
        ownerUserId: orderer?.role === 'doctor' && orderer.department === t.department ? orderer.id : null });
      const message = msg('notifMsg.reportAvailable', { type, alias });
      if (orderer) tx.notify({ userId: orderer.id }, 'report_available', message, { entity: 'task', id: review.id });
      if (!orderer || orderer.department !== t.department) tx.notify(toRole('doctor', t.hospitalId, t.department), 'report_available', message, { entity: 'task', id: review.id });
    }
    if (p.status === 'blocked') {
      tx.notify(toCoordinators(t.hospitalId, t.department ?? 'ER'), 'task_blocked', msg('notifMsg.taskBlocked', { title: t.title, note: p.note }), { entity: 'task', id: t.id });
    }
    if (t.category === 'ambulance_handover' && p.status === 'done') {
      const c = tx.s.cases[t.linked.caseId];
      for (const uid of crewOf(tx.s, c)) tx.notify({ userId: uid }, 'handover_complete', msg('notifMsg.handoverComplete', { ref: c.ref }), { entity: 'case', id: c.id });
    }
    if (['handover_send', 'handover_receive'].includes(t.category) && p.status === 'done') {
      const tr = tx.s.transferRequests[t.linked.transferId];
      if (tr && tr.handoverTaskIds.every((id) => !isOpenTask(tx.s.tasks[id]))) {
        tx.notify(toCoordinators(tr.hospitalId, 'ER'), 'handover_complete', msg('notifMsg.handoverDone', { tr: tr.ref }), { entity: 'transferRequest', id: tr.id });
      }
    }
  },
});

// A doctor orders an investigation; diagnostics staff then move it requested → scheduled → in progress → report available.
action('orderDiagnostic', {
  target: (s, p) => {
    const t = find(s, 'patient', p.patientId);
    return t.missing ? t : { rec: t.rec, noVersion: true }; // ordering never conflicts with patient movement
  },
  scope: (s, patient) => ({ entity: 'patient', hospitalId: patient.location.hospitalId ?? '__offsite__', department: patient.location.department }),
  validate: (s, patient, p) => {
    if (!['bed', 'er_waiting', 'unit_arrival'].includes(patient.location.kind) || !caseOfPatient(s, patient.id)) return msg('err.diagnosticOnSite');
    if (!DIAGNOSTIC_TYPES.includes(p.type)) return msg('err.diagnosticType');
    if (!nonEmpty(p.reason)) return msg('err.reasonRequiredDiagnostic');
    return null;
  },
  apply: (tx, patient, p, actor) => {
    const c = caseOfPatient(tx.s, patient.id);
    const t = tx.task({ category: 'diagnostic', status: 'requested', title: msg('taskTitle.diagnostic', { type: DIAG_MSG[p.type] }), diagnosticType: p.type,
      orderedBy: actor.id, orderReason: p.reason.trim(), reportAcknowledged: null,
      linked: { patientId: patient.id, caseId: c.id, bedId: patient.location.bedId ?? null }, requiredRole: 'diagnostics',
      department: patient.location.department, hospitalId: patient.location.hospitalId, priority: p.priority === 'high' ? 'high' : 'normal' });
    return { summary: msg('audit.diagnosticOrdered', { type: DIAG_MSG[p.type], ref: c.ref }), reason: p.reason, result: { taskId: t.id },
      refs: [{ entity: 'task', id: t.id }, { entity: 'case', id: c.id }], task: t };
  },
  effects: (tx, patient, p, actor, { task }) => {
    tx.notify(toRole('diagnostics', task.hospitalId), 'diagnostic_ordered', msg('notifMsg.diagnosticOrdered', { type: DIAG_MSG[p.type], alias: patient.alias }), { entity: 'task', id: task.id });
  },
});

// The responsible clinician acknowledges the report; this is separate from diagnostics marking it available.
action('acknowledgeReport', {
  target: (s, p) => find(s, 'task', p.taskId),
  scope: (s, t) => ({ entity: 'task', hospitalId: t.hospitalId, department: t.department }),
  validate: (s, t) => {
    if (t.category !== 'diagnostic') return msg('err.notDiagnostic');
    if (t.status !== 'report_available') return msg('err.reportNotAvailable', { status: TASK_STATUS_MSG[t.status] });
    if (t.reportAcknowledged) return msg('err.reportAlreadyAcknowledged');
    return null;
  },
  apply: (tx, t, p, actor) => {
    t.reportAcknowledged = { by: actor.id, at: tx.now, note: p.note ?? null };
    t.history = [...t.history, { at: tx.now, by: actor.id, status: t.status, note: msg('note.reportAcknowledged') }];
    for (const r of openTasksFor(tx.s, (x) => x.category === 'report_review' && x.linked.taskId === t.id)) tx.setTaskStatus(r, 'done', p.note ?? msg('note.reportAcknowledged'));
    const c = tx.s.cases[t.linked.caseId];
    return { summary: msg('audit.reportAcknowledged', { type: DIAG_MSG[t.diagnosticType] ?? msg('diag.other'), ref: c?.ref ?? '' }), reason: p.note ?? null };
  },
});

action('markNotificationRead', {
  target: (s, p) => find(s, 'notification', p.notificationId),
  scope: (s, n, p) => ({ entity: 'notification', recipient: n.to, requesterDevice: p?.deviceRef ?? null }),
  validate: (s, n, p, actor) => (n.readBy.includes(actor.id) ? msg('err.alreadyRead') : null),
  apply: (tx, n, p, actor) => {
    n.readBy = [...n.readBy, actor.id];
    return { summary: msg('audit.notificationRead') };
  },
});

// ===========================================================================
// Comments, staffing gaps, coordinator assignment
// ===========================================================================
const COMMENT_TARGETS = ['case', 'bed', 'task', 'maintenanceTicket', 'transferRequest'];
const MAX_COMMENT = 500;

// Who owns the commented record: specific people first; the owning role group only when nobody is assigned.
function commentRecipients(s, rec, author) {
  const users = new Set();
  let group = null;
  if (rec.entity === 'case') {
    const loc = patientOf(s, rec)?.location;
    if (rec.assignedCoordinatorId) users.add(rec.assignedCoordinatorId);
    if (loc?.kind === 'bed') { const n = confirmedStaffing(s, loc.bedId)?.nurseUserId; if (n) users.add(n); }
    group = toCoordinators(rec.destinationHospitalId, loc?.department ?? 'ER');
  } else if (rec.entity === 'bed') {
    const n = confirmedStaffing(s, rec.id)?.nurseUserId;
    if (n) users.add(n);
    group = toCoordinators(rec.hospitalId, rec.department);
  } else if (rec.entity === 'task') {
    if (rec.ownerUserId) users.add(rec.ownerUserId);
    group = ['nurse', 'doctor'].includes(rec.requiredRole) ? toRole(rec.requiredRole, rec.hospitalId, rec.department) : toRole(rec.requiredRole, rec.hospitalId);
  } else if (rec.entity === 'maintenanceTicket') {
    if (rec.assignedTo) users.add(rec.assignedTo);
    group = toRole(rec.kind === 'equipment' ? 'biomed_tech' : 'maintenance_tech', rec.hospitalId);
  } else if (rec.entity === 'transferRequest') {
    users.add(rec.requestedBy);
    if (rec.porterUserId) users.add(rec.porterUserId);
    group = toCoordinators(rec.hospitalId, 'ICU');
  }
  users.delete(author.id);
  if (users.size) return [...users].map((userId) => ({ userId }));
  const authorInGroup = group && group.role === author.role && group.hospitalId === author.hospitalId;
  return group && !authorInGroup ? [group] : [];
}

action('addComment', {
  // The subject is context only: commenting never bumps its version or conflicts with other edits.
  target: (s, p) => {
    if (!COMMENT_TARGETS.includes(p.targetType)) return { missing: msg('err.commentTargets') };
    const t = find(s, p.targetType, p.targetId);
    return t.missing ? t : { rec: t.rec, noVersion: true };
  },
  scope: (s, rec) => ({ entity: 'comment', hospitalId: rec.entity === 'case' ? rec.destinationHospitalId : rec.hospitalId }),
  validate: (s, rec, p) => {
    if (!nonEmpty(p.text)) return msg('err.writeComment');
    if (p.text.trim().length > MAX_COMMENT) return msg('err.commentTooLong', { max: MAX_COMMENT });
    return null;
  },
  apply: (tx, rec, p, actor) => {
    const cm = tx.create('comment', { kind: 'note', targetType: rec.entity, targetId: rec.id, caseId: rec.entity === 'case' ? rec.id : null,
      body: p.text.trim(), authorId: actor.id, status: null }, 'cm');
    return { summary: msg('audit.comment', { record: recordName(rec) }), result: { commentId: cm.id },
      refs: [{ entity: rec.entity, id: rec.id }, { entity: 'comment', id: cm.id }], comment: cm };
  },
  effects: (tx, rec, p, actor, { comment }) => {
    const message = msg('notifMsg.comment', { name: actor.name, record: recordName(rec), text: comment.body });
    for (const to of commentRecipients(tx.s, rec, actor)) tx.notify(to, 'comment', message, { entity: rec.entity, id: rec.id });
  },
});

action('reportStaffingGap', {
  target: (s, p) => find(s, 'bed', p.bedId),
  scope: (s, b) => bedScope(s, b),
  validate: (s, bed, p) => {
    if (!confirmedStaffing(s, bed.id)) return msg('err.staffingAlreadyUnavailable', { bed: bed.label });
    if (!nonEmpty(p.reason)) return msg('err.reasonRequiredStaffingGap');
    return null;
  },
  apply: (tx, bed, p, actor) => {
    const a = values(tx.s, 'staffingAssignments').find((x) => x.bedId === bed.id);
    tx.update(a, { status: 'unavailable', previousNurseUserId: a.nurseUserId, nurseUserId: null, reason: p.reason.trim(),
      reportedBy: actor.id, reportedAt: tx.now, confirmedBy: null, confirmedAt: null });
    return { summary: msg('audit.staffingGap', { bed: bed.label }), reason: p.reason, previousNurse: a.previousNurseUserId };
  },
  effects: (tx, bed, p, actor, ctx) => {
    const occupied = bed.occupancy.status === 'occupied';
    tx.notify(toCoordinators(bed.hospitalId, bed.department), 'staffing_gap',
      (occupied ? msg('notifMsg.staffingGapUrgent', { bed: bed.label, reason: p.reason.trim() }) : msg('notifMsg.staffingGap', { bed: bed.label, reason: p.reason.trim() })), { entity: 'bed', id: bed.id }, occupied);
    if (ctx.previousNurse) tx.notify({ userId: ctx.previousNurse }, 'staffing_gap', msg('notifMsg.unassignedFromBed', { bed: bed.label }), { entity: 'bed', id: bed.id });
    // ER gaps get a coordinator task; ICU prep tasks only come from capacity confirmation for a transfer.
    if (bed.department === 'ER' && !openTasksFor(tx.s, (t) => t.category === 'staffing' && t.linked.bedId === bed.id).length) {
      tx.task({ category: 'staffing', title: msg('taskTitle.findCover', { bed: bed.label }), linked: { bedId: bed.id }, requiredRole: 'er_coordinator',
        department: 'ER', hospitalId: bed.hospitalId, priority: occupied ? 'high' : 'normal', dueMinutes: SLA_MINUTES.staffing });
    }
  },
});

action('assignCoordinator', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p) => {
    if (c.status !== 'active') return caseStatusError(c);
    const u = s.users[p.coordinatorId];
    if (!u || u.role !== 'er_coordinator' || !u.active || u.hospitalId !== c.destinationHospitalId) return msg('err.coordinatorChoose');
    if (c.assignedCoordinatorId === u.id) return msg('err.coordinatorAlready', { name: u.name, ref: c.ref });
    return null;
  },
  apply: (tx, c, p) => {
    const previous = c.assignedCoordinatorId;
    c.assignedCoordinatorId = p.coordinatorId;
    return { summary: msg('audit.coordinator', { ref: c.ref, name: tx.s.users[p.coordinatorId].name }), previous };
  },
  effects: (tx, c, p, actor) => {
    if (p.coordinatorId !== actor.id) tx.notify({ userId: p.coordinatorId }, 'assigned', msg('notifMsg.coordinatorAssigned', { ref: c.ref }), { entity: 'case', id: c.id });
  },
});


// ===========================================================================
// Ambulance crew status: sent → (acknowledged by the ER) → en route → arrived → (handover completed by the ER)
// ===========================================================================
// Arrival at the ER door (not a bed placement): shared by confirmArrival and the crew's "Arrived".
function arriveAtEr(tx, c) {
  tx.update(patientOf(tx.s, c), { location: { kind: 'er_waiting', hospitalId: c.destinationHospitalId, department: 'ER', since: tx.now } });
  tx.update(c, { journey: 'triage_pending', arrivedAt: tx.now });
  const n = tx.s.arrivalNotices[c.noticeId];
  if (n) { tx.update(n, { status: 'arrived' }); tx.timeline(n, 'arrived', msg('tl.arrived', { hospital: hospitalName(tx.s, c.destinationHospitalId) })); }
  if (c.ambulanceAssignmentId) tx.update(tx.s.ambulanceAssignments[c.ambulanceAssignmentId], { status: 'arrived' });
}
function afterErArrival(tx, c) {
  if (c.source === 'ambulance') {
    tx.task({ category: 'ambulance_handover', title: msg('taskTitle.ambulanceHandover', { ref: c.ref }), linked: { caseId: c.id, patientId: c.patientId },
      requiredRole: 'nurse', department: 'ER', hospitalId: c.destinationHospitalId, priority: 'high', dueMinutes: 15 });
  }
  tx.notify(toCoordinators(c.destinationHospitalId, 'ER'), 'arrived', msg('notifMsg.arrived', { ref: c.ref }), { entity: 'case', id: c.id });
}

const CREW_NEXT = { en_route: ['submitted', 'acknowledged'], arrived: ['en_route'] };
action('updateCrewStatus', {
  target: (s, p) => find(s, 'case', p.caseId),
  scope: (s, c, p) => caseScope(s, c, p),
  validate: (s, c, p) => {
    if (p.status === 'acknowledged') return msg('err.crewCannotAcknowledge');
    if (p.status === 'handover_complete') return msg('err.crewCannotCompleteHandover');
    if (!CREW_NEXT[p.status]) return msg('err.crewStatusUnknown');
    if (c.status !== 'active') return caseStatusError(c);
    if (patientOf(s, c).location.kind !== 'pre_hospital') return msg('err.caseOnSite', { ref: c.ref });
    const from = s.arrivalNotices[c.noticeId]?.status;
    if (!CREW_NEXT[p.status].includes(from)) return msg('err.crewStatusTransition', { from: NOTICE_STATUS_MSG[from] ?? NO_TEXT, to: NOTICE_STATUS_MSG[p.status] });
    return null;
  },
  apply: (tx, c, p) => {
    if (p.status === 'arrived') {
      arriveAtEr(tx, c);
    } else {
      const n = tx.s.arrivalNotices[c.noticeId];
      tx.update(n, { status: 'en_route' });
      tx.timeline(n, 'en_route', msg('tl.enRoute'));
      if (c.ambulanceAssignmentId) tx.update(tx.s.ambulanceAssignments[c.ambulanceAssignmentId], { status: 'en_route' });
    }
    return { summary: msg('audit.crewStatus', { ref: c.ref, status: NOTICE_STATUS_MSG[p.status] }) };
  },
  effects: (tx, c, p) => {
    if (p.status === 'arrived') afterErArrival(tx, c);
    else tx.notify(toCoordinators(c.destinationHospitalId, 'ER'), 'eta_changed', msg('notifMsg.crewEnRoute', { ref: c.ref }), { entity: 'case', id: c.id });
  },
});
