// Task presentation + status buttons. Next statuses come from the engine (nextTaskStatuses / completionActionFor).

import { nextTaskStatuses, completionActionFor } from '../actions.js';
import { t, tm, formatTime, formatRelative } from '../i18n.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { state, now } from './core.js';
import { pill, actionButton, userName, roleLabel } from './components.js';
import { openTaskNote, openConfirmStaffing, openEquipmentCheck } from './forms.js';

const NEEDS_NOTE = ['blocked', 'canceled'];

export function taskStatusPill(task) {
  const level = ['done', 'report_available'].includes(task.status) ? 'ready'
    : task.status === 'blocked' ? 'blocked' : task.status === 'canceled' ? 'neutral' : 'pending';
  return pill(level, t(`task.status.${task.status}`), level === 'ready' ? 'check' : level === 'blocked' ? 'alert' : 'clock');
}

export function dueText(item) {
  if (!item.dueAt) return t('task.noDue');
  return t('task.due', { time: formatTime(item.dueAt), rel: formatRelative(item.dueAt, now()) });
}

export const isOverdue = (item) => !!item.dueAt && Date.parse(item.dueAt) < Date.parse(now());

export function ownerLine(task) {
  if (task.ownerUserId) return t('task.owner', { name: userName(task.ownerUserId) });
  if (task.ownerTeam) return t('task.team', { team: task.ownerTeam });
  return t('task.unclaimed', { role: roleLabel(task.requiredRole) });
}

// Buttons for the task's next statuses, plus the dedicated completion action when the engine names one.
export function taskButtons(task) {
  if (['done', 'canceled'].includes(task.status)) return []; // finished work has no further steps
  const buttons = nextTaskStatuses(task).map((status) => (NEEDS_NOTE.includes(status)
    ? actionButton({ action: 'updateTaskStatus', payload: { taskId: task.id, status }, label: t(`taskStatus.${status}`), small: true,
      kind: status === 'canceled' ? 'danger' : '', open: (seen) => openTaskNote(task, status, seen) })
    : actionButton({ action: 'updateTaskStatus', payload: { taskId: task.id, status }, label: t(`taskStatus.${status}`), small: true })));
  const completion = completionActionFor(task);
  const bed = task.linked.bedId ? state().beds[task.linked.bedId] : null;
  if (completion === 'acknowledgeReport') {
    const diagnosticId = task.category === 'diagnostic' ? task.id : task.linked.taskId;
    buttons.push(actionButton({ action: 'acknowledgeReport', payload: { taskId: diagnosticId }, label: t('action.acknowledgeReport'), small: true, kind: 'primary' }));
  } else if (completion && bed) {
    if (completion === 'completeCleaning' || completion === 'verifyReadiness') {
      buttons.push(actionButton({ action: completion, payload: { bedId: bed.id }, label: t(`action.${completion}`), small: true, kind: 'primary' }));
    } else if (completion === 'confirmStaffing') {
      buttons.push(actionButton({ action: completion, payload: { bedId: bed.id }, label: t('action.confirmStaffing'), small: true, kind: 'primary', open: (seen) => openConfirmStaffing(bed, seen) }));
    } else if (completion === 'recordEquipmentCheck') {
      buttons.push(actionButton({ action: completion, payload: { bedId: bed.id }, label: t('action.recordEquipmentCheck'), small: true, kind: 'primary', open: (seen) => openEquipmentCheck(bed, seen) }));
    }
  }
  return buttons;
}

export function taskRow(task, { extra = null, highlight = false } = {}) {
  const last = task.history.at(-1);
  return h('li', { class: ['row', isOverdue(task) && 'overdue', highlight && 'card highlight'], 'data-task': task.id },
    icon(task.category === 'cleaning' ? 'broom' : task.category === 'diagnostic' ? 'monitor' : 'tasks'),
    h('div', { class: 'grow' },
      h('strong', { text: tm(task.title) }),
      h('span', { class: 'small' }, taskStatusPill(task), ' ', h('span', { class: 'chip', text: t(`task.cat.${task.category}`) }),
        task.priority === 'high' ? h('span', { class: 'chip', text: t('task.priority.high') }) : null,
        isOverdue(task) ? pill('blocked', t('task.overdue'), 'clock') : null),
      h('span', { class: 'small muted', text: `${dueText(task)} · ${ownerLine(task)}` }),
      last?.note ? h('span', { class: 'small muted', text: t('task.lastNote', { text: tm(last.note) }) }) : null,
      task.category === 'diagnostic' && task.status === 'report_available' ? h('span', { class: 'small' },
        task.reportAcknowledged ? pill('ready', t('queue.acknowledged', { time: formatTime(task.reportAcknowledged.at), name: userName(task.reportAcknowledged.by) }), 'check')
          : pill('pending', t('queue.awaitingAck'), 'clock')) : null,
      extra,
      h('div', { class: 'action-row' }, taskButtons(task))));
}
