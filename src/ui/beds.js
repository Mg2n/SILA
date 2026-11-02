// Shared board pieces: bed/room cards (ER and ICU), count tiles, and the "in transit" panel shown on both boards.

import { values } from '../data.js';
import { latestEquipmentCheck, isCheckValid, deriveTransferStatus } from '../readiness.js';
import { bedBoardStatus } from '../selectors.js';
import { t, tm, formatTime, formatDuration } from '../i18n.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { ctx, state, canSeePatient, requestRender } from './core.js';
import { pill, panel, forecastLine, userName, highlightClass, uiButton } from './components.js';

export const openDrawer = (type, id) => () => { ctx.ui.drawer = { type, id }; ctx.ui.highlight = { type, id }; requestRender(); };

const activeCase = (s, patientId) => values(s, 'cases').find((c) => c.patientId === patientId && c.status === 'active') ?? null;

export function bedCard(s, b, n) {
  const st = bedBoardStatus(b, s, n);
  const showP = canSeePatient(b.hospitalId);
  const patient = b.occupancy.patientId ? s.patients[b.occupancy.patientId] : null;
  const kase = patient ? activeCase(s, patient.id) : null;
  const nurse = values(s, 'staffingAssignments').find((a) => a.bedId === b.id && a.status === 'confirmed');
  const tickets = values(s, 'maintenanceTickets').filter((x) => x.bedId === b.id && x.status !== 'resolved');
  const res = st.reservation;
  const transitTr = res && !res.expiresAt ? s.transferRequests[res.transferId] : null;
  const icu = b.department === 'ICU';
  const monitorOk = isCheckValid(latestEquipmentCheck(s, b.id, 'monitor'));
  const line = (iconName, text, cls = '') => h('span', { class: ['line', cls] }, icon(iconName, { size: 15 }), h('span', { text }));
  return h('button', {
    type: 'button', class: ['bed-card', st.level, highlightClass('bed', b.id)], 'data-focus-key': `open:bed:${b.id}`,
    'aria-label': `${t('bed.open', { bed: b.label })} — ${t(`level.${st.level}`)}`, onclick: openDrawer('bed', b.id),
  },
  h('span', { class: 'bed-head' },
    h('span', {}, h('span', { class: 'bed-label', text: b.label }), h('span', { class: 'small muted', text: ` · ${b.zone}` })),
    h('span', { class: 'indicators' }, st.urgent ? pill('urgent', t('bed.urgent')) : null, pill(st.level))),
  kase?.stepDown?.flagged ? h('span', { class: 'indicators' }, pill('reserved', t('bed.expectedFree'), 'clock')) : null,
  transitTr && ['in_transit', 'arrived'].includes(transitTr.status)
    ? h('span', { class: 'indicators' }, pill('pending', t('bed.inTransit', { ref: s.cases[transitTr.caseId]?.ref ?? '' }), 'transfer')) : null,
  line('bed', patient ? (showP ? t('bed.occupiedBy', { alias: patient.alias, ref: kase?.ref ?? '' }) : t('bed.occupiedHidden')) : t('bed.vacant')),
  line('nurse', nurse ? t('bed.nurse', { name: userName(nurse.nurseUserId) }) : t('bed.noNurse')),
  line('broom', t('bed.cleaning', { status: t(`cleaning.${b.cleaning.status}`) })),
  icu ? h('span', { class: 'indicators' },
    b.capabilities.isolation ? h('span', { class: 'chip', text: t('req.isolation') }) : null,
    b.capabilities.ventilator ? h('span', { class: 'chip', text: t('req.ventilator') }) : null,
    h('span', { class: 'chip' }, icon(monitorOk ? 'check' : 'alert', { size: 12 }), t(monitorOk ? 'bed.monitorOk' : 'bed.monitorNeeded'))) : null,
  tickets.length ? h('span', { class: 'indicators' }, tickets.map((x) => pill('blocked', x.kind === 'technical'
    ? t('bed.technicalFault', { ref: x.ref }) : t('bed.equipmentFault', { equipment: t(`equipment.${x.equipmentType}`), ref: x.ref }), x.kind === 'technical' ? 'wrench' : 'monitor'))) : null,
  res ? line('lock', res.expiresAt ? t('bed.reservedFor', { ref: s.cases[res.caseId]?.ref, time: formatTime(res.expiresAt) }) : t('bed.heldTransport', { ref: s.cases[res.caseId]?.ref })) : null,
  line('clock', t('bed.inState', { dur: formatDuration(st.since, n) }), 'muted'),
  st.forecast ? forecastLine(st.forecast, 'span') : null);
}

/** Count tiles that filter the board below. `keys`: tile keys; `labelKey(k)`: i18n key; `filterProp`: ctx.ui field. */
export function tileGrid({ keys, dash, filterProp, labelKey, icons, tones, ariaLabel }) {
  const filter = ctx.ui[filterProp];
  return h('div', { class: 'tiles', role: 'group', 'aria-label': ariaLabel }, keys.map((key) => {
    const c = dash[key].count;
    const label = t(labelKey(key));
    return h('button', {
      type: 'button', class: ['tile', c > 0 && tones[key]], 'aria-pressed': String(filter === key), 'data-focus-key': `tile:${key}`,
      'aria-label': `${label}: ${c}`, onclick: () => { ctx.ui[filterProp] = filter === key ? null : key; requestRender(); },
    }, h('span', { class: 'top' }, icon(icons[key], { size: 18 }), h('span', { class: 'num', text: String(c) })), h('span', { class: 'label', text: label }));
  }));
}

// Transfers between departure and placement, shown on BOTH boards: the patient is in no bed while in transit.
export function inTransitPanel(s, hospitalId, n) {
  const list = values(s, 'transferRequests').filter((tr) => tr.hospitalId === hospitalId && ['in_transit', 'arrived'].includes(tr.status));
  if (!list.length) return null;
  return panel(t('transit.title'), 'transfer', list.length, h('ul', { class: 'rows' }, list.map((tr) => {
    const c = s.cases[tr.caseId];
    const who = canSeePatient(hospitalId) ? s.patients[tr.patientId].alias : t('common.dash');
    return h('li', { class: 'row' }, icon('transfer'),
      h('div', { class: 'grow' },
        h('strong', { text: t('transit.row', { ref: c.ref, patient: who, from: s.beds[tr.fromBedId]?.label ?? t('dept.ER'), to: s.beds[tr.targetBedId]?.label ?? '' }) }),
        h('span', {}, pill('pending', tm(deriveTransferStatus(tr, s, n).label), 'transfer'), ' ',
          h('span', { class: 'small muted', text: tr.porterUserId ? t('transit.porter', { name: userName(tr.porterUserId) }) : t('transit.noPorter') }))),
      uiButton(t('action.openTransfer'), openDrawer('transfer', tr.id), { small: true, 'data-focus-key': `open:transfer:${tr.id}` }));
  })));
}
