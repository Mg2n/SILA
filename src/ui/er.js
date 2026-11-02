// ER dashboard: count tiles (selectors.js) that filter the board, incoming cards, the in-ER list, bed map,
// ICU requests and overdue work.

import { values } from '../data.js';
import { deriveTransferStatus, activeReservationForCase } from '../readiness.js';
import { erDashboard, erBeds, ER_TILE_KEYS, selectRecentlyCanceled } from '../selectors.js';
import { t, tm, formatTime, formatRelative } from '../i18n.js';
import { h, append } from './dom.js';
import { icon, ambulanceIllustration } from './icons.js';
import { ctx, state, now, currentUser, canSeePatient, requestRender, viewedRevision } from './core.js';
import { acuityLabel } from './handover.js';
import { pill, emptyState, panel, actionButton, uiButton, userName, roleLabel, highlightClass } from './components.js';
import { bedCard, tileGrid, inTransitPanel, openDrawer } from './beds.js';
import { openClarify, openAssignCoordinator, openCancelCase, openTriage, openExtend, openRelease } from './forms.js';
import { openReserveForCase } from './placement.js';

const TILE_ICON = { incoming: 'ambulance', awaitingTriage: 'hourglass', waiting: 'clock', inCare: 'person', available: 'check', reserved: 'lock',
  beingCleaned: 'broom', blockedMaintenance: 'wrench', blockedEquipment: 'monitor', blockedStaffing: 'staff', icuRequests: 'transfer', overdueTasks: 'alert' };
const TILE_TONE = { available: 'good', awaitingTriage: 'warn', beingCleaned: 'warn', blockedMaintenance: 'alert', blockedEquipment: 'alert', blockedStaffing: 'alert', overdueTasks: 'alert' };


export function renderEr(main) {
  const s = state();
  const user = currentUser();
  const hId = user.hospitalId;
  const n = now();
  const dash = erDashboard(s, hId, n);
  const filter = ctx.ui.tileFilter && dash[ctx.ui.tileFilter] ? ctx.ui.tileFilter : null;
  const only = filter ? new Set(dash[filter].ids) : null;
  const kind = filter ? dash[filter].kind : null;

  append(main, [
    h('div', { class: 'page-head' },
      h('h1', { text: t('er.title', { hospital: s.hospitals[hId]?.name ?? '' }) }),
      h('p', { class: 'small muted', 'aria-live': 'off' }, icon('spark', { size: 14 }), ' ', t('er.live', { time: formatTime(n) }))),
    user.department === 'ICU' ? h('p', { class: 'notice' }, icon('info', { size: 16 }), h('span', { text: t('er.icuNote') })) : null,
    erBeds(s, hId).length ? null : h('p', { class: 'notice warn' }, icon('info', { size: 16 }), h('span', { text: t('er.noBeds') })),
    tileGrid({ keys: ER_TILE_KEYS, dash, filterProp: 'tileFilter', labelKey: (k) => `tile.${k}`, icons: TILE_ICON, tones: TILE_TONE, ariaLabel: t('er.tilesLabel') }),
    filter ? h('div', { class: 'filter-bar', role: 'status' }, icon('filter', { size: 16 }),
      h('span', { text: t('common.showing', { label: t(`tile.${filter}`), n: dash[filter].count }) }),
      h('button', { type: 'button', class: 'btn small on-dark', 'data-focus-key': 'clear-filter', onclick: () => { ctx.ui.tileFilter = null; requestRender(); }, text: t('common.clearFilter') })) : null,
    board(s, hId, n, dash, filter, kind, only),
  ]);
}

function board(s, hId, n, dash, filter, kind, only) {
  const show = (key) => !filter || filter === key;
  const left = [];
  const right = [];
  if (show('incoming')) left.push(incomingPanel(s, n, dash, only));
  if (!filter || filter === 'awaitingTriage' || filter === 'waiting') left.push(inErPanel(s, n, dash, only, filter));
  if (!filter || kind === 'beds') right.push(bedMapPanel(s, hId, n, only));
  if (!filter) left.push(inTransitPanel(s, hId, n));
  if (show('icuRequests')) right.push(icuPanel(s, n, dash.icuRequests.ids));
  if (show('overdueTasks')) right.push(overduePanel(s, n, dash.overdueTasks.ids));
  const L = left.filter(Boolean);
  const R = right.filter(Boolean);
  if (!L.length || !R.length) return h('div', { class: 'board single' }, h('div', { class: 'col' }, ...L, ...R));
  return h('div', { class: 'board' }, h('div', { class: 'col' }, ...L), h('div', { class: 'col' }, ...R));
}

// ---------- Incoming ----------
function incomingPanel(s, n, dash, only) {
  const cases = dash.incoming.ids.filter((id) => !only || only.has(id)).map((id) => s.cases[id]);
  const canceled = only ? [] : selectRecentlyCanceled(s, currentUser().hospitalId, n);
  return panel(t('er.incoming'), 'ambulance', cases.length,
    cases.length ? h('div', { class: 'cards' }, cases.map((c) => incomingCard(s, c, n))) : emptyState(t('empty.incoming')),
    canceled.length ? h('div', { class: 'cards' }, canceled.map((c) => canceledCard(s, c, n))) : null);
}

function canceledCard(s, c, n) {
  const notice = s.arrivalNotices[c.noticeId];
  return h('article', { class: ['card', 'canceled-card', highlightClass('case', c.id)], 'aria-label': c.ref },
    h('div', { class: 'card-head' },
      h('div', { class: 'title' }, h('h3', { class: 'ref', text: c.ref }), h('span', { class: 'small muted', text: t(`source.${c.source}`) })),
      h('div', { class: 'end' }, pill('blocked', t('notice.canceled'), 'alert'),
        h('span', { class: 'chip' }, icon('clock', { size: 14 }), t('incoming.updated', { rel: formatRelative(notice?.updatedAt ?? c.updatedAt, n) })))),
    h('p', { class: 'small', text: t('incoming.canceledReason', { reason: c.cancelReason ?? '' }) }),
    h('div', { class: 'action-row' }, uiButton(t('action.openCase'), openDrawer('case', c.id), { small: true, 'data-focus-key': `open:case:${c.id}` })));
}

const reqChips = (c, notice) => {
  const chips = ['isolation', 'ventilator', 'monitor'].filter((k) => c.requirements?.[k]).map((k) => h('span', { class: 'chip', text: t(`req.${k}`) }));
  const crewText = notice?.handover?.receivingRequirements;
  if (!chips.length && !crewText) return t('incoming.noRequirements');
  return h('span', {}, ...chips, crewText ? h('span', { class: 'small', text: ` ${crewText}` }) : null);
};

function acuityText(c) {
  return c.triage ? t('incoming.triageValue', { p: c.triage.priority }) : t('incoming.notAssessed');
}

function reservationText(s, c, n) {
  const res = activeReservationForCase(s, c.id, n);
  if (!res) return t('incoming.noBed');
  return t('incoming.reservedUntil', { bed: s.beds[res.bedId].label, time: res.expiresAt ? formatTime(res.expiresAt) : t('reservation.held') });
}

function incomingCard(s, c, n) {
  const notice = s.arrivalNotices[c.noticeId];
  const amb = c.ambulanceAssignmentId ? s.ambulanceAssignments[c.ambulanceAssignmentId] : null;
  const showP = canSeePatient(c.destinationHospitalId);
  const openClar = values(s, 'comments').some((cm) => cm.caseId === c.id && cm.kind === 'clarification' && cm.status === 'open');
  const anyBed = erBeds(s, c.destinationHospitalId)[0];
  // Fields changed since this coordinator last opened the handover (revision seen is kept per user in this browser).
  const updated = !!notice?.handover && notice.revision > viewedRevision(c.id);
  return h('article', { class: ['card', highlightClass('case', c.id)], 'aria-label': c.ref },
    h('div', { class: 'card-head' },
      amb ? ambulanceIllustration() : h('span', { class: 'chip' }, icon('person', { size: 20 })),
      h('div', { class: 'title' }, h('h3', { class: 'ref', text: c.ref }),
        h('span', { class: 'small muted', text: amb ? t('source.ambulanceId', { id: amb.ambulanceId }) : t(`source.${c.source}`) })),
      h('div', { class: 'end' },
        pill('neutral', t(`notice.${notice?.status ?? 'submitted'}`), 'info'),
        updated ? pill('updated', t('incoming.handoverUpdated'), 'spark') : null,
        openClar ? pill('pending', t('incoming.clarificationOpen'), 'comment') : null,
        h('span', { class: 'chip', title: notice?.updatedAt }, icon('clock', { size: 14 }), t('incoming.updated', { rel: formatRelative(notice?.updatedAt ?? c.updatedAt, n) })))),
    h('p', { class: 'concern' }, h('span', { class: 'label', text: `${t('incoming.reported')} · ${t('incoming.unverified')}` }),
      showP ? (c.reportedConcern ?? t('common.unknown')) : t('drawer.patientHidden')),
    h('dl', { class: 'facts' },
      h('dt', { text: t('incoming.eta') }), h('dd', {},
        notice?.etaAt ? t('incoming.etaValue', { time: formatTime(notice.etaAt), rel: formatRelative(notice.etaAt, n) }) : t('incoming.etaUnknown'),
        h('span', { class: 'small muted', text: ` (${t('incoming.etaSimulated')})` })),
      h('dt', { text: t('incoming.acuity') }), h('dd', {}, acuityText(c),
        c.crewAcuity ? h('span', { class: 'small muted', text: ` · ${t('incoming.crewAcuity', { level: acuityLabel(c.crewAcuity.level) })}` }) : null),
      h('dt', { text: t('incoming.ack') }), h('dd', {}, notice?.acknowledged
        ? t('incoming.acked', { time: formatTime(notice.acknowledged.at), name: userName(notice.acknowledged.by) })
        : pill('pending', t('incoming.notAcked'), 'clock')),
      h('dt', { text: t('incoming.coordinator') }), h('dd', { text: userName(c.assignedCoordinatorId) }),
      h('dt', { text: t('incoming.requirements') }), h('dd', {}, reqChips(c, notice)),
      h('dt', { text: t('incoming.bed') }), h('dd', { text: reservationText(s, c, n) })),
    h('div', { class: 'action-row' },
      uiButton(t(c.source === 'citizen' ? 'action.openTranscript' : 'action.openCase'), openDrawer('case', c.id), { iconName: 'comment', small: true, 'data-focus-key': `open:case:${c.id}` }),
      notice?.acknowledged ? null : actionButton({ action: 'acknowledgeArrival', payload: { caseId: c.id }, label: t('action.acknowledgeArrival'), kind: 'primary', small: true }),
      actionButton({ action: 'requestClarification', payload: { caseId: c.id }, label: t('action.requestClarification'), small: true, open: (seen) => openClarify(c, seen) }),
      actionButton({ action: 'assignCoordinator', payload: { caseId: c.id }, label: t('action.assignCoordinator'), small: true, open: (seen) => openAssignCoordinator(c, seen) }),
      actionButton({ action: 'reserveBed', payload: { bedId: anyBed?.id, caseId: c.id }, label: t('action.reserveBed'), small: true, open: () => openReserveForCase(c) }),
      actionButton({ action: 'confirmArrival', payload: { caseId: c.id }, label: t('action.confirmArrival'), small: true }),
      actionButton({ action: 'cancelCase', payload: { caseId: c.id }, label: t('action.cancelCase'), kind: 'danger', small: true, open: (seen) => openCancelCase(c, seen) })));
}

// ---------- Arrived, not in a bed ----------
function inErPanel(s, n, d, only, filter) {
  const ids = filter === 'awaitingTriage' ? d.awaitingTriage.ids : filter === 'waiting' ? d.waiting.ids : [...d.awaitingTriage.ids, ...d.waiting.ids];
  const cases = ids.filter((id) => !only || only.has(id)).map((id) => s.cases[id]);
  return panel(t('er.inEr'), 'hourglass', cases.length,
    cases.length ? h('div', { class: 'cards' }, cases.map((c) => inErCard(s, c, n))) : emptyState(t('empty.inEr')));
}

function inErCard(s, c, n) {
  const showP = canSeePatient(c.destinationHospitalId);
  const res = activeReservationForCase(s, c.id, n);
  const resBed = res ? s.beds[res.bedId] : null;
  const anyBed = erBeds(s, c.destinationHospitalId)[0];
  return h('article', { class: ['card', highlightClass('case', c.id)], 'aria-label': c.ref },
    h('div', { class: 'card-head' },
      h('div', { class: 'title' }, h('h3', { class: 'ref', text: c.ref }), h('span', { class: 'small muted', text: showP ? s.patients[c.patientId].alias : t('drawer.patientHidden') })),
      h('div', { class: 'end' }, pill(c.journey === 'triage_pending' ? 'pending' : 'neutral', t(`journey.${c.journey}`), c.journey === 'triage_pending' ? 'hourglass' : 'clock'),
        h('span', { class: 'chip' }, icon('clock', { size: 14 }), t('incoming.arrivedAgo', { rel: formatRelative(c.arrivedAt ?? c.createdAt, n) })))),
    h('dl', { class: 'facts' },
      h('dt', { text: t('incoming.acuity') }), h('dd', { text: acuityText(c) }),
      h('dt', { text: t('incoming.requirements') }), h('dd', {}, reqChips(c, s.arrivalNotices[c.noticeId])),
      h('dt', { text: t('incoming.bed') }), h('dd', {}, res
        ? [t('incoming.reservedUntil', { bed: resBed.label, time: formatTime(res.expiresAt) }), h('span', { class: 'small muted', text: ` (${formatRelative(res.expiresAt, n)})` })]
        : t('incoming.noBed'))),
    c.waitingReason && showP ? h('p', { class: 'small notice warn' }, icon('info', { size: 14 }), h('span', { text: t('incoming.waitingReason', { text: c.waitingReason }) })) : null,
    h('div', { class: 'action-row' },
      uiButton(t('action.openCase'), openDrawer('case', c.id), { iconName: 'comment', small: true, 'data-focus-key': `open:case:${c.id}` }),
      c.triage ? null : actionButton({ action: 'recordTriage', payload: { caseId: c.id }, label: t('action.recordTriage'), small: true, kind: 'primary', open: (seen) => openTriage(c, seen) }),
      res ? actionButton({ action: 'confirmPlacement', payload: { bedId: res.bedId, caseId: c.id }, label: `${t('action.confirmPlacement')} · ${resBed.label}`, small: true, kind: 'primary' })
        : actionButton({ action: 'reserveBed', payload: { bedId: anyBed?.id, caseId: c.id }, label: t('action.reserveBed'), small: true, open: () => openReserveForCase(c) }),
      res ? actionButton({ action: 'extendReservation', payload: { reservationId: res.id }, label: t('action.extendReservation'), small: true, open: (seen) => openExtend(res, seen) }) : null,
      res ? actionButton({ action: 'releaseReservation', payload: { reservationId: res.id }, label: t('action.releaseReservation'), small: true, kind: 'danger', open: (seen) => openRelease(res, seen) }) : null));
}

// ---------- Bed map ----------
function bedMapPanel(s, hId, n, only) {
  const beds = erBeds(s, hId).filter((b) => !only || only.has(b.id));
  return panel(t('er.bedMap'), 'bed', beds.length,
    beds.length ? h('div', { class: 'bed-grid' }, beds.map((b) => bedCard(s, b, n))) : emptyState(t('empty.beds'), 'bed'));
}

// ---------- ICU requests ----------
function icuPanel(s, n, ids) {
  return panel(t('er.icuRequests'), 'transfer', ids.length, ids.length ? h('ul', { class: 'rows' }, ids.map((id) => {
    const tr = s.transferRequests[id];
    const c = s.cases[tr.caseId];
    const st = deriveTransferStatus(tr, s, n);
    const who = canSeePatient(tr.hospitalId) ? s.patients[tr.patientId].alias : t('common.dash');
    return h('li', { class: 'row' }, icon('transfer'),
      h('div', { class: 'grow' },
        h('strong', { text: t('icu.row', { ref: tr.ref, patient: who, bed: s.beds[tr.fromBedId]?.label ?? t('er.inEr') }) }),
        h('span', {}, pill(tr.status === 'requested' ? 'pending' : 'neutral', tm(st.label), 'transfer'), ' ', h('span', { class: 'small muted', text: tm(st.reason) })),
        h('span', { class: 'small muted', text: `${t('icu.owner', { role: roleLabel(st.ownerRole) })} · ${t('icu.requested', { rel: formatRelative(tr.requestedAt, n), name: userName(tr.requestedBy) })}` })),
      uiButton(t('action.openTransfer'), openDrawer('transfer', tr.id), { small: true, kind: 'primary', 'data-focus-key': `open:transfer:${tr.id}` }));
  })) : emptyState(t('empty.icu'), 'transfer'));
}

// ---------- Overdue ----------
function overduePanel(s, n, ids) {
  const items = ids.map((id) => s.tasks[id] ?? s.maintenanceTickets[id]);
  return panel(t('er.overdue'), 'alert', items.length, items.length ? h('ul', { class: 'rows' }, items.map((x) => {
    const bedId = x.entity === 'task' ? x.linked.bedId : x.bedId;
    const label = x.entity === 'task' ? tm(x.title) : `${x.ref} · ${tm(x.category)}`;
    const owner = x.entity === 'task' ? (x.ownerUserId ? userName(x.ownerUserId) : roleLabel(x.requiredRole)) : (x.assignedTo ? userName(x.assignedTo) : roleLabel(x.kind === 'technical' ? 'maintenance_tech' : 'biomed_tech'));
    return h('li', { class: 'row overdue' }, icon('alert'),
      h('div', { class: 'grow' }, h('strong', { text: label }),
        h('span', { class: 'small' }, pill('blocked', t('task.overdue'), 'clock'), ' ', t('task.due', { time: formatTime(x.dueAt), rel: formatRelative(x.dueAt, n) }), ` · ${owner}`)),
      bedId ? uiButton(t('action.openBed', { bed: s.beds[bedId]?.label }), openDrawer('bed', bedId), { small: true }) : null);
  })) : emptyState(t('empty.overdue'), 'check'));
}
