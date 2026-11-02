// Detail drawers for a bed and for a case. Live: re-rendered on every store change.

import { values } from '../data.js';
import { latestEquipmentCheck, isCheckValid, describeLocation, activeTransferForCase, activeReservationForCase, deriveTransferStatus } from '../readiness.js';
import { bedBoardStatus, careTasksForPatient, bedWorkTasks } from '../selectors.js';
import { t, tm, formatTime, formatRelative } from '../i18n.js';
import { h, clear } from './dom.js';
import { icon, ambulanceIllustration } from './icons.js';
import { ctx, state, now, canSeePatient, closeDrawer } from './core.js';
import { pill, emptyState, actionButton, uiButton, forecastLine, blockerList, historyList, commentsSection, userName } from './components.js';
import { taskRow } from './taskui.js';
import {
  openFault, openStaffingGap, openConfirmStaffing, openEquipmentCheck, openResolve, openReopen, openExtend, openRelease,
  openClarify, openAssignCoordinator, openCancelCase, openTriage, openDisposition, openTransferRequest,
} from './forms.js';
import { openReserveForBed, openReserveForCase } from './placement.js';
import { transferDrawer, openStepDown, openOrderDiagnostic } from './transfer.js';

const CAPABILITY_KEY = { monitor: 'equipment.monitor', oxygen: 'equipment.oxygen', ventilator: 'req.ventilator', isolation: 'req.isolation' };
const section = (title, iconName, ...children) => h('section', {}, h('h3', {}, icon(iconName, { size: 16 }), title), ...children);
const facts = (pairs) => h('dl', { class: 'facts' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v)]));

export function renderDrawer(root) {
  clear(root);
  const d = ctx.ui.drawer;
  if (!d) return;
  const s = state();
  const rec = d.type === 'bed' ? s.beds[d.id] : d.type === 'transfer' ? s.transferRequests[d.id] : s.cases[d.id];
  if (!rec) { ctx.ui.drawer = null; return; }
  const content = d.type === 'bed' ? bedDrawer(s, rec) : d.type === 'transfer' ? transferDrawer(s, rec) : caseDrawer(s, rec);
  root.append(
    h('div', { class: 'drawer-backdrop', onclick: closeDrawer }),
    h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drawer-title' },
      h('header', {}, content.headIcon, h('div', {}, h('h2', { id: 'drawer-title', text: content.title }), content.sub),
        h('div', { class: 'end' }, h('button', { type: 'button', class: 'btn ghost icon-btn', 'aria-label': t('drawer.close'), 'data-drawer-close': '', onclick: closeDrawer }, icon('close')))),
      h('div', { class: 'body' }, content.body)));
}

// ---------------------------------------------------------------------------
// Bed
// ---------------------------------------------------------------------------
function bedDrawer(s, bed) {
  const n = now();
  const st = bedBoardStatus(bed, s, n);
  const showP = canSeePatient(bed.hospitalId);
  const patient = bed.occupancy.patientId ? s.patients[bed.occupancy.patientId] : null;
  const kase = patient ? values(s, 'cases').find((c) => c.patientId === patient.id && c.status === 'active') : null;
  const staffing = values(s, 'staffingAssignments').find((a) => a.bedId === bed.id);
  const tickets = values(s, 'maintenanceTickets').filter((x) => x.bedId === bed.id)
    .sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || Date.parse(b.reportedAt) - Date.parse(a.reportedAt)).slice(0, 6);
  const res = st.reservation;
  const v = bed.nursingVerification;

  const body = [
    section(t('drawer.readiness'), 'alert', blockerList(st.readiness.blockers),
      st.forecast ? h('div', {}, h('h4', { class: 'small muted', text: t('drawer.forecast') }), forecastLine(st.forecast)) : null),
    section(t('drawer.actions'), 'spark', h('p', { class: 'small muted', text: t('drawer.actionsHint') }), h('div', { class: 'action-grid' }, bedActions(s, bed, st, kase))),
    section(t('drawer.facts'), 'bed', facts([
      [t('drawer.occupancy'), patient ? (showP ? t('bed.occupiedBy', { alias: patient.alias, ref: kase?.ref ?? '' }) : t('bed.occupiedHidden')) : t('bed.vacant')],
      [t('drawer.nurse'), staffing?.status === 'confirmed' ? userName(staffing.nurseUserId) : `${t('bed.noNurse')}${staffing?.reason ? ` — ${staffing.reason}` : ''}`],
      [t('drawer.cleaning'), `${t(`cleaning.${bed.cleaning.status}`)} · ${formatRelative(bed.cleaning.since, n)}`],
      bed.occupancy.status === 'vacant' ? [t('drawer.verification'), v.status === 'verified' ? t('drawer.verified', { time: formatTime(v.at), name: userName(v.by) }) : t('drawer.verificationPending')] : null,
      [t('drawer.reservation'), res ? `${t('bed.reservedFor', { ref: s.cases[res.caseId]?.ref, time: res.expiresAt ? formatTime(res.expiresAt) : '—' })}${res.expiresAt ? ` · ${t('reservation.expires', { time: formatTime(res.expiresAt), rel: formatRelative(res.expiresAt, n) })}` : ` · ${t('reservation.held')}`}` : t('drawer.noReservation')],
      [t('bed.capabilities'), h('span', {}, Object.entries(bed.capabilities).filter(([, on]) => on).map(([k]) => h('span', { class: 'chip', text: t(CAPABILITY_KEY[k]) })))],
      [t('bed.requiredEquipment'), h('span', {}, bed.requiredEquipment.map((eq) => {
        const c = latestEquipmentCheck(s, bed.id, eq);
        return h('span', { class: 'chip' }, icon(isCheckValid(c) ? 'check' : 'alert', { size: 13 }), `${t(`equipment.${eq}`)}: ${isCheckValid(c) ? t('bed.checkOk', { time: formatTime(c.checkedAt) }) : t('bed.checkNeeded')}`);
      }))],
    ])),
    section(t('drawer.tickets'), 'wrench', tickets.length ? h('ul', { class: 'rows' }, tickets.map((x) => ticketRow(s, x))) : emptyState(t('drawer.noTickets'), 'check')),
    section(t('drawer.bedWork'), 'tasks', (() => {
      const work = bedWorkTasks(s, bed.id);
      return work.length ? h('ul', { class: 'rows' }, work.map((task) => taskRow(task))) : emptyState(t('empty.bedWork'), 'tasks');
    })()),
    patient ? h('section', { class: 'care-section' }, h('h3', {}, icon('stethoscope', { size: 16 }), t('drawer.patientCare')),
      h('p', { class: 'small muted', text: t('drawer.patientCareNote') }),
      showP ? careBlock(s, kase, patient) : h('p', { class: 'notice' }, icon('lock', { size: 16 }), h('span', { text: t('drawer.patientHidden') }))) : null,
    section(t('drawer.comments'), 'comment', commentsSection('bed', bed.id)),
    section(t('drawer.history'), 'history', historyList('bed', bed.id)),
  ];
  return {
    title: t('drawer.bedTitle', { bed: bed.label }),
    sub: h('p', { class: 'small muted' }, `${t('bed.zone', { zone: bed.zone })} · `, pill(st.level), st.urgent ? [' ', pill('urgent', t('bed.urgent'))] : null),
    headIcon: icon('bed', { size: 24 }),
    body,
  };
}

function bedActions(s, bed, st, kase) {
  const out = [];
  const add = (x) => x && out.push(x);
  const res = st.reservation;
  const cleaningPending = ['required', 'assigned', 'in_progress'].includes(bed.cleaning.status);
  const vacant = bed.occupancy.status === 'vacant';
  if (st.level === 'ready') add(actionButton({ action: 'reserveBed', payload: { bedId: bed.id }, label: t('action.reserveForPatient'), kind: 'primary', iconName: 'lock', open: () => openReserveForBed(bed) }));
  if (res) {
    add(actionButton({ action: 'confirmPlacement', payload: { bedId: bed.id, caseId: res.caseId }, label: `${t('action.confirmPlacement')} · ${s.cases[res.caseId]?.ref}`, kind: 'primary', iconName: 'check' }));
    add(actionButton({ action: 'extendReservation', payload: { reservationId: res.id }, label: t('action.extendReservation'), iconName: 'clock', open: (seen) => openExtend(res, seen) }));
    add(actionButton({ action: 'releaseReservation', payload: { reservationId: res.id }, label: t('action.releaseReservation'), kind: 'danger', open: (seen) => openRelease(res, seen) }));
  }
  if (cleaningPending) add(actionButton({ action: 'completeCleaning', payload: { bedId: bed.id }, label: t('action.completeCleaning'), iconName: 'broom' }));
  if (vacant && bed.nursingVerification.status !== 'verified') add(actionButton({ action: 'verifyReadiness', payload: { bedId: bed.id }, label: t('action.verifyReadiness'), iconName: 'nurse' }));
  const staffed = values(s, 'staffingAssignments').some((a) => a.bedId === bed.id && a.status === 'confirmed');
  add(staffed
    ? actionButton({ action: 'reportStaffingGap', payload: { bedId: bed.id }, label: t('action.reportStaffingGap'), kind: 'danger', iconName: 'staff', open: (seen) => openStaffingGap(bed, seen) })
    : actionButton({ action: 'confirmStaffing', payload: { bedId: bed.id }, label: t('action.confirmStaffing'), iconName: 'staff', open: (seen) => openConfirmStaffing(bed, seen) }));
  add(actionButton({ action: 'reportFault', payload: { bedId: bed.id }, label: t('action.reportFault'), iconName: 'wrench', open: (seen) => openFault(bed, seen) }));
  add(actionButton({ action: 'recordEquipmentCheck', payload: { bedId: bed.id }, label: t('action.recordEquipmentCheck'), iconName: 'monitor', open: (seen) => openEquipmentCheck(bed, seen) }));
  if (kase) caseClinicalActions(s, kase).forEach(add);
  return out;
}

// Doctor / departure actions for a patient in a bed (shared by both drawers).
function caseClinicalActions(s, c) {
  const tr = activeTransferForCase(s, c.id);
  const patient = s.patients[c.patientId];
  const inIcu = patient.location.kind === 'bed' && patient.location.department === 'ICU';
  return [
    tr ? uiButton(t('action.openTransfer'), () => { ctx.ui.drawer = { type: 'transfer', id: tr.id }; ctx.render?.(); }, { kind: 'primary', iconName: 'transfer', 'data-focus-key': `open:transfer:${tr.id}` }) : null,
    actionButton({ action: 'confirmDeparture', payload: { caseId: c.id }, label: t('action.confirmDeparture'), iconName: 'transfer' }),
    c.disposition ? null : actionButton({ action: 'recordDisposition', payload: { caseId: c.id }, label: t('action.recordDisposition'), iconName: 'stethoscope', open: (seen) => openDisposition(c, seen) }),
    tr || inIcu ? null : actionButton({ action: 'requestTransfer', payload: { caseId: c.id }, label: t('action.requestTransfer'), iconName: 'transfer', open: (seen) => openTransferRequest(c, seen) }),
    inIcu && !c.stepDown?.flagged ? actionButton({ action: 'flagStepDown', payload: { caseId: c.id }, label: t('action.flagStepDown'), iconName: 'clock', open: (seen) => openStepDown(c, seen) }) : null,
    actionButton({ action: 'orderDiagnostic', payload: { patientId: patient.id }, label: t('action.orderDiagnostic'), iconName: 'monitor', open: () => openOrderDiagnostic(patient) }),
  ];
}

export function ticketRow(s, x, extra = null) {
  const open = x.status !== 'resolved';
  return h('li', { class: ['row', open && 'overdue'] }, icon(x.kind === 'technical' ? 'wrench' : 'monitor'),
    h('div', { class: 'grow' },
      h('strong', { text: `${x.ref} · ${tm(x.category)}` }),
      h('span', { class: 'small' }, pill(open ? 'blocked' : 'ready', t(`ticket.status.${x.status}`)), ' ',
        h('span', { class: 'chip', text: t(`ticket.kind.${x.kind}`) }), h('span', { class: 'chip', text: t(`severity.${x.severity}`) })),
      h('span', { text: x.description }),
      h('span', { class: 'small muted', text: t('drawer.ticketReported', { time: formatTime(x.reportedAt), name: userName(x.reportedBy) }) }),
      open ? h('span', { class: 'small muted', text: `${x.dueAt ? t('task.due', { time: formatTime(x.dueAt), rel: formatRelative(x.dueAt, now()) }) : t('task.noDue')} · ${x.assignedTo ? t('task.owner', { name: userName(x.assignedTo) }) : t('common.unassigned')}` })
        : h('span', { class: 'small', text: t('drawer.ticketResolved', { time: formatTime(x.resolvedAt), text: x.resolution }) }),
      extra,
      h('div', { class: 'action-row' }, ticketButtons(x))));
}

export function ticketButtons(x) {
  if (x.status === 'resolved') {
    return [actionButton({ action: 'reopenTicket', payload: { ticketId: x.id }, label: t('action.reopenTicket'), small: true, kind: 'danger', open: (seen) => openReopen(x, seen) })];
  }
  return [
    x.status === 'open' ? actionButton({ action: 'updateTicketStatus', payload: { ticketId: x.id, status: 'assigned' }, label: t('action.ticketAssigned'), small: true }) : null,
    x.status !== 'in_progress' ? actionButton({ action: 'updateTicketStatus', payload: { ticketId: x.id, status: 'in_progress' }, label: t('action.ticketInProgress'), small: true }) : null,
    actionButton({ action: 'resolveFault', payload: { ticketId: x.id }, label: t('action.resolveFault'), small: true, kind: 'primary', open: (seen) => openResolve(x, seen) }),
  ];
}

function careBlock(s, c, patient) {
  const tasks = careTasksForPatient(s, patient.id);
  const tr = c ? activeTransferForCase(s, c.id) : null;
  return h('div', { class: 'rows' },
    facts([
      [t('drawer.patient'), `${patient.alias}${patient.approxAge ? ` · ${patient.approxAge}` : ''}${c ? ` · ${c.ref}` : ''}`],
      c ? [t('drawer.journey'), t(`journey.${c.journey}`)] : null,
      c?.disposition ? [t('disposition.decision'), t('drawer.disposition', { decision: t(`disposition.${c.disposition.decision}`) })] : null,
      tr ? [t('er.icuRequests'), t('drawer.transfer', { ref: tr.ref, status: deriveTransferStatus(tr, s, now()).label })] : null,
    ]),
    tasks.length ? h('ul', { class: 'rows' }, tasks.map((task) => taskRow(task))) : emptyState(t('empty.careTasks'), 'stethoscope'),
    c ? uiButton(t('action.openCase'), () => { ctx.ui.drawer = { type: 'case', id: c.id }; ctx.ui.highlight = { type: 'case', id: c.id }; ctx.render?.(); }, { small: true, iconName: 'comment' }) : null);
}

// ---------------------------------------------------------------------------
// Case (incoming handover / transcript, or a patient in the ER)
// ---------------------------------------------------------------------------
function caseDrawer(s, c) {
  const n = now();
  const notice = c.noticeId ? s.arrivalNotices[c.noticeId] : null;
  const amb = c.ambulanceAssignmentId ? s.ambulanceAssignments[c.ambulanceAssignmentId] : null;
  const patient = s.patients[c.patientId];
  const showP = canSeePatient(c.destinationHospitalId);
  const res = activeReservationForCase(s, c.id, n);
  const tr = activeTransferForCase(s, c.id);
  const clarifications = values(s, 'comments').filter((cm) => cm.caseId === c.id && cm.kind === 'clarification');

  const body = [
    section(t('drawer.patient'), 'person', facts([
      [t('drawer.patient'), showP ? `${patient.alias}${patient.approxAge ? ` · ${patient.approxAge}` : ''}` : t('drawer.patientHidden')],
      [t('drawer.location'), tm(describeLocation(s, patient))],
      [t('drawer.journey'), t(`journey.${c.journey}`)],
      [t('incoming.acuity'), c.triage ? t('incoming.triageValue', { p: c.triage.priority }) : t('incoming.notAssessed')],
      c.crewAcuity ? [t('drawer.handover'), t('incoming.crewAcuity', { level: c.crewAcuity.level })] : null,
      [t('incoming.coordinator'), userName(c.assignedCoordinatorId)],
      [t('incoming.bed'), res ? t('incoming.reservedUntil', { bed: s.beds[res.bedId].label, time: res.expiresAt ? formatTime(res.expiresAt) : t('reservation.held') }) : t('incoming.noBed')],
      c.disposition ? [t('disposition.decision'), t('drawer.disposition', { decision: t(`disposition.${c.disposition.decision}`) })] : null,
      tr ? [t('er.icuRequests'), t('drawer.transfer', { ref: tr.ref, status: deriveTransferStatus(tr, s, n).label })] : null,
    ])),
    section(t('drawer.actions'), 'spark', h('p', { class: 'small muted', text: t('drawer.actionsHint') }), h('div', { class: 'action-grid' }, caseActions(s, c, notice, res))),
  ];

  if (!showP) {
    body.push(h('p', { class: 'notice' }, icon('lock', { size: 16 }), h('span', { text: t('drawer.patientHidden') })));
  } else {
    if (notice) {
      const r = notice.reported ?? {};
      body.push(section(t('drawer.reported'), 'comment',
        h('p', { class: 'small' }, pill('pending', t('incoming.unverified'), 'info'), ' ', t('drawer.extraction', { method: t(`extraction.${notice.extractionMethod}`) })),
        facts([
          [t('incoming.reported'), r.concern ?? c.reportedConcern ?? t('common.unknown')],
          [t('field.age'), r.ageText ?? t('common.unknown')],
          [t('field.onset'), r.onset ?? t('common.unknown')],
          [t('field.awakeBreathing'), t(`awake.${r.awakeBreathing ?? 'unknown'}`)],
          [t('field.conditions'), r.conditions ?? t('common.unknown')],
          [t('field.allergies'), r.allergies ?? t('common.unknown')],
          [t('field.patientCount'), String(r.patientCount ?? 1)],
          [t('field.location'), r.location ?? t('common.unknown')],
          [t('field.transport'), t(`transport.${notice.transportMode ?? 'unknown'}`)],
          [t('field.accessibility'), r.accessibilityNeeds ?? t('common.unknown')],
          [t('incoming.eta'), notice.etaAt ? `${t('incoming.etaValue', { time: formatTime(notice.etaAt), rel: formatRelative(notice.etaAt, n) })} (${t('incoming.etaSimulated')})` : t('incoming.etaUnknown')],
        ]),
        h('h4', { class: 'small muted', text: t('drawer.transcript') }),
        notice.transcript ? h('blockquote', { class: 'notice', text: notice.transcript }) : h('p', { class: 'small muted', text: t('drawer.noTranscript') })));
      if (notice.handover) body.push(handoverSection(notice.handover));
      body.push(section(t('drawer.clarifications'), 'comment', clarifications.length ? h('ol', { class: 'timeline' }, clarifications.map((cm) => h('li', {},
        h('time', { datetime: cm.createdAt, text: formatTime(cm.createdAt) }),
        h('div', {}, h('p', {}, h('strong', { text: userName(cm.authorId) }), ` · ${cm.body}`),
          h('p', { class: 'small', text: cm.status === 'answered' ? t('drawer.answer', { text: cm.answer }) : t('drawer.awaitingAnswer') }))))) : emptyState(t('empty.clarifications'), 'comment')));
      body.push(section(t('drawer.timeline'), 'clock', notice.timeline.length ? h('ol', { class: 'timeline' }, [...notice.timeline].reverse().map((e) => h('li', {},
        h('time', { datetime: e.at, text: formatTime(e.at) }), h('div', {}, h('strong', { text: userName(e.by) }), ` · ${tm(e.detail)}`)))) : emptyState(t('empty.timeline'), 'clock')));
    }
    const tasks = careTasksForPatient(s, patient.id);
    body.push(h('section', { class: 'care-section' }, h('h3', {}, icon('stethoscope', { size: 16 }), t('drawer.patientCare')),
      h('p', { class: 'small muted', text: t('drawer.patientCareNote') }),
      tasks.length ? h('ul', { class: 'rows' }, tasks.map((task) => taskRow(task))) : emptyState(t('empty.careTasks'), 'stethoscope')));
  }
  body.push(section(t('drawer.comments'), 'comment', commentsSection('case', c.id)));
  body.push(section(t('drawer.history'), 'history', historyList('case', c.id)));

  return {
    title: t('drawer.caseTitle', { ref: c.ref }),
    sub: h('p', { class: 'small muted' }, amb ? t('source.ambulanceId', { id: amb.ambulanceId }) : t(`source.${c.source}`), ' · ',
      notice ? pill('neutral', t(`notice.${notice.status}`), 'info') : pill('neutral', t(`journey.${c.journey}`), 'info')),
    headIcon: amb ? ambulanceIllustration() : icon('person', { size: 24 }),
    body,
  };
}

function handoverSection(ho) {
  return section(t('drawer.handover'), 'ambulance',
    ho.crewAcuity ? h('p', {}, pill('neutral', t('incoming.crewAcuity', { level: ho.crewAcuity.level }), 'ambulance')) : null,
    h('h4', { class: 'small muted', text: t('drawer.vitals') }),
    ho.vitals?.length ? h('ul', { class: 'small' }, ho.vitals.map((v) => h('li', { text: t('drawer.vitalLine', { name: v.name, value: v.value, unit: v.unit, time: formatTime(v.at) }) }))) : h('p', { class: 'small muted', text: t('common.none') }),
    facts([
      [t('drawer.interventions'), ho.interventions?.length ? ho.interventions.join('; ') : t('common.none')],
      [t('drawer.historyField'), ho.history ?? t('common.unknown')],
      [t('field.allergies'), ho.allergies ?? t('common.unknown')],
      [t('drawer.receiving'), ho.receivingRequirements ?? t('common.none')],
    ]));
}

function caseActions(s, c, notice, res) {
  const loc = s.patients[c.patientId].location.kind;
  const anyBed = values(s, 'beds').find((b) => b.hospitalId === c.destinationHospitalId && b.department === 'ER');
  const list = [];
  const add = (x) => x && list.push(x);
  if (c.status !== 'active') return [emptyState(t(`journey.${c.journey}`), 'info')];
  if (loc === 'pre_hospital') {
    if (notice && !notice.acknowledged) add(actionButton({ action: 'acknowledgeArrival', payload: { caseId: c.id }, label: t('action.acknowledgeArrival'), kind: 'primary', iconName: 'check' }));
    add(actionButton({ action: 'confirmArrival', payload: { caseId: c.id }, label: t('action.confirmArrival'), iconName: 'person' }));
  }
  if (notice) add(actionButton({ action: 'requestClarification', payload: { caseId: c.id }, label: t('action.requestClarification'), iconName: 'comment', open: (seen) => openClarify(c, seen) }));
  add(actionButton({ action: 'assignCoordinator', payload: { caseId: c.id }, label: t('action.assignCoordinator'), iconName: 'staff', open: (seen) => openAssignCoordinator(c, seen) }));
  if (['pre_hospital', 'er_waiting'].includes(loc)) {
    if (res) {
      add(actionButton({ action: 'confirmPlacement', payload: { bedId: res.bedId, caseId: c.id }, label: `${t('action.confirmPlacement')} · ${s.beds[res.bedId].label}`, kind: 'primary', iconName: 'bed' }));
      add(actionButton({ action: 'extendReservation', payload: { reservationId: res.id }, label: t('action.extendReservation'), iconName: 'clock', open: (seen) => openExtend(res, seen) }));
      add(actionButton({ action: 'releaseReservation', payload: { reservationId: res.id }, label: t('action.releaseReservation'), kind: 'danger', open: (seen) => openRelease(res, seen) }));
    } else {
      add(actionButton({ action: 'reserveBed', payload: { bedId: anyBed?.id, caseId: c.id }, label: t('action.reserveBed'), iconName: 'lock', open: () => openReserveForCase(c) }));
    }
  }
  if (loc === 'er_waiting' && !c.triage) add(actionButton({ action: 'recordTriage', payload: { caseId: c.id }, label: t('action.recordTriage'), iconName: 'hourglass', open: (seen) => openTriage(c, seen) }));
  if (loc === 'bed' || loc === 'er_waiting') caseClinicalActions(s, c).forEach(add);
  if (loc === 'pre_hospital') add(actionButton({ action: 'cancelCase', payload: { caseId: c.id }, label: t('action.cancelCase'), kind: 'danger', open: (seen) => openCancelCase(c, seen) }));
  return list;
}

