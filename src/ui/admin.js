// Administrator page (read-only for the demo): who has which role where, and the audit log in plain language.
// Admins cannot perform clinical actions — the engine rejects them (permissions.js) and every clinical button shows why.

import { values } from '../data.js';
import { can } from '../permissions.js';
import { ACTION_NAMES } from '../actions.js';
import { auditLog } from '../selectors.js';
import { t, tm, formatDateTime } from '../i18n.js';
import { h, append, nextUid } from './dom.js';
import { icon } from './icons.js';
import { state, currentUser, requestRender } from './core.js';
import { emptyState, panel, roleLabel, userName } from './components.js';
import { changeText } from './handover.js';

const filters = { userId: '', record: '', action: '', from: '', to: '' };

// A record filter accepts a reference people read (SL-2041, TR-…, ER-10) as well as a raw id.
function recordIdFor(s, q) {
  const v = q.trim();
  if (!v) return null;
  const byRef = values(s, 'cases').find((c) => c.ref.toLowerCase() === v.toLowerCase())
    ?? values(s, 'transferRequests').find((x) => x.ref?.toLowerCase() === v.toLowerCase())
    ?? values(s, 'beds').find((b) => b.label.toLowerCase() === v.toLowerCase());
  return byRef?.id ?? v;
}
const localIso = (v) => (v ? new Date(v).toISOString() : null); // <input type="datetime-local"> is local time

export function renderAdmin(main) {
  const s = state();
  const u = currentUser();
  const allowed = can(u, 'viewAuditLog', null);
  if (!allowed.allowed) { append(main, [h('h1', { text: t('admin.title') }), emptyState(tm(allowed.reason), 'lock')]); return; }
  const users = values(s, 'users').filter((x) => !x.shared && x.role !== 'citizen')
    .sort((a, b) => (a.hospitalId ?? '~').localeCompare(b.hospitalId ?? '~') || roleLabel(a.role).localeCompare(roleLabel(b.role)) || a.name.localeCompare(b.name));
  const entries = auditLog(s, { userId: filters.userId || null, recordId: recordIdFor(s, filters.record), action: filters.action || null,
    from: localIso(filters.from), to: localIso(filters.to) });
  const set = (k) => (e) => { filters[k] = e.target.value; requestRender(); };
  const ids = { user: nextUid('af-user'), record: nextUid('af-record'), action: nextUid('af-action'), from: nextUid('af-from'), to: nextUid('af-to') };

  append(main, [
    h('h1', { text: t('admin.title') }),
    h('p', { class: 'notice warn' }, icon('lock', { size: 18 }), h('span', { text: t('admin.backendNote') })),
    panel(t('admin.users'), 'staff', users.length,
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['admin.colName', 'admin.colRole', 'admin.colHospital', 'admin.colDept'].map((k) => h('th', { scope: 'col', text: t(k) })))),
        h('tbody', {}, users.map((x) => h('tr', {},
          h('th', { scope: 'row', text: x.name }),
          h('td', { text: roleLabel(x.role) }),
          h('td', { text: x.hospitalId ? s.hospitals[x.hospitalId]?.name ?? '' : t('admin.noHospital') }),
          h('td', { text: x.ambulanceId ? t('crew.unit', { id: x.ambulanceId }) : x.department ? t(`dept.${x.department}`) : t('user.hospitalWide') }))))))),
    panel(t('admin.audit'), 'history', entries.length,
      h('div', { class: 'filters' },
        h('div', { class: 'field' }, h('label', { for: ids.user, text: t('admin.filterUser') }),
          h('select', { id: ids.user, 'data-focus-key': 'af-user', onchange: set('userId') },
            h('option', { value: '', text: t('admin.any') }),
            users.map((x) => h('option', { value: x.id, selected: filters.userId === x.id, text: `${x.name} — ${roleLabel(x.role)}` })))),
        h('div', { class: 'field' }, h('label', { for: ids.record, text: t('admin.filterRecord') }),
          h('input', { id: ids.record, type: 'text', value: filters.record, 'data-preserve': 'af-record', 'data-model-backed': '', placeholder: 'SL-2041', oninput: set('record') })),
        h('div', { class: 'field' }, h('label', { for: ids.action, text: t('admin.filterAction') }),
          h('select', { id: ids.action, 'data-focus-key': 'af-action', onchange: set('action') },
            h('option', { value: '', text: t('admin.any') }),
            ACTION_NAMES().map((a) => h('option', { value: a, selected: filters.action === a, text: t(`auditAction.${a}`) })))),
        h('div', { class: 'field' }, h('label', { for: ids.from, text: t('admin.filterFrom') }),
          h('input', { id: ids.from, type: 'datetime-local', value: filters.from, 'data-focus-key': 'af-from', onchange: set('from') })),
        h('div', { class: 'field' }, h('label', { for: ids.to, text: t('admin.filterTo') }),
          h('input', { id: ids.to, type: 'datetime-local', value: filters.to, 'data-focus-key': 'af-to', onchange: set('to') })),
        h('button', { type: 'button', class: 'btn', 'data-focus-key': 'af-clear', onclick: () => { Object.assign(filters, { userId: '', record: '', action: '', from: '', to: '' }); requestRender(); } }, t('admin.clear'))),
      h('p', { class: 'small muted', role: 'status', text: t('admin.entries', { n: entries.length }) }),
      entries.length ? h('ol', { class: 'audit-list' }, entries.slice(0, 200).map((e) => auditRow(s, e))) : emptyState(t('admin.noEntries'), 'history')),
  ]);
}

function auditRow(s, e) {
  const caseRef = e.refs?.map((r) => (r.entity === 'case' ? s.cases[r.id] : null)).find(Boolean);
  const vitals = caseRef ? s.arrivalNotices[caseRef.noticeId]?.handover?.vitals ?? [] : [];
  return h('li', { class: 'audit-row' },
    h('time', { datetime: e.at, text: formatDateTime(e.at) }),
    h('div', {},
      h('p', {}, h('strong', { text: tm(e.summary) })),
      h('p', { class: 'small muted', text: `${e.actorRole ? t('admin.by', { name: e.actorName ?? userName(e.actorId), role: roleLabel(e.actorRole) }) : e.actorName ?? userName(e.actorId)} · ${t(`auditAction.${e.action}`)}` }),
      e.reason ? h('p', { class: 'small', dir: 'auto', text: t('admin.reason', { text: e.reason }) }) : null,
      Array.isArray(e.details) && e.details.length ? h('p', { class: 'small', text: t('admin.changes', { list: e.details.map((ch) => changeText(ch, vitals)).join('; ') }) }) : null));
}
