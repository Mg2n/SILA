// ICU dashboard: count tiles (selectors.icuDashboard), incoming transfer requests, patients in transit,
// the 8 ICU rooms (shared bed card + drawer) and overdue ICU work.

import { deriveTransferStatus } from '../readiness.js';
import { icuDashboard, icuBeds, ICU_TILE_KEYS } from '../selectors.js';
import { t, tm, formatTime, formatRelative } from '../i18n.js';
import { h, append } from './dom.js';
import { icon } from './icons.js';
import { ctx, state, now, currentUser, canSeePatient, requestRender } from './core.js';
import { pill, emptyState, panel, uiButton, userName, roleLabel, highlightClass } from './components.js';
import { bedCard, tileGrid, inTransitPanel, openDrawer } from './beds.js';

const TILE_ICON = { incomingRequests: 'transfer', awaitingDecision: 'stethoscope', waitingCapacity: 'hourglass', inTransit: 'transfer', occupied: 'person',
  available: 'check', reserved: 'lock', beingPrepared: 'broom', blocked: 'alert', expectedFree: 'clock', overdueTasks: 'alert' };
const TILE_TONE = { awaitingDecision: 'warn', waitingCapacity: 'warn', available: 'good', beingPrepared: 'warn', blocked: 'alert', overdueTasks: 'alert' };

export function renderIcu(main) {
  const s = state();
  const hId = currentUser().hospitalId;
  const n = now();
  const dash = icuDashboard(s, hId, n);
  const filter = ctx.ui.icuFilter && dash[ctx.ui.icuFilter] ? ctx.ui.icuFilter : null;
  const only = filter ? new Set(dash[filter].ids) : null;
  const kind = filter ? dash[filter].kind : null;

  const left = [];
  const right = [];
  if (!filter || kind === 'transfers') left.push(incomingPanel(s, hId, n, filter ? dash[filter].ids : dash.incomingRequests.ids));
  if (!filter) left.push(inTransitPanel(s, hId, n));
  if (!filter || kind === 'beds') right.push(roomsPanel(s, hId, n, only));
  if (!filter || filter === 'overdueTasks') right.push(overduePanel(s, dash.overdueTasks.ids, n));
  const L = left.filter(Boolean);
  const R = right.filter(Boolean);

  append(main, [
    h('div', { class: 'page-head' },
      h('h1', { text: t('icu.title', { hospital: s.hospitals[hId]?.name ?? '' }) }),
      h('p', { class: 'small muted' }, icon('spark', { size: 14 }), ' ', t('er.live', { time: formatTime(n) }))),
    tileGrid({ keys: ICU_TILE_KEYS, dash, filterProp: 'icuFilter', labelKey: (k) => `icuTile.${k}`, icons: TILE_ICON, tones: TILE_TONE, ariaLabel: t('icu.tilesLabel') }),
    filter ? h('div', { class: 'filter-bar', role: 'status' }, icon('filter', { size: 16 }),
      h('span', { text: t('common.showing', { label: t(`icuTile.${filter}`), n: dash[filter].count }) }),
      h('button', { type: 'button', class: 'btn small on-dark', 'data-focus-key': 'clear-filter', onclick: () => { ctx.ui.icuFilter = null; requestRender(); }, text: t('common.clearFilter') })) : null,
    !L.length || !R.length
      ? h('div', { class: 'board single' }, h('div', { class: 'col' }, ...L, ...R))
      : h('div', { class: 'board' }, h('div', { class: 'col' }, ...L), h('div', { class: 'col' }, ...R)),
  ]);
}

function incomingPanel(s, hId, n, ids) {
  const list = ids.map((id) => s.transferRequests[id]).filter(Boolean);
  return panel(t('icu.incoming'), 'transfer', list.length, list.length ? h('div', { class: 'cards' }, list.map((tr) => {
    const c = s.cases[tr.caseId];
    const st = deriveTransferStatus(tr, s, n);
    const who = canSeePatient(hId) ? s.patients[tr.patientId].alias : t('common.dash');
    const reqs = ['isolation', 'ventilator', 'monitor'].filter((k) => tr.requirements?.[k]);
    return h('article', { class: ['card', highlightClass('transfer', tr.id)], 'aria-label': tr.ref },
      h('div', { class: 'card-head' }, icon('transfer', { size: 22 }),
        h('div', { class: 'title' }, h('h3', { class: 'ref', text: tr.ref }), h('span', { class: 'small muted', text: `${who} · ${c.ref}` })),
        h('div', { class: 'end' }, pill(tr.status === 'requested' ? 'pending' : st.key === 'capacity' ? 'pending' : 'neutral', tm(st.label), 'transfer'))),
      h('dl', { class: 'facts' },
        h('dt', { text: t('transfer.route') }), h('dd', { text: t('transfer.routeValue', { from: s.beds[tr.fromBedId]?.label ?? t('er.inEr'), to: s.beds[tr.targetBedId]?.label ?? t('transfer.toUnknown') }) }),
        h('dt', { text: t('transfer.requirements') }), h('dd', {}, reqs.length ? reqs.map((k) => h('span', { class: 'chip', text: t(`req.${k}`) })) : t('incoming.noRequirements')),
        h('dt', { text: t('transfer.status') }), h('dd', {}, tm(st.reason),
          st.ownerRole ? h('span', { class: 'small muted', text: ` · ${t('transfer.nextOwner', { owner: `${roleLabel(st.ownerRole)}${st.ownerUser ? `: ${userName(st.ownerUser)}` : ''}` })}` }) : null),
        h('dt', { text: t('step.requested') }), h('dd', { text: `${formatRelative(tr.requestedAt, n)} · ${userName(tr.requestedBy)}` })),
      h('div', { class: 'action-row' }, uiButton(t('action.openTransfer'), openDrawer('transfer', tr.id), { kind: 'primary', small: true, 'data-focus-key': `open:transfer:${tr.id}` })));
  })) : emptyState(t('empty.icuIncoming'), 'transfer'));
}

function roomsPanel(s, hId, n, only) {
  const beds = icuBeds(s, hId).filter((b) => !only || only.has(b.id));
  return panel(t('icu.rooms'), 'bed', beds.length,
    beds.length ? h('div', { class: 'bed-grid' }, beds.map((b) => bedCard(s, b, n))) : emptyState(t('empty.rooms'), 'bed'));
}

function overduePanel(s, ids, n) {
  const items = ids.map((id) => s.tasks[id] ?? s.maintenanceTickets[id]).filter(Boolean);
  return panel(t('icu.overdue'), 'alert', items.length, items.length ? h('ul', { class: 'rows' }, items.map((x) => {
    const bedId = x.entity === 'task' ? x.linked.bedId : x.bedId;
    return h('li', { class: 'row overdue' }, icon('alert'),
      h('div', { class: 'grow' }, h('strong', { text: x.entity === 'task' ? tm(x.title) : `${x.ref} · ${tm(x.category)}` }),
        h('span', { class: 'small' }, pill('blocked', t('task.overdue'), 'clock'), ' ', t('task.due', { time: formatTime(x.dueAt), rel: formatRelative(x.dueAt, n) }))),
      bedId ? uiButton(t('action.openBed', { bed: s.beds[bedId]?.label }), openDrawer('bed', bedId), { small: true }) : null);
  })) : emptyState(t('empty.overdue'), 'check'));
}
