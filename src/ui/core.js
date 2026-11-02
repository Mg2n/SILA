// UI core: session, render scheduling, the single path to dispatch(), toasts and modal dialogs.
// The UI never mutates state; it reads store.getState() and calls the engine.

import { getStore } from '../store.js';
import { targetOf, preflight } from '../actions.js';
import { can } from '../permissions.js';
import { t, tm } from '../i18n.js';
import { h, clear, append, nextUid } from './dom.js';
import { icon } from './icons.js';

export const ctx = {
  store: null,
  ui: { route: 'er', drawer: null, tileFilter: null, notifOpen: false, highlight: null, lastRemoteAt: null },
  render: null, // set by app.js
};

const SESSION_KEY = 'sila.activeUser';
export const DEFAULT_USER = 'u-er-coord';

export const now = () => new Date().toISOString();
export const state = () => ctx.store.getState();

export function initStore() {
  ctx.store = getStore();
  return ctx.store;
}

export function isStaff(u) {
  return !!u && !['citizen', 'paramedic'].includes(u.role) && u.active !== false;
}

// The active demo account is per tab (sessionStorage), so two tabs can act as different staff.
export function currentUser() {
  const s = state();
  let id = null;
  try { id = sessionStorage.getItem(SESSION_KEY); } catch { /* storage blocked */ }
  const u = s.users[id];
  return isStaff(u) ? u : s.users[DEFAULT_USER];
}
// Which department dashboards an account may open: ER/ICU staff their own; hospital-wide roles both.
export function deptAccess(u) {
  return u.department ? [u.department] : ['ER', 'ICU'];
}
export const QUEUE_ROLES = ['housekeeping', 'maintenance_tech', 'biomed_tech', 'diagnostics'];
export function routeAllowed(route, u) {
  if (route === 'er') return deptAccess(u).includes('ER');
  if (route === 'icu') return deptAccess(u).includes('ICU');
  if (route === 'queue') return QUEUE_ROLES.includes(u.role);
  if (route === 'transport') return u.role === 'porter';
  return route === 'tasks';
}
export function defaultRoute(u) {
  if (u.role === 'porter') return 'transport';
  if (QUEUE_ROLES.includes(u.role)) return 'queue';
  return u.department === 'ICU' ? 'icu' : 'er';
}

export function setCurrentUser(id) {
  try { sessionStorage.setItem(SESSION_KEY, id); } catch { /* storage blocked */ }
  ctx.ui.notifOpen = false;
  requestRender();
}

// rAF batches renders while visible; the timer covers background tabs, where rAF is paused but a change
// synced from another tab must still be rendered promptly.
let scheduled = false;
export function requestRender() {
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    if (!scheduled) return;
    scheduled = false;
    ctx.render?.();
  };
  requestAnimationFrame(flush);
  setTimeout(flush, 100);
}

// ---------- Engine access ----------
export function check(action, payload, opts) {
  return preflight(state(), action, payload, currentUser(), now(), opts);
}
// The version the user is looking at right now; captured at render/open time and sent with the action.
export function seenVersion(action, payload) {
  return targetOf(state(), action, payload)?.version;
}
export function canSeePatient(hospitalId) {
  return can(currentUser(), 'viewPatientDetails', { hospitalId }).allowed;
}

const CONFLICT_KEY = { bed: 'conflict.bed', case: 'conflict.case' };

/** The only way the UI changes data. Returns the engine result. */
export function run(action, payload, { seen, quiet = false, silent = false, onDone, as = null } = {}) {
  const rec = targetOf(state(), action, payload);
  const body = rec ? { ...payload, expectedVersion: seen ?? rec.version } : payload;
  const res = ctx.store.dispatch(action, body, as ?? currentUser().id);
  if (res.ok) {
    if (!silent) toast(t(`done.${action}`), 'success');
    onDone?.(res);
  } else if (res.code === 'conflict') {
    toast(t(CONFLICT_KEY[rec?.entity] ?? 'conflict.generic'), 'warn');
  } else if (!quiet) {
    toast(t(res.code === 'forbidden' ? 'toast.forbidden' : 'toast.invalid', { reason: res.error }), 'error');
  }
  requestRender();
  return res;
}

// ---------- Citizen sessions (no login) ----------
// A citizen acts through the shared citizen account; this browser's device id decides which notices it owns.
export const CITIZEN_USER = 'u-citizen-public';
const DEVICE_KEY = 'sila.device';
let memoryDevice = null;
export function deviceRef() {
  const fresh = () => `device-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = fresh(); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch {
    memoryDevice ??= fresh(); // storage blocked: this tab only
    return memoryDevice;
  }
}
export const runCitizen = (action, payload, opts = {}) => run(action, { ...payload, deviceRef: deviceRef() }, { ...opts, as: CITIZEN_USER });
export const checkCitizen = (action, payload, opts) => preflight(state(), action, { ...payload, deviceRef: deviceRef() }, CITIZEN_USER, now(), opts);
export const seenCitizen = (action, payload) => targetOf(state(), action, { ...payload, deviceRef: deviceRef() })?.version;

// ---------- Navigation to a record (notifications, task links) ----------
export function openRecord(ref) {
  const s = state();
  const rec = s[{ bed: 'beds', case: 'cases', maintenanceTicket: 'maintenanceTickets', task: 'tasks', transferRequest: 'transferRequests', comment: 'comments' }[ref.entity]]?.[ref.id];
  let target = null;
  if (ref.entity === 'bed') target = { type: 'bed', id: ref.id };
  else if (ref.entity === 'case') target = { type: 'case', id: ref.id };
  else if (ref.entity === 'maintenanceTicket' && rec) target = { type: 'bed', id: rec.bedId };
  else if (ref.entity === 'transferRequest' && rec) target = { type: 'transfer', id: rec.id };
  else if (ref.entity === 'comment' && rec) target = rec.caseId ? { type: 'case', id: rec.caseId } : { type: rec.targetType === 'bed' ? 'bed' : 'case', id: rec.targetId };
  else if (ref.entity === 'task' && rec) {
    target = rec.linked.bedId ? { type: 'bed', id: rec.linked.bedId } : rec.linked.caseId ? { type: 'case', id: rec.linked.caseId } : null;
    if (!target) { ctx.ui.route = 'tasks'; location.hash = '#/tasks'; ctx.ui.highlight = { type: 'task', id: rec.id }; }
  }
  ctx.ui.notifOpen = false;
  if (target) { ctx.ui.drawer = target; ctx.ui.highlight = target; }
  requestRender();
}

export function closeDrawer() {
  const d = ctx.ui.drawer;
  ctx.ui.drawer = null;
  requestRender();
  // Return focus to the card that opened it, once re-rendered.
  if (d) requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(`[data-focus-key="open:${d.type}:${d.id}"]`)?.focus()));
}

// ---------- Toasts ----------
export function toast(message, kind = 'info', timeout = 6000) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = h('div', { class: ['toast', kind], role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'success' ? 'check' : kind === 'info' ? 'info' : 'alert'),
    h('p', { text: message }),
    h('button', { class: 'btn ghost small on-dark', type: 'button', 'aria-label': t('toast.dismiss'), onclick: () => el.remove() }, icon('close', { size: 14 })));
  root.append(el);
  while (root.children.length > 4) root.firstElementChild.remove();
  if (timeout) setTimeout(() => el.remove(), timeout);
}

// ---------- Modal dialogs (native <dialog>: focus trap, Esc to close) ----------
/**
 * openDialog({ title, fields: (form) => [elements], submitLabel, danger, onSubmit(data) → engine result | void })
 * The dialog stays open with the engine's message when the action is rejected (except version conflicts).
 */
export function openDialog({ title, intro = null, fields, submitLabel, danger = false, onSubmit, submitDisabled = false }) {
  const opener = document.activeElement;
  const titleId = nextUid('dlg-title');
  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const form = h('form', { method: 'dialog', novalidate: true });
  const dialog = h('dialog', { class: 'modal', 'aria-labelledby': titleId });
  const close = () => { dialog.close(); };
  const submit = h('button', { type: 'submit', class: ['btn', danger ? 'danger' : 'primary'], disabled: submitDisabled, text: submitLabel });
  append(form, [
    h('h2', { id: titleId, text: title }),
    intro,
    fields(form),
    errorBox,
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onclick: close, text: t('common.cancel') }),
      submit),
  ]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const missing = [...form.querySelectorAll('[required]')].find((el) => !String(el.value ?? '').trim());
    if (missing) {
      missing.setAttribute('aria-invalid', 'true');
      errorBox.textContent = t('common.reasonHint');
      errorBox.hidden = false;
      missing.focus();
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    const res = onSubmit(data, form);
    if (res && !res.ok && res.code !== 'conflict') {
      errorBox.textContent = tm(res.error);
      errorBox.hidden = false;
      return;
    }
    close();
  });
  dialog.append(form);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (opener && document.contains(opener)) opener.focus();
  });
  document.getElementById('dialog-root').append(dialog);
  dialog.showModal();
  (form.querySelector('input:not([type=hidden]):not(:disabled), select, textarea') ?? submit).focus();
  return dialog;
}

export function field({ label, name, type = 'text', options = null, required = false, hint = null, value = '', rows = 3, maxlength = null }) {
  const id = nextUid(`f-${name}`);
  const hintId = hint ? `${id}-hint` : null;
  let control;
  if (type === 'select') {
    control = h('select', { id, name, required, 'aria-describedby': hintId },
      options.map((o) => h('option', { value: o.value, selected: o.value === value, disabled: o.disabled, text: o.label })));
  } else if (type === 'textarea') {
    control = h('textarea', { id, name, required, rows, maxlength, 'aria-describedby': hintId, value });
  } else {
    control = h('input', { id, name, type, required, 'aria-describedby': hintId, value });
  }
  return h('div', { class: 'field' },
    h('label', { for: id }, label, required ? h('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null,
      required ? h('span', { class: 'sr-only', text: ` (${t('dialog.required')})` }) : null),
    control,
    hint ? h('span', { class: 'hint', id: hintId, text: hint }) : null);
}

export function clearEl(id) {
  return clear(document.getElementById(id));
}
