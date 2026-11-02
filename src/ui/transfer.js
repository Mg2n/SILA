// ER → ICU transfer drawer with a step tracker, and the transfer / step-down / diagnostic dialogs.
// Steps and owners come from selectors.transferSteps(); every button is an engine action checked by preflight.

import { values, DIAGNOSTIC_TYPES } from '../data.js';
import { deriveTransferStatus, forecastReadyTime } from '../readiness.js';
import { transferSteps, icuBeds, bedBoardStatus } from '../selectors.js';
import { t, tm, formatTime, formatRelative } from '../i18n.js';
import { h, nextUid } from './dom.js';
import { icon } from './icons.js';
import { ctx, state, now, check, canSeePatient, openDialog, field, run, requestRender } from './core.js';
import { pill, actionButton, uiButton, forecastLine, blockerList, historyList, commentsSection, userName, roleLabel } from './components.js';
import { taskRow } from './taskui.js';
import { formDialog } from './forms.js';

const open = (type, id) => () => { ctx.ui.drawer = { type, id }; ctx.ui.highlight = { type, id }; requestRender(); };
const note = (text, kind = '') => h('p', { class: ['notice', kind] }, icon(kind ? 'alert' : 'info', { size: 16 }), h('span', { text }));
const REQS = ['isolation', 'ventilator', 'monitor'];
const reqChips = (r) => {
  const on = REQS.filter((k) => r?.[k]);
  return on.length ? h('span', {}, on.map((k) => h('span', { class: 'chip', text: t(`req.${k}`) }))) : t('incoming.noRequirements');
};

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------
const STEP_LEVEL = { done: 'ready', current: 'pending', pending: 'neutral', stopped: 'blocked' };
const STEP_ICON = { done: 'check', current: 'clock', pending: 'hourglass', stopped: 'alert' };

const ownerOf = (step) => {
  if (!step.ownerRole) return '';
  const role = `${roleLabel(step.ownerRole)}${step.ownerDepartment ? ` · ${t(`dept.${step.ownerDepartment}`)}` : ''}`;
  return step.ownerUser ? `${role}: ${userName(step.ownerUser)}` : role;
};

export function transferDrawer(s, tr) {
  const n = now();
  const c = s.cases[tr.caseId];
  const st = deriveTransferStatus(tr, s, n);
  const showP = canSeePatient(tr.hospitalId);
  const target = tr.targetBedId ? s.beds[tr.targetBedId] : null;
  const active = ['requested', 'accepted', 'reserved'].includes(tr.status);
  const steps = transferSteps(tr, s, n);
  const body = [
    h('section', {}, h('h3', {}, icon('transfer', { size: 16 }), t('transfer.status')),
      h('p', {}, pill(['declined', 'canceled'].includes(tr.status) ? 'blocked' : tr.status === 'completed' ? 'ready' : 'pending', tm(st.label), 'transfer'),
        ' ', h('span', { class: 'small muted', text: tm(st.reason) })),
      st.ownerRole ? h('p', { class: 'small', text: t('transfer.nextOwner', { owner: `${roleLabel(st.ownerRole)}${st.ownerUser ? `: ${userName(st.ownerUser)}` : ''}` }) }) : null,
      h('dl', { class: 'facts' },
        h('dt', { text: t('transfer.patient') }), h('dd', { text: showP ? `${s.patients[tr.patientId].alias} · ${c.ref}` : c.ref }),
        h('dt', { text: t('transfer.route') }), h('dd', { text: t('transfer.routeValue', { from: s.beds[tr.fromBedId]?.label ?? t('er.inEr'), to: target?.label ?? t('transfer.toUnknown') }) }),
        h('dt', { text: t('transfer.requirements') }), h('dd', {}, reqChips(tr.requirements)),
        showP ? h('dt', { text: t('transfer.reasonLabel') }) : null, showP ? h('dd', { text: tr.reason }) : null,
        h('dt', { text: t('step.requested') }), h('dd', { text: `${formatRelative(tr.requestedAt, n)} · ${userName(tr.requestedBy)}` })),
      h('div', { class: 'action-row' },
        uiButton(t('action.openCase'), open('case', c.id), { small: true, iconName: 'comment', 'data-focus-key': `open:case:${c.id}` }),
        target ? uiButton(t('transfer.openBed', { bed: target.label }), open('bed', target.id), { small: true, iconName: 'bed' }) : null,
        active ? actionButton({ action: 'cancelTransferRequest', payload: { transferId: tr.id }, label: t('action.cancelTransfer'), kind: 'danger', small: true,
          open: (seen) => openCancelTransfer(tr, seen) }) : null)),
    h('section', {}, h('h3', {}, icon('tasks', { size: 16 }), t('transfer.steps')),
      h('ol', { class: 'steps' }, steps.map((step) => stepItem(s, tr, step, n)))),
    h('section', {}, h('h3', {}, icon('comment', { size: 16 }), t('drawer.comments')), commentsSection('transferRequest', tr.id)),
    h('section', {}, h('h3', {}, icon('history', { size: 16 }), t('drawer.history')), historyList('transferRequest', tr.id)),
  ];
  return { title: t('transfer.drawerTitle', { ref: tr.ref }), sub: h('p', { class: 'small muted', text: c.ref }), headIcon: icon('transfer', { size: 24 }), body };
}

function stepItem(s, tr, step, n) {
  const content = step.status === 'current' || (step.key === 'handover' && tr.status === 'reserved') ? stepActions(s, tr, step, n) : null;
  return h('li', { class: ['step', `step-${step.status}`], 'aria-current': step.status === 'current' ? 'step' : null },
    h('div', { class: 'step-head' }, pill(STEP_LEVEL[step.status], t(`stepState.${step.status}`), STEP_ICON[step.status]), h('strong', { text: t(`step.${step.key}`) })),
    step.status === 'done' && step.at ? h('p', { class: 'small muted', text: t('transfer.doneBy', { time: formatTime(step.at), name: userName(step.by) }) }) : null,
    step.status !== 'done' && step.ownerRole ? h('p', { class: 'small', text: t('transfer.owner', { owner: ownerOf(step) }) }) : null,
    step.reason && step.status !== 'done' ? h('p', { class: 'small muted', text: tm(step.reason) }) : null,
    content);
}

function stepActions(s, tr, step, n) {
  const c = s.cases[tr.caseId];
  const bed = tr.targetBedId ? s.beds[tr.targetBedId] : null;
  const row = (...xs) => h('div', { class: 'action-row' }, xs);
  switch (step.key) {
    case 'accepted':
      return row(
        actionButton({ action: 'approveTransfer', payload: { transferId: tr.id, decision: 'accept' }, label: t('action.acceptTransfer'), kind: 'primary', small: true, open: (seen) => openDecision(tr, 'accept', seen) }),
        actionButton({ action: 'approveTransfer', payload: { transferId: tr.id, decision: 'decline' }, label: t('action.declineTransfer'), kind: 'danger', small: true, open: (seen) => openDecision(tr, 'decline', seen) }));
    case 'capacity':
      return row(actionButton({ action: 'confirmCapacity', payload: { transferId: tr.id }, label: t('action.confirmCapacity'), kind: 'primary', small: true, iconName: 'bed', open: (seen) => openConfirmCapacity(tr, seen) }));
    case 'bedReady': {
      if (!bed) return null;
      const prep = tr.prepItems.map((i) => (i.entity === 'task' ? s.tasks[i.id] : null)).filter((x) => x && !['done', 'canceled'].includes(x.status));
      return h('div', { class: 'rows' }, blockerList(step.blockers), forecastLine(forecastReadyTime(bed, s, n)),
        prep.length ? h('h4', { class: 'small muted', text: t('transfer.prepWork') }) : null,
        prep.length ? h('ul', { class: 'rows' }, prep.map((task) => taskRow(task))) : null,
        row(uiButton(t('transfer.openBed', { bed: bed.label }), open('bed', bed.id), { small: true, iconName: 'bed' })));
    }
    case 'reserved':
      return bed ? row(actionButton({ action: 'reserveBed', payload: { bedId: bed.id, caseId: c.id }, label: t('action.reserveIcuBed', { bed: bed.label }), kind: 'primary', small: true, iconName: 'lock' })) : null;
    case 'handover': {
      const tasks = tr.handoverTaskIds.map((id) => s.tasks[id]).filter(Boolean);
      return h('div', { class: 'rows' },
        tasks.length ? h('ul', { class: 'rows' }, tasks.map((task) => taskRow(task))) : null,
        tr.status === 'reserved' ? row(actionButton({ action: 'assignPorter', payload: { transferId: tr.id }, label: t('action.assignPorter'), small: true, iconName: 'person', open: (seen) => openAssignPorter(tr, seen) })) : null);
    }
    case 'inTransit':
      return row(
        actionButton({ action: 'confirmDeparture', payload: { caseId: c.id }, label: t('action.confirmDeparture'), kind: 'primary', small: true, iconName: 'transfer' }),
        actionButton({ action: 'confirmPickup', payload: { transferId: tr.id }, label: t('action.confirmPickup'), small: true, iconName: 'transfer' }));
    case 'arrived':
      return row(
        actionButton({ action: 'confirmDropoff', payload: { transferId: tr.id }, label: t('action.confirmDropoff'), small: true }),
        actionButton({ action: 'confirmArrival', payload: { transferId: tr.id }, label: t('action.confirmIcuArrival'), kind: 'primary', small: true }));
    case 'placed':
      return bed ? row(actionButton({ action: 'confirmPlacement', payload: { bedId: bed.id, caseId: c.id }, label: `${t('action.confirmPlacement')} · ${bed.label}`, kind: 'primary', small: true })) : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
export function openDecision(tr, decision, seen) {
  const decline = decision === 'decline';
  return formDialog({ action: 'approveTransfer', payload: { transferId: tr.id, decision }, seen, danger: decline,
    title: t(decline ? 'decision.declineTitle' : 'decision.acceptTitle', { ref: tr.ref }), intro: note(t('decision.hint')),
    submitLabel: t(decline ? 'action.declineTransfer' : 'action.acceptTransfer'),
    fields: () => [field({ label: t(decline ? 'decision.reason' : 'decision.note'), name: 'reason', type: 'textarea', required: decline, maxlength: 500 })],
    map: (d) => ({ reason: d.reason || undefined }) });
}

export function openConfirmCapacity(tr, seen) {
  const s = state();
  const n = now();
  const suggested = deriveTransferStatus(tr, s, n).suggestedBedId;
  const options = icuBeds(s, tr.hospitalId).map((b) => {
    const v = check('confirmCapacity', { transferId: tr.id, bedId: b.id });
    return { b, ok: v.ok, reason: v.reason, level: bedBoardStatus(b, s, n).level };
  });
  const usable = options.some((o) => o.ok);
  return openDialog({
    title: t('capacity.title', { ref: tr.ref }),
    intro: usable ? note(t('capacity.hint')) : note(t('capacity.none'), 'warn'),
    submitLabel: t('action.confirmCapacity'),
    submitDisabled: !usable,
    fields: () => [
      h('p', { class: 'small' }, `${t('transfer.requirements')}: `, reqChips(tr.requirements)),
      h('fieldset', { class: 'choices' }, h('legend', { text: t('capacity.chooseBed') }), options.map((o) => {
        const id = nextUid('cap');
        return h('div', { class: 'choice' },
          h('input', { type: 'radio', id, name: 'bedId', value: o.b.id, disabled: !o.ok, checked: o.ok && o.b.id === suggested, 'aria-describedby': o.ok ? null : `${id}-why` }),
          h('label', { for: id }, h('span', { text: `${o.b.label} · ${o.b.zone} ` }), pill(o.level),
            o.b.id === suggested ? h('span', { class: 'chip', text: t('capacity.suggested') }) : null,
            o.ok ? null : h('span', { class: 'why', id: `${id}-why`, text: ` — ${tm(o.reason)}` })));
      })),
    ],
    onSubmit: (d) => (d.bedId ? run('confirmCapacity', { transferId: tr.id, bedId: d.bedId }, { seen, quiet: true }) : { ok: false, code: 'invalid', error: t('capacity.chooseBed') }),
  });
}

export const openCancelTransfer = (tr, seen) => formDialog({ action: 'cancelTransferRequest', payload: { transferId: tr.id }, seen, danger: true,
  title: t('cancelTransfer.title', { ref: tr.ref }), submitLabel: t('action.cancelTransfer'),
  fields: () => [field({ label: t('cancelTransfer.reason'), name: 'reason', type: 'textarea', required: true, hint: t('common.reasonHint'), maxlength: 500 })] });

export function openAssignPorter(tr, seen) {
  const porters = values(state(), 'users').filter((u) => u.role === 'porter' && u.active && u.hospitalId === tr.hospitalId);
  return formDialog({ action: 'assignPorter', payload: { transferId: tr.id }, seen, title: t('porter.title', { ref: tr.ref }),
    fields: () => [field({ label: t('porter.select'), name: 'porterUserId', type: 'select', required: true, options: porters.map((u) => ({ value: u.id, label: u.name })) })] });
}

export const openStepDown = (c, seen) => formDialog({ action: 'flagStepDown', payload: { caseId: c.id }, seen, title: t('stepDown.title', { ref: c.ref }),
  intro: note(t('stepDown.hint')),
  fields: () => [
    field({ label: t('stepDown.reason'), name: 'reason', type: 'textarea', required: true, maxlength: 300 }),
    field({ label: t('stepDown.within'), name: 'within', type: 'select', value: '', options: [{ value: '', label: t('stepDown.unknown') },
      ...[60, 120, 240, 480].map((m) => ({ value: String(m), label: t('minutes.option', { n: m }) }))] }),
  ],
  map: (d) => ({ reason: d.reason, expectedWithinMinutes: d.within ? Number(d.within) : null }) });

export const openOrderDiagnostic = (patient) => formDialog({ action: 'orderDiagnostic', payload: { patientId: patient.id }, seen: undefined,
  title: t('diagnostic.title', { patient: patient.alias }), intro: note(t('diagnostic.hint')),
  fields: () => [
    field({ label: t('diagnostic.type'), name: 'type', type: 'select', required: true, options: DIAGNOSTIC_TYPES.map((k) => ({ value: k, label: t(`diag.${k}`) })) }),
    field({ label: t('diagnostic.reason'), name: 'reason', type: 'textarea', required: true, maxlength: 300 }),
  ] });

