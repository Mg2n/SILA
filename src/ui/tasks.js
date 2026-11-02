// "My tasks": open work for the active account's role, with status updates through dispatch.

import { selectMyWork } from '../selectors.js';
import { t, tm, formatTime, formatRelative, joinText } from '../i18n.js';
import { h, append } from './dom.js';
import { icon } from './icons.js';
import { ctx, state, now, currentUser, canSeePatient, requestRender } from './core.js';
import { pill, emptyState, panel, uiButton, roleLabel, userName } from './components.js';
import { taskRow, isOverdue } from './taskui.js';
import { ticketButtons } from './drawer.js';

const open = (type, id) => () => { ctx.ui.drawer = { type, id }; ctx.ui.highlight = { type, id }; requestRender(); };

function links(s, linked) {
  const bed = linked.bedId ? s.beds[linked.bedId] : null;
  const c = linked.caseId ? s.cases[linked.caseId] : null;
  const alias = c && canSeePatient(c.destinationHospitalId) ? ` · ${s.patients[c.patientId]?.alias}` : '';
  return h('div', { class: 'action-row' },
    bed ? uiButton(t('action.openBed', { bed: bed.label }), open('bed', bed.id), { small: true, iconName: 'bed', 'data-focus-key': `open:bed:${bed.id}` }) : null,
    c ? uiButton(`${c.ref}${alias}`, open('case', c.id), { small: true, iconName: 'comment', 'data-focus-key': `open:case:${c.id}` }) : null);
}

export function renderTasks(main) {
  const s = state();
  const user = currentUser();
  const n = now();
  const work = selectMyWork(s, user, n);
  const hi = ctx.ui.highlight;
  append(main, [
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { text: t('tasks.title') }),
        h('p', { class: 'muted', text: t('tasks.subtitle', { role: roleLabel(user.role), hospital: s.hospitals[user.hospitalId]?.name ?? '' }) })),
      work.overdue ? pill('blocked', t('tasks.overdueCount', { n: work.overdue }), 'alert') : null),
    h('div', { class: 'board single' }, h('div', { class: 'col' },
      panel(t('tasks.tasks'), 'tasks', work.tasks.length, work.tasks.length
        ? h('ul', { class: 'rows' }, work.tasks.map((task) => taskRow(task, { extra: links(s, task.linked), highlight: hi?.type === 'task' && hi.id === task.id })))
        : emptyState(t('empty.tasks'), 'tasks')),
      ['maintenance_tech', 'biomed_tech'].includes(user.role) ? panel(t('tasks.tickets'), 'wrench', work.tickets.length, work.tickets.length
        ? h('ul', { class: 'rows' }, work.tickets.map((x) => h('li', { class: ['row', isOverdue(x) && 'overdue'] },
          icon(x.kind === 'technical' ? 'wrench' : 'monitor'),
          h('div', { class: 'grow' },
            h('strong', { text: joinText([x.ref, tm(x.category), s.beds[x.bedId]?.label]) }),
            h('span', { class: 'small' }, pill('blocked', t(`ticket.status.${x.status}`), 'alert'), ' ', h('span', { class: 'chip', text: t(`severity.${x.severity}`) }),
              isOverdue(x) ? pill('blocked', t('task.overdue'), 'clock') : null),
            h('span', { text: x.description }),
            h('span', { class: 'small muted', text: `${x.dueAt ? t('task.due', { time: formatTime(x.dueAt), rel: formatRelative(x.dueAt, n) }) : t('task.noDue')} · ${x.assignedTo ? t('task.owner', { name: userName(x.assignedTo) }) : t('common.unassigned')}` }),
            h('div', { class: 'action-row' }, ticketButtons(x)),
            links(s, { bedId: x.bedId })))))
        : emptyState(t('empty.tickets'), 'check')) : null)),
  ]);
}
