// Dialogs for actions that need input. Required reasons are enforced here and again by the engine.

import { values } from '../data.js';
import { t } from '../i18n.js';
import { h, nextUid } from './dom.js';
import { icon } from './icons.js';
import { openDialog, field, run, state, ctx, toast, requestRender } from './core.js';

export function formDialog({ action, payload, seen, title, fields, map = (d) => d, submitLabel = t(`action.${action}`), danger = false, intro = null }) {
  return openDialog({
    title, intro, fields, submitLabel, danger,
    onSubmit: (data) => run(action, { ...payload, ...map(data) }, { seen, quiet: true }),
  });
}

const reasonField = (label, name = 'reason') => field({ label, name, type: 'textarea', required: true, hint: t('common.reasonHint'), maxlength: 500 });
const note = (text, kind = '') => h('p', { class: ['notice', kind] }, icon(kind ? 'alert' : 'info', { size: 16 }), h('span', { text }));

function checkbox(label, name) {
  const id = nextUid(name);
  return h('div', { class: 'choice' }, h('input', { type: 'checkbox', id, name }), h('label', { for: id, text: label }));
}

const minutesOptions = (list) => list.map((n) => ({ value: String(n), label: t('minutes.option', { n }) }));

// ---------- Cases ----------
export const openCancelCase = (c, seen) => formDialog({ action: 'cancelCase', payload: { caseId: c.id }, seen, danger: true,
  title: t('cancel.title', { ref: c.ref }), fields: () => [reasonField(t('cancel.reason'))] });

export const openClarify = (c, seen) => formDialog({ action: 'requestClarification', payload: { caseId: c.id }, seen,
  title: t('clarify.title', { ref: c.ref }), fields: () => [field({ label: t('clarify.question'), name: 'question', type: 'textarea', required: true, maxlength: 300 })] });

export function openAssignCoordinator(c, seen) {
  const coords = values(state(), 'users').filter((u) => u.role === 'er_coordinator' && u.active && u.hospitalId === c.destinationHospitalId);
  return formDialog({ action: 'assignCoordinator', payload: { caseId: c.id }, seen, title: t('coord.title', { ref: c.ref }),
    fields: () => [field({ label: t('coord.select'), name: 'coordinatorId', type: 'select', required: true, value: c.assignedCoordinatorId,
      options: coords.map((u) => ({ value: u.id, label: u.name })) })] });
}

export const openTriage = (c, seen) => formDialog({ action: 'recordTriage', payload: { caseId: c.id }, seen, title: t('triage.title', { ref: c.ref }),
  intro: note(t('triage.disclaimer')),
  fields: () => [
    field({ label: t('triage.priority'), name: 'priority', type: 'select', required: true, value: '3', options: [1, 2, 3, 4, 5].map((p) => ({
      value: String(p), label: p === 1 ? t('triage.optionHigh') : p === 5 ? t('triage.optionLow') : t('triage.option', { p }) })) }),
    field({ label: `${t('triage.note')} ${t('common.optional')}`, name: 'note', type: 'textarea', rows: 2 }),
  ],
  map: (d) => ({ priority: Number(d.priority), note: d.note || null }) });

export const openDisposition = (c, seen) => formDialog({ action: 'recordDisposition', payload: { caseId: c.id }, seen, title: t('disposition.title', { ref: c.ref }),
  intro: note(t('disposition.hint')),
  fields: () => [
    field({ label: t('disposition.decision'), name: 'decision', type: 'select', required: true,
      options: ['discharge', 'admit_ward'].map((d) => ({ value: d, label: t(`disposition.${d}`) })) }),
    field({ label: `${t('disposition.note')} ${t('common.optional')}`, name: 'note', type: 'textarea', rows: 2 }),
  ],
  map: (d) => ({ decision: d.decision, note: d.note || null }) });

export const openTransferRequest = (c, seen) => formDialog({ action: 'requestTransfer', payload: { caseId: c.id }, seen, title: t('transfer.title', { ref: c.ref }),
  fields: () => [reasonField(t('transfer.reason')), checkbox(t('transfer.ventilator'), 'ventilator'), checkbox(t('transfer.isolation'), 'isolation'), checkbox(t('transfer.monitor'), 'monitor')],
  map: (d) => ({ reason: d.reason, requirements: { ventilator: d.ventilator === 'on', isolation: d.isolation === 'on', monitor: d.monitor === 'on' } }) });

// ---------- Beds ----------
export function openFault(bed, seen) {
  const eqOptions = [...new Set([...bed.requiredEquipment, 'infusion_pump', 'oxygen'])].map((e) => ({ value: e, label: t(`equipment.${e}`) }));
  return formDialog({ action: 'reportFault', payload: { bedId: bed.id }, seen, title: t('fault.title', { bed: bed.label }),
    intro: bed.occupancy.status === 'occupied' ? note(t('fault.occupied'), 'danger') : null,
    fields: () => [
      field({ label: t('fault.kind'), name: 'kind', type: 'select', required: true, value: 'equipment', options: [
        { value: 'equipment', label: t('fault.equipment') }, { value: 'technical', label: t('fault.technical') }] }),
      field({ label: t('fault.equipmentType'), name: 'equipmentType', type: 'select', options: eqOptions, value: 'monitor' }),
      field({ label: `${t('fault.category')} ${t('common.optional')}`, name: 'category' }),
      field({ label: t('fault.description'), name: 'description', type: 'textarea', required: true, maxlength: 300 }),
      field({ label: t('fault.severity'), name: 'severity', type: 'select', required: true, value: 'high',
        options: ['low', 'medium', 'high', 'critical'].map((s) => ({ value: s, label: t(`severity.${s}`) })) }),
      field({ label: `${t('fault.attachment')} ${t('common.optional')}`, name: 'attachmentName' }),
    ],
    map: (d) => ({ kind: d.kind, equipmentType: d.kind === 'equipment' ? d.equipmentType : undefined, category: d.category || undefined,
      description: d.description, severity: d.severity, attachmentName: d.attachmentName || null }) });
}

export const openStaffingGap = (bed, seen) => formDialog({ action: 'reportStaffingGap', payload: { bedId: bed.id }, seen, danger: true,
  title: t('staffingGap.title', { bed: bed.label }), fields: () => [reasonField(t('staffingGap.reason'))] });

export function openConfirmStaffing(bed, seen) {
  const nurses = values(state(), 'users').filter((u) => u.role === 'nurse' && u.active && u.hospitalId === bed.hospitalId && u.department === bed.department);
  return formDialog({ action: 'confirmStaffing', payload: { bedId: bed.id }, seen, title: t('staffing.title', { bed: bed.label }),
    fields: () => [field({ label: t('staffing.nurse'), name: 'nurseUserId', type: 'select', required: true, options: nurses.map((u) => ({ value: u.id, label: u.name })) })] });
}

export const openEquipmentCheck = (bed, seen) => formDialog({ action: 'recordEquipmentCheck', payload: { bedId: bed.id }, seen, title: t('check.title', { bed: bed.label }),
  fields: () => [
    field({ label: t('check.equipment'), name: 'equipment', type: 'select', required: true, options: bed.requiredEquipment.map((e) => ({ value: e, label: t(`equipment.${e}`) })) }),
    field({ label: t('check.result'), name: 'result', type: 'select', required: true, options: [{ value: 'passed', label: t('check.passed') }, { value: 'failed', label: t('check.failed') }] }),
    field({ label: t('check.note'), name: 'note', type: 'textarea', rows: 2 }),
  ],
  map: (d) => ({ equipment: d.equipment, result: d.result, note: d.note || null }) });

export const openResolve = (ticket, seen) => formDialog({ action: 'resolveFault', payload: { ticketId: ticket.id }, seen, title: t('resolve.title', { ref: ticket.ref }),
  fields: () => [field({ label: t('resolve.resolution'), name: 'resolution', type: 'textarea', required: true, hint: t('common.reasonHint'), maxlength: 500 })] });

export const openReopen = (ticket, seen) => formDialog({ action: 'reopenTicket', payload: { ticketId: ticket.id }, seen, danger: true,
  title: t('reopen.title', { ref: ticket.ref }), fields: () => [reasonField(t('reopen.reason'))] });

export const openExtend = (res, seen) => formDialog({ action: 'extendReservation', payload: { reservationId: res.id }, seen,
  title: t('extend.title', { bed: state().beds[res.bedId].label }),
  fields: () => [field({ label: t('extend.minutes'), name: 'minutes', type: 'select', required: true, value: '15', options: minutesOptions([10, 15, 30, 60]) }),
    reasonField(t('common.reason'))],
  map: (d) => ({ minutes: Number(d.minutes), reason: d.reason }) });

export const openRelease = (res, seen) => formDialog({ action: 'releaseReservation', payload: { reservationId: res.id }, seen, danger: true,
  title: t('release.title', { bed: state().beds[res.bedId].label }), fields: () => [reasonField(t('release.reason'))] });

// ---------- Tasks ----------
export const openTaskNote = (task, status, seen) => formDialog({ action: 'updateTaskStatus', payload: { taskId: task.id, status }, seen,
  danger: status === 'canceled', submitLabel: t(`taskStatus.${status}`),
  title: t(status === 'canceled' ? 'taskCancel.title' : 'taskBlock.title', { task: task.title }),
  fields: () => [reasonField(t('taskBlock.note'), 'note')] });

// ---------- Demo ----------
export function openReset() {
  return openDialog({
    title: t('reset.title'), intro: note(t('reset.body'), 'warn'), danger: true, submitLabel: t('reset.confirm'), fields: () => [],
    onSubmit: () => {
      ctx.store.resetDemo();
      ctx.ui.drawer = null;
      ctx.ui.tileFilter = null;
      toast(t('reset.done'), 'success');
      requestRender();
    },
  });
}
