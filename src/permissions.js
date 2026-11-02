// SILA — capability map (SPEC §6 + porter). Enforced inside dispatch, not only in the UI.
// Demo note: these role checks simulate permissions; production needs server-side authN/authZ.
//
// can(user, action, record) → { allowed, reason }   (reason is a message { code, params } or null)
// `record` is the scope of the target: { entity, hospitalId, department, assignedUserIds, ticketKind,
// requiredRole, porterUserId, recipient } — actions.js builds it from the live record.

import { ROLES } from './data.js';
import { msg } from './messages.js';

const DEPT = { ER: msg('dept.ER'), ICU: msg('dept.ICU') };
const deptMsg = (d) => DEPT[d] ?? msg('dept.this');
const ROLE_LOWER = {
  er_coordinator: msg('roleLower.er_coordinator'), icu_coordinator: msg('roleLower.icu_coordinator'), nurse: msg('roleLower.nurse'),
  doctor: msg('roleLower.doctor'), housekeeping: msg('roleLower.housekeeping'), maintenance_tech: msg('roleLower.maintenance_tech'),
  biomed_tech: msg('roleLower.biomed_tech'), diagnostics: msg('roleLower.diagnostics'), porter: msg('roleLower.porter'),
  admin: msg('roleLower.admin'), paramedic: msg('roleLower.paramedic'), citizen: msg('roleLower.citizen'),
};

// Each check returns null when satisfied, or a reason message.
const roleIs = (roles, reason) => (u, r) => (roles.includes(u.role) ? null : typeof reason === 'function' ? reason(r) : reason);
const sameHospital = (u, r) => (!r.hospitalId || u.hospitalId === r.hospitalId ? null : msg('perm.ownHospital'));
const sameDepartment = (reason) => (u, r) => (!r.department || u.department === r.department ? null : typeof reason === 'function' ? reason(r) : reason);
const assigned = (reason) => (u, r) => ((r.assignedUserIds ?? []).includes(u.id) ? null : reason);
const all = (...checks) => (u, r) => {
  for (const c of checks) {
    const reason = c(u, r);
    if (reason) return reason;
  }
  return null;
};
const any = (reason, ...alternatives) => (u, r) => (alternatives.some((c) => c(u, r) === null) ? null : reason);
const withDept = (department, rule) => (u, r) => rule(u, { ...r, department });

const COORDINATORS = ['er_coordinator', 'icu_coordinator'];
const STAFF_ROLES = ROLES.filter((r) => r.staff).map((r) => r.id);
const CLINICAL_VIEWERS = ['er_coordinator', 'icu_coordinator', 'nurse', 'doctor', 'diagnostics', 'porter'];

// "Only the {dept} coordinator / charge nurse can {what}."
const coordinatorOf = (what) => {
  const reason = (r) => msg('perm.coordinatorOnly', { dept: deptMsg(r.department), what });
  return all(roleIs(COORDINATORS, reason), sameHospital, sameDepartment(reason));
};

// Department-scoped staff; `code` names the specific sentence, e.g. perm.confirmPlacement.
const deptStaff = (roles, reasonFor) => (u, r) => {
  const reason = reasonFor(r);
  return all(roleIs(roles, reason), sameHospital, sameDepartment(reason))(u, r);
};

// A case belongs to its submitter and crew; a no-login citizen session owns cases sent from its device (deviceRef).
export const ownsCase = (u, r) => (r.assignedUserIds ?? []).includes(u.id) && !u.shared
  || (u.role === 'citizen' && !!r.ownerDevice && r.requesterDevice === r.ownerDevice);

// "Only the person who submitted this case or its ambulance crew can {what}."
const crewOrSubmitter = (what) => {
  const reason = msg('perm.crewOrSubmitter', { what });
  return all(roleIs(['citizen', 'paramedic'], reason), (u, r) => (ownsCase(u, r) ? null : reason));
};

const techFor = (verb) => (u, r) => {
  const equipment = r.ticketKind === 'equipment';
  const reason = equipment ? msg('perm.biomedOnly', { verb }) : msg('perm.maintenanceOnly', { verb });
  return all(roleIs([equipment ? 'biomed_tech' : 'maintenance_tech'], reason), sameHospital)(u, r);
};
const VERB = { workOn: msg('verb.workOn'), resolve: msg('verb.resolve'), reopen: msg('verb.reopen') };

const erDoctor = msg('perm.erDoctorOnly');
const icuDecision = msg('perm.icuDoctorDecision');

export const RULES = {
  submitArrival: (u, r) => all(
    roleIs(['citizen', 'paramedic'], msg('perm.submitArrival')),
    r.entity === 'case' ? (uu, rr) => (ownsCase(uu, rr) ? null : msg('perm.updateNotice')) : () => null,
  )(u, r),
  updateETA: crewOrSubmitter(msg('what.updateEta')),
  changeDestination: crewOrSubmitter(msg('what.changeDestination')),
  respondClarification: crewOrSubmitter(msg('what.respondClarification')),
  cancelCase: any(msg('perm.cancelCase'), crewOrSubmitter(msg('what.cancel')), all(roleIs(['er_coordinator'], msg('perm.cancelCase')), sameHospital)),

  acknowledgeArrival: all(roleIs(['er_coordinator'], msg('perm.acknowledgeArrival')), sameHospital),
  requestClarification: deptStaff(['er_coordinator', 'doctor', 'nurse'], () => msg('perm.requestClarification')),
  recordTriage: deptStaff(['er_coordinator', 'nurse', 'doctor'], () => msg('perm.recordTriage')),
  assignCoordinator: all(roleIs(['er_coordinator'], msg('perm.assignCoordinator')), sameHospital),

  reserveBed: coordinatorOf(msg('what.reserveBeds')),
  extendReservation: coordinatorOf(msg('what.extendReservations')),
  releaseReservation: coordinatorOf(msg('what.releaseReservations')),
  confirmStaffing: coordinatorOf(msg('what.confirmStaffing')),
  reportStaffingGap: coordinatorOf(msg('what.reportStaffingGaps')),
  confirmCapacity: withDept('ICU', coordinatorOf(msg('what.confirmCapacity'))),
  confirmPlacement: deptStaff(['er_coordinator', 'icu_coordinator', 'nurse'], (r) => msg('perm.confirmPlacement', { dept: deptMsg(r.department) })),
  confirmDeparture: deptStaff(['er_coordinator', 'icu_coordinator', 'nurse'], (r) => msg('perm.confirmDeparture', { dept: deptMsg(r.department) })),
  confirmArrival: (u, r) => (r.entity === 'transferRequest'
    ? withDept('ICU', deptStaff(['icu_coordinator', 'nurse'], () => msg('perm.confirmIcuArrival')))(u, r)
    : any(msg('perm.confirmErArrival'), deptStaff(['er_coordinator', 'nurse'], () => msg('perm.confirmErArrival')),
      all(roleIs(['paramedic'], msg('perm.confirmErArrival')), assigned(msg('perm.confirmErArrival'))))(u, r)),

  reportFault: deptStaff(['nurse', 'er_coordinator', 'icu_coordinator'], (r) => msg('perm.reportFault', { dept: deptMsg(r.department) })),
  updateTicketStatus: techFor(VERB.workOn),
  resolveFault: techFor(VERB.resolve),
  reopenTicket: any(msg('perm.reopenTicket'), deptStaff(['nurse', 'er_coordinator', 'icu_coordinator'], () => msg('perm.reopenTicket')), techFor(VERB.reopen)),
  recordEquipmentCheck: all(roleIs(['biomed_tech'], msg('perm.equipmentCheck')), sameHospital),
  completeCleaning: all(roleIs(['housekeeping'], msg('perm.housekeepingOnly')), sameHospital),
  verifyReadiness: all(roleIs(['nurse'], msg('perm.verifyNurseOnly')), sameHospital,
    sameDepartment((r) => msg('perm.verifyDept', { dept: deptMsg(r.department) }))),

  requestTransfer: withDept('ER', all(roleIs(['doctor'], erDoctor), sameHospital, sameDepartment(erDoctor))),
  approveTransfer: withDept('ICU', all(roleIs(['doctor'], icuDecision), sameHospital, sameDepartment(icuDecision))),
  cancelTransferRequest: any(msg('perm.cancelTransfer'),
    withDept('ER', all(roleIs(['doctor'], erDoctor), sameHospital, sameDepartment(erDoctor))),
    withDept('ICU', all(roleIs(['icu_coordinator'], erDoctor), sameHospital, sameDepartment(erDoctor)))),
  flagStepDown: withDept('ICU', all(roleIs(['doctor'], msg('perm.icuDoctorStepDown')), sameHospital, sameDepartment(msg('perm.icuDoctorStepDown')))),
  recordDisposition: deptStaff(['doctor'], (r) => msg('perm.recordDisposition', { dept: deptMsg(r.department) })),
  orderDiagnostic: deptStaff(['doctor'], (r) => msg('perm.orderDiagnostic', { dept: deptMsg(r.department) })),
  acknowledgeReport: deptStaff(['doctor'], (r) => msg('perm.acknowledgeReport', { dept: deptMsg(r.department) })),

  assignPorter: all(roleIs(COORDINATORS, msg('perm.assignPorter')), sameHospital),
  confirmPickup: all(roleIs(['porter'], msg('perm.porterPickup')), sameHospital,
    (u, r) => (r.porterUserId === u.id ? null : msg('perm.assignedPorterPickup'))),
  confirmDropoff: all(roleIs(['porter'], msg('perm.porterDropoff')), sameHospital,
    (u, r) => (r.porterUserId === u.id ? null : msg('perm.assignedPorterDropoff'))),

  updateTaskStatus: (u, r) => {
    const reason = msg('perm.taskRole', { role: ROLE_LOWER[r.requiredRole] ?? msg('roleLower.staff'), inDept: r.department ? msg('perm.inDept', { dept: deptMsg(r.department) }) : msg('common.empty') });
    const scoped = ['nurse', 'doctor'].includes(r.requiredRole);
    return all(roleIs([r.requiredRole], reason), sameHospital, scoped ? sameDepartment(reason) : () => null)(u, r);
  },
  addComment: all(roleIs(STAFF_ROLES, msg('perm.staffComment')), sameHospital),
  markNotificationRead: (u, r) => {
    const to = r.recipient ?? {};
    const mine = to.deviceRef ? to.deviceRef === r.requesterDevice : to.userId ? to.userId === u.id
      : to.role === u.role && (!to.hospitalId || to.hospitalId === u.hospitalId) && (!to.department || to.department === u.department);
    return mine ? null : msg('perm.notificationRecipient');
  },

  // Read capability: a citizen session sees only the notices sent from its own device.
  viewCitizenCase: all(roleIs(['citizen', 'paramedic'], msg('perm.ownCaseOnly')), (u, r) => (ownsCase(u, r) ? null : msg('perm.ownCaseOnly'))),

  // Read capability (not a dispatch action): who may see patient aliases, reported concerns, transcripts and care tasks.
  viewPatientDetails: all(roleIs(CLINICAL_VIEWERS, msg('perm.viewPatient')), sameHospital),
};

export function can(user, action, record = {}) {
  if (!user) return { allowed: false, reason: msg('perm.noUser') };
  if (user.active === false) return { allowed: false, reason: msg('perm.deactivated') };
  const rule = RULES[action];
  if (!rule) return { allowed: false, reason: msg('perm.unknownAction', { action }) };
  const reason = rule(user, record ?? {});
  return reason ? { allowed: false, reason } : { allowed: true, reason: null };
}
