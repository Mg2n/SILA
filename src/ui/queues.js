// Support-team queues (housekeeping, maintenance, biomedical, diagnostics) and the porter's transport jobs.
// Grouping comes from selectors.js; every status button is an engine action.

import { deriveBedReadiness, deriveTransferStatus } from '../readiness.js';
import { housekeepingQueue, maintenanceQueue, biomedQueue, diagnosticsQueue, porterJobs } from '../selectors.js';
import { t, tm, joinText } from '../i18n.js';
import { h, append } from './dom.js';
import { icon } from './icons.js';
import { state, now, currentUser, canSeePatient } from './core.js';
import { pill, emptyState, panel, actionButton, uiButton, userName, roleLabel } from './components.js';
import { taskRow } from './taskui.js';
import { ticketRow } from './drawer.js';
import { openDrawer } from './beds.js';

const head = (titleKey, user, s) => h('div', { class: 'page-head' },
  h('div', {}, h('h1', { text: t(titleKey) }),
    h('p', { class: 'muted', text: t('queue.subtitle', { role: roleLabel(user.role), hospital: s.hospitals[user.hospitalId]?.name ?? '' }) })));

const group = (titleKey, iconName, items, render) => panel(t(titleKey), iconName, items.length,
  items.length ? h('ul', { class: 'rows' }, items.map(render)) : emptyState(t('queue.empty'), iconName));

const location = (s, bedId) => {
  const b = s.beds[bedId];
  return b ? t('queue.location', { bed: b.label, zone: b.zone, dept: t(`dept.${b.department}`) }) : '';
};

// After cleaning, show what still blocks the bed — completing cleaning never clears faults.
function bedRemainder(s, bedId, n) {
  const b = s.beds[bedId];
  if (!b) return null;
  const remaining = deriveBedReadiness(b, s, n).blockers.filter((x) => x.type !== 'cleaning');
  return h('span', { class: 'small' },
    remaining.length ? [pill('blocked', t('queue.stillBlocked', { list: remaining.map((x) => t(`blocker.${x.type}`)).join(', ') }), 'alert')] : t('queue.bedClear'),
    ' ', uiButton(t('action.openBed', { bed: b.label }), openDrawer('bed', b.id), { small: true, 'data-focus-key': `open:bed:${b.id}` }));
}

export function renderQueue(main) {
  const s = state();
  const user = currentUser();
  const n = now();
  const out = [];
  if (user.role === 'housekeeping') {
    const q = housekeepingQueue(s, user, n);
    const row = (task) => taskRow(task, { extra: [h('span', { class: 'small muted', text: location(s, task.linked.bedId) }), bedRemainder(s, task.linked.bedId, n)] });
    out.push(head('nav.queue.housekeeping', user, s),
      h('div', { class: 'board' },
        h('div', { class: 'col' }, group('queue.required', 'broom', q.required, row), group('queue.mine', 'person', q.mine, row), group('queue.inProgress', 'clock', q.inProgress, row)),
        h('div', { class: 'col' }, group('queue.blocked', 'alert', q.blocked, row), group('queue.doneToday', 'check', q.doneToday, row))));
  } else if (user.role === 'maintenance_tech' || user.role === 'biomed_tech') {
    const biomed = user.role === 'biomed_tech';
    const q = biomed ? biomedQueue(s, user, n) : maintenanceQueue(s, user, n);
    const row = (x) => ticketRow(s, x, h('span', { class: 'small muted', text: location(s, x.bedId) }));
    out.push(head(biomed ? 'nav.queue.biomed_tech' : 'nav.queue.maintenance_tech', user, s),
      h('div', { class: 'board' },
        h('div', { class: 'col' }, group('queue.open', 'alert', q.open, row), group('queue.assigned', 'person', q.assigned, row), group('queue.inProgress', 'wrench', q.inProgress, row)),
        h('div', { class: 'col' },
          biomed ? group('queue.checks', 'monitor', q.checks, (task) => taskRow(task, { extra: h('span', { class: 'small muted', text: location(s, task.linked.bedId) }) })) : null,
          group('queue.resolvedToday', 'check', q.resolvedToday, row))));
  } else if (user.role === 'diagnostics') {
    const q = diagnosticsQueue(s, user, n);
    const row = (task) => {
      const c = s.cases[task.linked.caseId];
      const who = c && canSeePatient(user.hospitalId) ? joinText([s.patients[c.patientId]?.alias, c.ref]) : (c?.ref ?? '');
      return taskRow(task, { extra: [
        h('span', { class: 'small muted', text: joinText([who, location(s, task.linked.bedId)]) }),
        task.orderedBy ? h('span', { class: 'small muted', text: t('queue.orderedBy', { name: userName(task.orderedBy), reason: task.orderReason ?? '' }) }) : null,
      ] });
    };
    out.push(head('nav.queue.diagnostics', user, s),
      h('div', { class: 'board' },
        h('div', { class: 'col' }, group('queue.requested', 'inbox', q.requested, row), group('queue.scheduled', 'clock', q.scheduled, row)),
        h('div', { class: 'col' }, group('queue.inProgress', 'monitor', q.inProgress, row), group('queue.reportAvailable', 'check', q.reportAvailable, row))));
  }
  append(main, out);
}

export function renderTransport(main) {
  const s = state();
  const user = currentUser();
  const n = now();
  const jobs = porterJobs(s, user, n);
  const row = (tr) => {
    const c = s.cases[tr.caseId];
    const who = canSeePatient(tr.hospitalId) ? s.patients[tr.patientId].alias : t('common.dash');
    return h('li', { class: 'row' }, icon('transfer'),
      h('div', { class: 'grow' },
        h('strong', { text: t('transit.row', { ref: c.ref, patient: who, from: s.beds[tr.fromBedId]?.label ?? t('dept.ER'), to: s.beds[tr.targetBedId]?.label ?? '' }) }),
        h('span', {}, pill(tr.status === 'completed' ? 'ready' : 'pending', tm(deriveTransferStatus(tr, s, n).label), 'transfer'), ' ', h('span', { class: 'small muted', text: tr.ref })),
        tr.status === 'completed' ? null : h('div', { class: 'action-row' },
          actionButton({ action: 'confirmPickup', payload: { transferId: tr.id }, label: t('action.confirmPickup'), kind: tr.status === 'reserved' ? 'primary' : '', small: true }),
          actionButton({ action: 'confirmDropoff', payload: { transferId: tr.id }, label: t('action.confirmDropoff'), kind: tr.status === 'in_transit' ? 'primary' : '', small: true }),
          uiButton(t('action.openTransfer'), openDrawer('transfer', tr.id), { small: true, 'data-focus-key': `open:transfer:${tr.id}` }))));
  };
  append(main, [
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: t('transport.title') }), h('p', { class: 'muted', text: t('transport.subtitle') }))),
    h('div', { class: 'board single' }, h('div', { class: 'col' },
      panel(t('transport.active'), 'transfer', jobs.active.length, jobs.active.length ? h('ul', { class: 'rows' }, jobs.active.map(row)) : emptyState(t('empty.transport'), 'transfer')),
      panel(t('transport.doneToday'), 'check', jobs.doneToday.length, jobs.doneToday.length ? h('ul', { class: 'rows' }, jobs.doneToday.map(row)) : emptyState(t('queue.empty'), 'check')))),
  ]);
}
