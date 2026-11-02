// SILA — every user-facing engine message is a code with parameters: { code, params }.
// The UI renders it with i18n (t / tm). The engine never builds sentences, so every message is translatable.
// Rule (enforced by a test): msg() is always called with a string-literal code.

export function msg(code, params) {
  return params ? { code, params } : { code };
}

export const isMsg = (v) => !!v && typeof v === 'object' && typeof v.code === 'string';

// A time parameter; the UI formats it in the viewer's locale and time zone.
export const iso = (value) => ({ iso: value });

// Shared parameter messages (literal codes, so every code the engine can emit is visible to the code-coverage test).
export const DEPT_MSG = { ER: msg('dept.ER'), ICU: msg('dept.ICU') };
export const ROLE_MSG = {
  er_coordinator: msg('role.er_coordinator'), icu_coordinator: msg('role.icu_coordinator'), nurse: msg('role.nurse'), doctor: msg('role.doctor'),
  housekeeping: msg('role.housekeeping'), maintenance_tech: msg('role.maintenance_tech'), biomed_tech: msg('role.biomed_tech'),
  diagnostics: msg('role.diagnostics'), porter: msg('role.porter'), admin: msg('role.admin'), paramedic: msg('role.paramedic'), citizen: msg('role.citizen'),
};
export const CASE_STATUS_MSG = { active: msg('caseStatus.active'), canceled: msg('caseStatus.canceled'), closed: msg('caseStatus.closed') };
export const TRANSFER_STATUS_MSG = {
  requested: msg('trLower.requested'), declined: msg('trLower.declined'), accepted: msg('trLower.accepted'), reserved: msg('trLower.reserved'),
  in_transit: msg('trLower.in_transit'), arrived: msg('trLower.arrived'), completed: msg('trLower.completed'), canceled: msg('trLower.canceled'),
};
export const TASK_STATUS_MSG = {
  open: msg('taskLower.open'), accepted: msg('taskLower.accepted'), in_progress: msg('taskLower.in_progress'), blocked: msg('taskLower.blocked'),
  done: msg('taskLower.done'), canceled: msg('taskLower.canceled'), requested: msg('taskLower.requested'), scheduled: msg('taskLower.scheduled'),
  report_available: msg('taskLower.report_available'),
};
export const TICKET_STATUS_MSG = { open: msg('ticketLower.open'), assigned: msg('ticketLower.assigned'), in_progress: msg('ticketLower.in_progress'), resolved: msg('ticketLower.resolved') };
export const RESERVATION_STATE_MSG = { active: msg('resLower.active'), expired: msg('resLower.expired'), released: msg('resLower.released'), fulfilled: msg('resLower.fulfilled'), unreserved: msg('resLower.unreserved') };
export const EQUIP_MSG = { monitor: msg('equipLower.monitor'), ventilator: msg('equipLower.ventilator'), infusion_pump: msg('equipLower.infusion_pump'), oxygen: msg('equipLower.oxygen') };
export const DIAG_MSG = { eeg: msg('diag.eeg'), ct_head: msg('diag.ct_head'), chest_xray: msg('diag.chest_xray'), ultrasound: msg('diag.ultrasound'), echo: msg('diag.echo'), lab_panel: msg('diag.lab_panel') };
export const SEVERITY_MSG = { low: msg('severityLower.low'), medium: msg('severityLower.medium'), high: msg('severityLower.high'), critical: msg('severityLower.critical') };
export const BLOCKER_TYPE_MSG = {
  occupied: msg('blockerType.occupied'), cleaning: msg('blockerType.cleaning'), technical_fault: msg('blockerType.technical_fault'),
  equipment_ticket: msg('blockerType.equipment_ticket'), equipment_check: msg('blockerType.equipment_check'), staffing: msg('blockerType.staffing'),
  nursing_verification: msg('blockerType.nursing_verification'), reserved: msg('blockerType.reserved'),
};
export const SOURCE_MSG = { ambulance: msg('source.ambulance'), citizen: msg('source.citizen'), walk_in: msg('source.walk_in'), internal: msg('source.internal') };
export const WHY_MSG = { discharge: msg('why.discharge'), admit_ward: msg('why.admit_ward'), step_down: msg('why.step_down') };
export const DECISION_MSG = { discharge: msg('decision.discharge'), admit_ward: msg('decision.admit_ward') };
export const NOTICE_STATUS_MSG = {
  submitted: msg('noticeLower.submitted'), acknowledged: msg('noticeLower.acknowledged'), en_route: msg('noticeLower.en_route'), arrived: msg('noticeLower.arrived'),
  handover_complete: msg('noticeLower.handover_complete'), canceled: msg('noticeLower.canceled'), closed: msg('noticeLower.closed'),
};
export const NO_TEXT = msg('common.empty');
