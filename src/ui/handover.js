// The structured ambulance handover exactly as the receiving ER reads it. Shared by the ER case drawer and the crew's
// preview, so the crew checks the very card the ER will see. Everything here is crew-reported and labelled as such;
// vital signs are shown as entered (value, unit, time) and are never interpreted, flagged or scored.

import { formatVitalValue } from '../vitals.js';
import { t, hasKey, formatTime, formatRelative } from '../i18n.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { pill, userName } from './components.js';

export const INTERVENTION_CHIPS = ['iv', 'oxygen', 'splint', 'collar', 'ecg', 'glucose'];
export const REQUIREMENT_KEYS = ['isolation', 'ventilator', 'monitor'];
export const interventionLabel = (x) => (INTERVENTION_CHIPS.includes(x) ? t(`intervention.${x}`) : x);
export const acuityLabel = (level) => (level ? t(`acuity.${level}`) : t('acuity.none'));
export const crewAcuityText = (a) => t('incoming.crewAcuity', { level: acuityLabel(a?.level) });
export const vitalLabel = (type) => t(`vital.${type}`);
export const vitalValueText = (r) => `${formatVitalValue(r)}${r.unit ? ` ${r.unit}` : ''}`;
const byTime = (a, b) => Date.parse(a.takenAt) - Date.parse(b.takenAt);

/** Readings in time order: measurement, value with unit, time, who entered it (+ an optional extra column). */
export function vitalsTable(readings, { extra = null, extraHead = null } = {}) {
  if (!readings.length) return h('p', { class: 'small muted', text: t('crew.noReadings') });
  return h('div', { class: 'table-wrap' }, h('table', { class: 'vitals' },
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col', text: t('vitals.type') }), h('th', { scope: 'col', text: t('vitals.value') }),
      h('th', { scope: 'col', text: t('vitals.time') }), h('th', { scope: 'col', text: t('vitals.by') }),
      extra ? h('th', { scope: 'col' }, extraHead ?? h('span', { class: 'sr-only', text: t('drawer.actions') })) : null)),
    h('tbody', {}, [...readings].sort(byTime).map((r) => h('tr', {},
      h('th', { scope: 'row', text: vitalLabel(r.type) }),
      h('td', { class: 'num', dir: 'ltr', text: vitalValueText(r) }),
      h('td', {}, h('time', { datetime: r.takenAt, text: formatTime(r.takenAt) })),
      h('td', { text: r.enteredBy ? userName(r.enteredBy) : '' }),
      extra ? h('td', {}, extra(r)) : null)))));
}

/** Everything the card shows, read from a case (ER side). The crew preview builds the same shape from its draft. */
export function handoverData(s, c) {
  const n = s.arrivalNotices[c.noticeId];
  const ho = n?.handover ?? {};
  const p = s.patients[c.patientId];
  const amb = c.ambulanceAssignmentId ? s.ambulanceAssignments[c.ambulanceAssignmentId] : null;
  return {
    ref: c.ref, unitId: amb?.ambulanceId ?? null, destinationName: s.hospitals[c.destinationHospitalId]?.name ?? '', etaAt: n?.etaAt ?? null,
    approxAge: p?.approxAge ?? null, sex: p?.sex ?? null, patientCount: n?.reported?.patientCount ?? 1, concern: n?.reported?.concern ?? c.reportedConcern,
    history: ho.history ?? null, allergies: ho.allergies ?? null, vitals: ho.vitals ?? [], crewAcuity: c.crewAcuity ?? null,
    interventions: ho.interventions ?? [], requirements: c.requirements ?? {}, receivingRequirements: ho.receivingRequirements ?? null,
    crewNotes: ho.crewNotes ?? null, updatedAt: n?.updatedAt ?? c.updatedAt,
  };
}

/** handoverCard(data, { onEdit(sectionId), now }) — with onEdit each section gets an Edit button (crew preview). */
export function handoverCard(d, { onEdit = null, now } = {}) {
  const val = (v) => (v === null || v === undefined || v === '' ? t('common.unknown') : String(v));
  const block = (id, title, iconName, ...body) => h('section', { class: 'ho-section', 'aria-label': title },
    h('div', { class: 'ho-head' }, h('h4', {}, icon(iconName, { size: 16 }), title),
      onEdit ? h('button', { type: 'button', class: 'btn small', 'data-focus-key': `edit:${id}`, 'aria-label': `${t('crew.edit')} — ${title}`, onclick: () => onEdit(id) }, t('crew.edit')) : null),
    ...body);
  const facts = (pairs) => h('dl', { class: 'facts' }, pairs.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { dir: 'auto', text: v })]));
  const reqs = REQUIREMENT_KEYS.filter((k) => d.requirements?.[k]);
  return h('article', { class: 'handover-card' },
    h('p', { class: 'notice warn ho-banner' }, icon('alert', { size: 18 }), h('strong', { text: t('crew.previewBanner') })),
    facts([
      [t('crew.unitLabel'), d.unitId ?? t('common.unknown')],
      [t('crew.section.destination'), val(d.destinationName)],
      [t('incoming.eta'), d.etaAt ? `${formatTime(d.etaAt)}${now ? ` (${formatRelative(d.etaAt, now)})` : ''} · ${t('incoming.etaSimulated')}` : t('incoming.etaUnknown')],
    ]),
    block('patient', t('crew.section.patient'), 'person', facts([
      [t('crew.age'), val(d.approxAge)], [t('crew.sexShort'), d.sex ? t(`sex.${d.sex}`) : t('sex.unknown')], [t('crew.patientCount'), val(d.patientCount)]])),
    block('concern', t('crew.section.concern'), 'comment', h('p', { dir: 'auto', text: val(d.concern) })),
    block('history', t('crew.section.history'), 'history', facts([[t('crew.history'), val(d.history)], [t('crew.allergies'), val(d.allergies)]])),
    block('vitals', t('drawer.vitals'), 'monitor', vitalsTable(d.vitals)),
    block('acuity', t('crew.section.acuity'), 'ambulance', h('p', {}, pill('neutral', crewAcuityText(d.crewAcuity), 'ambulance')),
      h('p', { class: 'small muted', text: t('crew.acuityHint') })),
    block('interventions', t('drawer.interventions'), 'stethoscope', d.interventions.length
      ? h('ul', { class: 'chip-list' }, d.interventions.map((x) => h('li', { class: 'chip', dir: 'auto', text: interventionLabel(x) })))
      : h('p', { class: 'small muted', text: t('common.none') })),
    block('requirements', t('drawer.requirements'), 'bed',
      reqs.length ? h('ul', { class: 'chip-list' }, reqs.map((k) => h('li', { class: 'chip' }, icon('check', { size: 14 }), t(`req.${k}`)))) : null,
      d.receivingRequirements ? h('p', { dir: 'auto', text: `${t('req.other')}: ${d.receivingRequirements}` }) : null,
      !reqs.length && !d.receivingRequirements ? h('p', { class: 'small muted', text: t('common.none') }) : null),
    block('notes', t('drawer.crewNotes'), 'mic', d.crewNotes ? h('blockquote', { class: 'transcript', dir: 'auto', text: d.crewNotes }) : h('p', { class: 'small muted', text: t('common.none') })));
}

/** One "What changed" line for a recorded update entry (engine change list). */
export function changeText(ch, vitals) {
  if (ch.field === 'vitals') {
    const r = vitals.find((v) => v.id === ch.readingId);
    return r ? t('change.vitals', { type: vitalLabel(r.type), value: formatVitalValue(r), unit: r.unit, time: formatTime(r.takenAt) })
      : t('change.vitals', { type: vitalLabel(ch.type), value: '', unit: '', time: '' });
  }
  const field = hasKey(`changeField.${ch.field}`) ? t(`changeField.${ch.field}`) : t('changeField.other');
  if (ch.field.startsWith('requirements.')) return t(ch.value ? 'change.reqOn' : 'change.reqOff', { field });
  if (ch.field === 'crewAcuity') return t('change.acuity', { level: acuityLabel(ch.level) });
  if (ch.field === 'etaAt') return t('change.eta', { time: formatTime(ch.value) });
  return t('change.field', { field });
}

/** The ER's "What changed" list: every update, newest first; updates after `seenRevision` are marked new. */
export function whatChanged(notice, seenRevision = Infinity) {
  const updates = [...(notice.updates ?? [])].reverse();
  if (!updates.length) return h('p', { class: 'small muted', text: t('drawer.noChanges') });
  const vitals = notice.handover?.vitals ?? [];
  return h('ol', { class: 'changes' }, updates.map((u) => h('li', { class: u.revision > seenRevision ? 'new' : null },
    h('p', { class: 'small' }, h('strong', { text: t('drawer.whatChanged', { n: u.revision, time: formatTime(u.at) }) }), ` · ${userName(u.by)}`,
      u.revision > seenRevision ? [' ', pill('pending', t('incoming.handoverUpdated'), 'spark')] : null),
    u.changes.length ? h('ul', { class: 'small' }, u.changes.map((ch) => h('li', { text: changeText(ch, vitals) }))) : h('p', { class: 'small muted', text: t('drawer.noChanges') }))));
}
