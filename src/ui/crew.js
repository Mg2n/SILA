// Ambulance crew screens (SPEC §5). Mobile-first (360px) and one-handed: large buttons, few taps.
// Home → handover form (draft autosaved on this device) → preview exactly as the ER will see it → send →
// live case view. Every change goes through dispatch(); disabled buttons show the engine's reason.
// Nothing here interprets vital signs, suggests treatment or derives triage.

import { DISTRICTS } from '../config.js';
import { values } from '../data.js';
import { extractIntake } from '../extract.js';
import { VITAL_TYPES, VITAL_TYPE_KEYS, vitalProblem } from '../vitals.js';
import { notificationsFor } from '../readiness.js';
import { publicHospitals, rankHospitals, crewCases, crewCaseView, unitMembers } from '../selectors.js';
import { t, tm, getLocale, formatTime, formatRelative, localizeData } from '../i18n.js';
import { h, append, nextUid } from './dom.js';
import { icon, ambulanceIllustration, ambulanceCardIllustration } from './icons.js';
import { state, now, currentUser, isCrew, setCurrentUser, requestRender, run, check, seenVersion, openDialog, field, toast } from './core.js';
import { pill, emptyState, actionButton, userName } from './components.js';
import { voicePanel, stopVoice } from './voice.js';
import { cityMap } from './citymap.js';
import { hospitalItem } from './citizen.js';
import { handoverCard, vitalsTable, vitalLabel, INTERVENTION_CHIPS, REQUIREMENT_KEYS, crewAcuityText } from './handover.js';
import { crewDraftFields, DEMO_CREW_REF } from '../demo-script.js';

const DEMO_CREW_USER = 'u-para-1';

const go = (route) => { location.hash = `#/${route}`; };
const lang = () => (getLocale() === 'ar' ? 'ar' : 'en');
const ACUITY = ['critical', 'high', 'moderate', 'low'];
const PROGRESS = ['submitted', 'acknowledged', 'en_route', 'arrived', 'handover_complete'];
const MIN = 60000;
const note = (text, kind = '', iconName = null) => h('p', { class: ['notice', kind] }, icon(iconName ?? (kind ? 'alert' : 'info'), { size: 18 }), h('span', { text }));
const req = () => [h('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }), h('span', { class: 'sr-only', text: ` (${t('dialog.required')})` })];

// Local "HH:MM" for <input type="time">, and back to an ISO time today (or yesterday, for a reading taken before midnight).
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function fromHhmm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v ?? '');
  if (!m) return null;
  const d = new Date(now());
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() > Date.parse(now()) + 5 * MIN) d.setDate(d.getDate() - 1);
  return d.toISOString();
}

// ---------- Draft: autosaved on this device, one per unit for a new case and one per case being updated ----------
const DRAFT_PREFIX = 'sila.crewDraft';
const draftKey = (u, caseId) => `${DRAFT_PREFIX}.${u.ambulanceId}.${caseId ?? 'new'}`;
const blankEntry = () => ({ type: 'HR', value: '', systolic: '', diastolic: '', time: hhmm(now()), error: null });
const blankDraft = () => ({
  clientRef: `crew-${Math.random().toString(36).slice(2, 10)}`, approxAge: '', sex: '', concern: '', history: '', allergies: '',
  vitals: [], entry: blankEntry(), crewAcuity: '', chips: [], interventionsText: '', requirements: { isolation: false, ventilator: false, monitor: false },
  receivingRequirements: '', patientCount: '1', districtId: DISTRICTS[0].id, destinationHospitalId: null, etaMinutes: '', crewNotes: '',
  suggestions: null, accepted: [], savedAt: null,
});
// An update starts from what was sent; readings already sent are shown from the case, the draft holds only new ones.
function draftFromCase(s, c) {
  const n = s.arrivalNotices[c.noticeId];
  const ho = n?.handover ?? {};
  const p = s.patients[c.patientId];
  const ints = ho.interventions ?? [];
  return {
    ...blankDraft(), clientRef: n?.clientRef ?? null, approxAge: p?.approxAge != null ? String(p.approxAge) : '', sex: p?.sex ?? '',
    concern: n?.reported?.concern ?? c.reportedConcern ?? '', history: ho.history ?? '', allergies: ho.allergies ?? '', crewAcuity: c.crewAcuity?.level ?? '',
    chips: ints.filter((x) => INTERVENTION_CHIPS.includes(x)), interventionsText: ints.filter((x) => !INTERVENTION_CHIPS.includes(x)).join('; '),
    requirements: Object.fromEntries(REQUIREMENT_KEYS.map((k) => [k, !!c.requirements?.[k]])), receivingRequirements: ho.receivingRequirements ?? '',
    patientCount: String(n?.reported?.patientCount ?? 1), crewNotes: ho.crewNotes ?? '',
  };
}
const cache = new Map();
function loadDraft(u, caseId) {
  const key = draftKey(u, caseId);
  if (!cache.has(key)) {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { /* storage blocked */ }
    const base = caseId ? draftFromCase(state(), state().cases[caseId]) : blankDraft();
    cache.set(key, stored ? { ...base, ...stored, entry: { ...blankEntry(), ...stored.entry } } : base);
  }
  return cache.get(key);
}
function hasDraft(u, caseId) {
  try { return localStorage.getItem(draftKey(u, caseId)) !== null; } catch { return cache.has(draftKey(u, caseId)); }
}
function saveDraft(u, caseId, patch) {
  const d = Object.assign(loadDraft(u, caseId), patch, { savedAt: now() });
  try { localStorage.setItem(draftKey(u, caseId), JSON.stringify(d)); } catch { /* storage blocked: kept for this tab only */ }
  return d;
}
function discardDraft(u, caseId) {
  cache.delete(draftKey(u, caseId));
  try { localStorage.removeItem(draftKey(u, caseId)); } catch { /* storage blocked */ }
}

// ---------- Draft → engine payload ----------
const text = (v) => (v !== null && v !== undefined && String(v).trim() ? String(v).trim() : null);
const ageValue = (v) => (text(v) === null ? null : /^\d+$/.test(text(v)) ? Number(text(v)) : text(v)); // anything else is rejected by the engine
const interventionsOf = (d) => [...d.chips, ...(text(d.interventionsText) ? [text(d.interventionsText)] : [])];
const pointOf = (d) => { const x = DISTRICTS.find((dd) => dd.id === d.districtId) ?? DISTRICTS[0]; return { x: x.x, y: x.y }; };
const rankedFor = (s, d) => rankHospitals(publicHospitals(s, now()), pointOf(d), 'ambulance');
const etaMinutes = (d, hosp) => (/^\d+$/.test(text(d.etaMinutes) ?? '') ? Number(d.etaMinutes) : hosp?.trip?.minutes ?? null);
const draftReadings = (u, d) => d.vitals.map((r) => ({ ...r, unit: VITAL_TYPES[r.type].unit, enteredBy: u.id }));

function payloadFrom(d, caseId, hosp) {
  const base = {
    approxAge: ageValue(d.approxAge), sex: d.sex || null, concern: text(d.concern), history: text(d.history), allergies: text(d.allergies),
    crewNotes: text(d.crewNotes), receivingRequirements: text(d.receivingRequirements), patientCount: Number(d.patientCount) || 1,
    interventions: interventionsOf(d), crewAcuity: d.crewAcuity || null, requirements: { ...d.requirements },
    vitals: d.vitals.map(({ type, value, takenAt }) => ({ type, value, takenAt })),
  };
  if (caseId) return { caseId, ...base };
  const minutes = etaMinutes(d, hosp);
  return { ...base, destinationHospitalId: d.destinationHospitalId, clientRef: d.clientRef, origin: pointOf(d),
    etaAt: minutes === null ? null : new Date(Date.parse(now()) + minutes * MIN).toISOString() };
}

// ---------- Sign-in (simulated): pick a crew member; the unit decides which cases are visible ----------
function renderSignIn(main) {
  const s = state();
  const units = [...new Set(values(s, 'users').filter(isCrew).map((u) => u.ambulanceId))].sort();
  append(main, [
    h('section', { class: 'hero' }, ambulanceCardIllustration(), h('h1', { text: t('crew.signInTitle') }), h('p', { class: 'lead', text: t('crew.signInBody') })),
    units.map((unit) => h('section', { class: 'panel', 'aria-labelledby': `unit-${unit}` },
      h('h2', { id: `unit-${unit}`, text: t('crew.unit', { id: unit }) }),
      h('div', { class: 'rows' }, unitMembers(s, unit).map((m) => h('button', { type: 'button', class: 'btn big', 'data-focus-key': `signin:${m.id}`,
        onclick: () => { setCurrentUser(m.id); go('crew'); } }, icon('ambulance', { size: 20 }), t('crew.signInAs', { name: m.name })))))),
  ]);
}

const withCrew = (render) => (main, param) => {
  const u = currentUser();
  if (!isCrew(u)) { renderSignIn(main); return; }
  render(main, u, param);
};

// ---------- Home ----------
const statusPill = (st) => pill(st === 'canceled' ? 'blocked' : ['arrived', 'handover_complete', 'closed'].includes(st) ? 'ready' : st === 'submitted' ? 'pending' : 'reserved',
  t(`crewStatus.${st}`), st === 'canceled' ? 'alert' : st === 'submitted' ? 'clock' : 'check');
const isLive = (c, n) => c.status === 'active' && !['handover_complete', 'closed', 'canceled'].includes(n?.status);

export const renderCrewHome = withCrew((main, u) => {
  const s = state();
  const n = now();
  const cases = crewCases(s, u);
  const current = cases.find((c) => isLive(c, s.arrivalNotices[c.noticeId]));
  const notes = notificationsFor(s, u);
  const draftHere = hasDraft(u, null);
  append(main, [
    h('section', { class: 'panel unit-card' },
      ambulanceIllustration(),
      h('div', {},
        h('h1', { text: t('crew.unit', { id: u.ambulanceId }) }),
        h('p', { text: t('crew.crewNames', { names: unitMembers(s, u.ambulanceId).map((m) => localizeData(m.name)) }) }),
        h('p', { class: 'small muted', text: t('crew.signedInAs', { name: u.name }) }))),
    h('section', { class: 'panel', 'aria-labelledby': 'crew-current' },
      h('h2', { id: 'crew-current', text: t('crew.currentStatus') }),
      current ? h('a', { class: 'notice-card', href: `#/crew/case/${current.id}`, 'data-focus-key': `current:${current.id}` },
        h('span', { class: 'hospital-head' }, h('strong', { class: 'ref', text: current.ref }), statusPill(s.arrivalNotices[current.noticeId].status)),
        h('span', { text: s.hospitals[current.destinationHospitalId].name })) : h('p', { class: 'muted', text: t('crew.noActive') })),
    h('div', { class: 'step-actions' },
      h('a', { class: 'btn big primary', href: '#/crew/new', 'data-focus-key': 'crew-new' }, icon(draftHere ? 'comment' : 'ambulance', { size: 20 }), draftHere ? t('crew.resumeDraft') : t('crew.newCase')),
      draftHere ? h('button', { type: 'button', class: 'btn big', 'data-focus-key': 'crew-discard', onclick: () => confirmDiscard(u, null) }, t('crew.discardDraft')) : null),
    h('section', { class: 'panel', 'aria-labelledby': 'crew-notes' },
      h('h2', { id: 'crew-notes', text: t('crew.notifications') }),
      notes.length ? h('ul', { class: 'rows' }, notes.slice(0, 8).map((nt) => notifRow(s, u, nt, n))) : h('p', { class: 'muted', text: t('crew.noNotifications') })),
    h('section', { class: 'panel', 'aria-labelledby': 'crew-cases' },
      h('h2', { id: 'crew-cases', text: t('crew.cases') }),
      cases.length ? h('ul', { class: 'rows' }, cases.map((c) => caseRow(s, c, n))) : h('p', { class: 'muted', text: t('crew.noCases') })),
  ]);
});

function caseOfRef(s, ref) {
  if (!ref) return null;
  if (ref.entity === 'case') return ref.id;
  if (ref.entity === 'comment') return s.comments[ref.id]?.caseId ?? null;
  return null;
}
function notifRow(s, u, nt, n) {
  const unread = !nt.readBy.includes(u.id);
  const caseId = caseOfRef(s, nt.ref);
  return h('li', {}, h('button', { type: 'button', class: ['notif-item', unread && 'unread'], 'data-focus-key': `crew-notif:${nt.id}`,
    onclick: () => {
      if (unread) run('markNotificationRead', { notificationId: nt.id }, { seen: seenVersion('markNotificationRead', { notificationId: nt.id }), silent: true });
      if (caseId) go(`crew/case/${caseId}`);
    } },
  icon(nt.type === 'clarification' ? 'comment' : 'bell', { size: 18 }),
  h('span', { class: 'grow' },
    h('span', { class: 'meta' }, unread ? pill('reserved', t('notif.unread'), 'spark') : null, h('time', { datetime: nt.createdAt, text: formatRelative(nt.createdAt, n) })),
    h('span', { text: tm(nt.message) }))));
}
function caseRow(s, c, n) {
  const nt = s.arrivalNotices[c.noticeId];
  const open = values(s, 'comments').some((cm) => cm.caseId === c.id && cm.kind === 'clarification' && cm.status === 'open');
  return h('li', {}, h('a', { class: 'notice-card', href: `#/crew/case/${c.id}`, 'data-focus-key': `crew-case:${c.id}`, 'aria-label': t('notices.open', { ref: c.ref }) },
    h('span', { class: 'hospital-head' }, h('strong', { class: 'ref', text: c.ref }), statusPill(c.status === 'canceled' ? 'canceled' : nt?.status ?? 'submitted'),
      open ? pill('pending', t('incoming.clarificationOpen'), 'comment') : null),
    h('span', { text: s.hospitals[c.destinationHospitalId].name }),
    h('span', { class: 'small muted', text: `${t('case.eta')}: ${nt?.etaAt ? `${formatTime(nt.etaAt)} (${formatRelative(nt.etaAt, n)})` : t('common.unknown')}` }),
    h('span', { class: 'small', dir: 'auto', text: c.reportedConcern ?? '' })));
}

function confirmDiscard(u, caseId) {
  openDialog({ title: t('crew.discardTitle'), intro: h('p', { text: t('crew.discardBody') }), fields: () => [], submitLabel: t('crew.discardDraft'), danger: true,
    onSubmit: () => { stopVoice(); discardDraft(u, caseId); requestRender(); if (location.hash !== '#/crew') go(caseId ? `crew/case/${caseId}` : 'crew'); } });
}

// ---------- New / update form ----------
let jumpTo = null; // section to scroll to after "Edit" in the preview

const editable = (view) => view.case.status === 'active' && view.patient.location.kind === 'pre_hospital';

export const renderCrewForm = withCrew((main, u, caseId = null) => {
  const s = state();
  const view = caseId ? crewCaseView(s, caseId, u) : null;
  if (caseId && !view) { notFound(main); return; }
  if (view && !editable(view)) {
    append(main, [note(t('crew.cannotEdit', { ref: view.case.ref }), 'warn'), h('a', { class: 'btn big', href: `#/crew/case/${caseId}` }, t('common.back'))]);
    return;
  }
  const d = loadDraft(u, caseId);
  const set = (patch, rerender = false) => { saveDraft(u, caseId, patch); if (rerender) requestRender(); };
  const sent = view?.notice.handover?.vitals ?? [];

  append(main, [
    h('h1', { text: caseId ? t('crew.formEdit', { ref: view.case.ref }) : t('crew.formNew') }),
    h('p', { class: 'small muted', role: 'status', text: d.savedAt ? t('crew.draftSaved', { time: formatTime(d.savedAt) }) : t('crew.draftLocal') }),
    section('notes', t('crew.section.notes'), notesSection(u, caseId, d, set)),
    section('patient', t('crew.section.patient'),
      textField({ key: 'approxAge', label: t('crew.age'), d, set, inputmode: 'numeric', hint: t('crew.ageHint') }),
      selectField({ key: 'sex', label: t('crew.sex'), d, set, options: [['', t('sex.unknown')], ['female', t('sex.female')], ['male', t('sex.male')]] }),
      selectField({ key: 'patientCount', label: t('crew.patientCount'), d, set, options: Array.from({ length: 10 }, (_, i) => [String(i + 1), String(i + 1)]) })),
    section('concern', t('crew.section.concern'), textField({ key: 'concern', label: t('crew.concern'), d, set, multiline: true, required: true, onEmptyChange: true })),
    section('history', t('crew.section.history'),
      textField({ key: 'history', label: t('crew.history'), d, set }),
      textField({ key: 'allergies', label: t('crew.allergies'), d, set })),
    section('vitals', t('crew.section.vitals'), vitalsSection(u, caseId, d, sent, set)),
    section('acuity', t('crew.section.acuity'), acuitySection(d, set)),
    section('interventions', t('crew.section.interventions'), interventionsSection(d, set)),
    section('requirements', t('crew.section.requirements'), requirementsSection(d, set)),
    section('destination', t('crew.section.destination'), view ? destinationFixed(view) : destinationSection(s, d, set)),
    h('div', { class: 'sticky-actions' },
      h('a', { class: 'btn big', href: caseId ? `#/crew/case/${caseId}` : '#/crew' }, t('common.back')),
      h('a', { class: 'btn big primary', href: caseId ? `#/crew/preview/${caseId}` : '#/crew/preview', 'data-focus-key': 'crew-preview',
        onclick: () => stopVoice() }, t('crew.preview'))),
    h('button', { type: 'button', class: 'btn big danger-outline', 'data-focus-key': 'crew-discard-form', onclick: () => confirmDiscard(u, caseId) }, t('crew.discardDraft')),
  ]);
  if (jumpTo) {
    const id = `sec-${jumpTo}`;
    jumpTo = null;
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      el?.scrollIntoView({ block: 'start' });
      (el?.querySelector('input:not([type=hidden]), select, textarea, button') ?? el)?.focus({ preventScroll: true });
    });
  }
});

function notFound(main) {
  append(main, [h('h1', { text: t('crew.notFoundTitle') }), emptyState(t('crew.notFound'), 'lock'), h('a', { class: 'btn big', href: '#/crew' }, t('crew.backHome'))]);
}

function section(id, title, ...children) {
  return h('section', { class: 'panel crew-section', id: `sec-${id}`, 'aria-labelledby': `sec-${id}-h`, tabindex: -1 },
    h('h2', { id: `sec-${id}-h`, text: title }), ...children);
}

function textField({ key, label, d, set, multiline = false, hint = null, inputmode = null, required = false, onEmptyChange = false }) {
  const id = nextUid(`crew-${key}`);
  const hintId = hint ? `${id}-hint` : null;
  const attrs = {
    id, dir: 'auto', value: d[key] ?? '', required, inputmode, 'aria-describedby': hintId, 'data-preserve': `crew:${key}`, 'data-model-backed': '',
    oninput: (e) => {
      const was = !!text(d[key]);
      set({ [key]: e.target.value });
      if (onEmptyChange && was !== !!text(e.target.value)) requestRender();
    },
  };
  return h('div', { class: 'field' }, h('label', { for: id }, label, required ? req() : null),
    multiline ? h('textarea', { ...attrs, rows: 3 }) : h('input', { ...attrs, type: 'text' }),
    hint ? h('span', { class: 'hint', id: hintId, text: hint }) : null);
}

function selectField({ key, label, d, set, options }) {
  const id = nextUid(`crew-${key}`);
  return h('div', { class: 'field' }, h('label', { for: id, text: label }),
    h('select', { id, 'data-focus-key': `crew-select:${key}`, onchange: (e) => set({ [key]: e.target.value }, true) },
      options.map(([v, l]) => h('option', { value: v, selected: String(d[key] ?? '') === v, text: l }))));
}

// Voice note → "Crew notes". Optional demo extraction SUGGESTS fields; the crew accepts each one. Never vitals.
const SUGGEST = [
  { from: 'age', to: 'approxAge', label: 'crew.age', convert: (v) => v.match(/\d{1,3}/)?.[0] ?? null },
  { from: 'concern', to: 'concern', label: 'crew.concern' },
  { from: 'conditions', to: 'history', label: 'crew.history' },
  { from: 'allergies', to: 'allergies', label: 'crew.allergies' },
  { from: 'patientCount', to: 'patientCount', label: 'crew.patientCount', convert: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 10 ? v : null) },
];
function notesSection(u, caseId, d, set) {
  const id = nextUid('crew-notes');
  const suggest = () => {
    const notes = text(loadDraft(u, caseId).crewNotes) ?? '';
    const r = extractIntake(notes, /[؀-ۿ]/.test(notes) ? 'ar' : lang());
    const list = SUGGEST.map((m) => {
      const raw = r.fields[m.from];
      const value = raw && raw !== 'unknown' ? (m.convert ? m.convert(String(raw)) : String(raw)) : null;
      return value ? { key: m.to, label: m.label, value, phrase: r.matches[m.from] ?? null } : null;
    }).filter(Boolean);
    set({ suggestions: list, accepted: [] }, true);
  };
  return [
    voicePanel({ key: `crew:${caseId ?? 'new'}`, lang: lang() === 'ar' ? 'ar-SA' : 'en-US', label: t('crew.section.notes'), rerender: requestRender,
      onFinal: (said) => set({ crewNotes: `${loadDraft(u, caseId).crewNotes} ${said}`.trim() }) }),
    h('div', { class: 'field' },
      h('label', { for: id, text: t('crew.notesLabel') }),
      h('textarea', { id, rows: 4, dir: 'auto', value: d.crewNotes, 'data-preserve': 'crew:crewNotes', 'data-model-backed': '', 'aria-describedby': `${id}-hint`,
        oninput: (e) => set({ crewNotes: e.target.value }) }),
      h('span', { class: 'hint', id: `${id}-hint`, text: t('crew.notesHint') })),
    h('button', { type: 'button', class: 'btn big', 'data-focus-key': 'crew-suggest', onclick: suggest }, icon('spark', { size: 20 }), t('crew.suggest')),
    d.suggestions ? h('div', { class: 'suggestions', role: 'region', 'aria-label': t('crew.suggestions') },
      h('p', { class: 'small' }, h('span', { class: 'est-tag', text: t('extraction.demo-rule-based') }), t('crew.suggestions')),
      d.suggestions.length ? h('ul', { class: 'rows' }, d.suggestions.map((sg) => {
        const done = d.accepted.includes(sg.key);
        return h('li', { class: 'suggestion' },
          h('span', { class: 'grow' }, h('strong', { text: `${t(sg.label)}: ` }), h('span', { dir: 'auto', text: sg.value }),
            sg.phrase ? h('span', { class: 'small muted', dir: 'auto', text: ` — ${t('review.from', { phrase: sg.phrase })}` }) : null),
          done ? pill('ready', t('crew.accepted'), 'check')
            : h('button', { type: 'button', class: 'btn primary', 'data-focus-key': `accept:${sg.key}`, 'aria-label': `${t('crew.accept')} — ${t(sg.label)}: ${sg.value}`,
              onclick: () => set({ [sg.key]: sg.value, accepted: [...loadDraft(u, caseId).accepted, sg.key] }, true) }, t('crew.accept')));
      })) : h('p', { class: 'small muted', text: t('crew.noSuggestions') })) : null,
    note(t('crew.neverVitals'), '', 'info'),
  ];
}

function vitalsSection(u, caseId, d, sent, set) {
  const e = d.entry;
  const def = VITAL_TYPES[e.type];
  const ids = { type: nextUid('vt-type'), value: nextUid('vt-value'), sys: nextUid('vt-sys'), dia: nextUid('vt-dia'), time: nextUid('vt-time'), err: nextUid('vt-err') };
  const setEntry = (patch, rerender = false) => set({ entry: { ...loadDraft(u, caseId).entry, ...patch } }, rerender);
  const add = () => {
    const cur = loadDraft(u, caseId).entry;
    const reading = { type: cur.type, value: cur.type === 'BP' ? { systolic: cur.systolic, diastolic: cur.diastolic } : cur.value, takenAt: fromHhmm(cur.time) };
    const problem = vitalProblem(reading, now()); // the engine's own validation: format and physically possible range only
    if (problem) {
      setEntry({ error: problem }, true);
      requestAnimationFrame(() => document.querySelector('[data-preserve="crew:vt-value"], [data-preserve="crew:vt-sys"]')?.focus());
      return;
    }
    set({ vitals: [...loadDraft(u, caseId).vitals, { ...reading, localId: `r-${Date.now().toString(36)}` }], entry: { ...blankEntry(), type: cur.type } }, true);
    toast(t('crew.readingAdded'), 'success', 2500);
  };
  const remove = (localId) => set({ vitals: loadDraft(u, caseId).vitals.filter((r) => r.localId !== localId) }, true);
  const numberInput = (id, key, label) => h('div', { class: 'field' }, h('label', { for: id, text: label }),
    h('span', { class: 'with-unit' },
      h('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', value: e[key], 'data-preserve': `crew:vt-${key === 'value' ? 'value' : key === 'systolic' ? 'sys' : 'dia'}`, 'data-model-backed': '',
        'aria-invalid': e.error ? 'true' : null, 'aria-describedby': e.error ? ids.err : null, oninput: (ev) => setEntry({ [key]: ev.target.value, error: null }),
        onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } } }),
      def.unit ? h('span', { class: 'unit', dir: 'ltr', text: def.unit }) : null));
  const all = [...sent, ...draftReadings(u, d)];
  return [
    h('div', { class: 'vital-entry' },
      h('div', { class: 'field' }, h('label', { for: ids.type, text: t('crew.vitalType') }),
        h('select', { id: ids.type, 'data-focus-key': 'vt-type', onchange: (ev) => setEntry({ type: ev.target.value, value: '', systolic: '', diastolic: '', error: null }, true) },
          VITAL_TYPE_KEYS.map((k) => h('option', { value: k, selected: k === e.type, text: `${vitalLabel(k)}${VITAL_TYPES[k].unit ? ` (${VITAL_TYPES[k].unit})` : ''}` })))),
      e.type === 'BP'
        ? h('div', { class: 'pair' }, numberInput(ids.sys, 'systolic', t('crew.systolic')), numberInput(ids.dia, 'diastolic', t('crew.diastolic')))
        : numberInput(ids.value, 'value', t('crew.vitalValue')),
      h('div', { class: 'field' }, h('label', { for: ids.time, text: t('crew.vitalTime') }),
        h('input', { id: ids.time, type: 'time', value: e.time, 'data-preserve': 'crew:vt-time', 'data-model-backed': '', oninput: (ev) => setEntry({ time: ev.target.value, error: null }) })),
      e.error ? h('p', { class: 'form-error', id: ids.err, role: 'alert', text: tm(e.error) }) : null,
      h('button', { type: 'button', class: 'btn big primary', 'data-focus-key': 'vt-add', onclick: add }, icon('check', { size: 20 }), t('crew.addReading'))),
    h('h3', { class: 'small muted', text: t('crew.readings') }),
    vitalsTable(all, { extraHead: h('span', { class: 'sr-only', text: t('crew.readingState') }), extra: (r) => (r.localId
      ? [pill('pending', t('crew.newReading'), 'spark'), h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': t('crew.removeReading', { type: vitalLabel(r.type), time: formatTime(r.takenAt) }),
        'data-focus-key': `vt-remove:${r.localId}`, onclick: () => remove(r.localId) }, icon('close', { size: 16 }))]
      : pill('ready', t('crew.sentReading'), 'check')) }),
  ];
}

function acuitySection(d, set) {
  const name = nextUid('acuity');
  const opt = (value, label) => h('label', { class: ['seg-option', d.crewAcuity === value && 'on'] },
    h('input', { type: 'radio', name, value, checked: d.crewAcuity === value, 'data-focus-key': `acuity:${value || 'none'}`, onchange: () => set({ crewAcuity: value }, true) }),
    h('span', { text: label }));
  return [
    h('fieldset', { class: 'seg' }, h('legend', { class: 'sr-only', text: t('crew.section.acuity') }),
      ACUITY.map((a) => opt(a, t(`acuity.${a}`))), opt('', t('acuity.none'))),
    h('p', { class: 'small muted', text: t('crew.acuityHint') }),
  ];
}

function interventionsSection(d, set) {
  const id = nextUid('crew-int');
  return [
    h('p', { class: 'small muted', text: t('crew.interventionsHint') }),
    h('div', { class: 'chip-toggles', role: 'group', 'aria-label': t('crew.section.interventions') }, INTERVENTION_CHIPS.map((c) => {
      const on = d.chips.includes(c);
      return h('button', { type: 'button', class: ['chip-toggle', on && 'on'], 'aria-pressed': String(on), 'data-focus-key': `chip:${c}`,
        onclick: () => set({ chips: on ? d.chips.filter((x) => x !== c) : [...d.chips, c] }, true) }, on ? icon('check', { size: 16 }) : null, t(`intervention.${c}`));
    })),
    h('div', { class: 'field' }, h('label', { for: id, text: t('crew.interventionsText') }),
      h('textarea', { id, rows: 2, dir: 'auto', value: d.interventionsText, 'data-preserve': 'crew:interventionsText', 'data-model-backed': '',
        oninput: (e) => set({ interventionsText: e.target.value }) })),
  ];
}

function requirementsSection(d, set) {
  const id = nextUid('crew-req');
  return [
    h('div', { class: 'rows' }, REQUIREMENT_KEYS.map((k) => {
      const cid = nextUid(`req-${k}`);
      return h('div', { class: 'confirm-row' },
        h('input', { type: 'checkbox', id: cid, checked: !!d.requirements[k], 'data-focus-key': `req:${k}`,
          onchange: (e) => set({ requirements: { ...d.requirements, [k]: e.target.checked } }, true) }),
        h('label', { for: cid, text: t(`req.${k}`) }));
    })),
    h('div', { class: 'field' }, h('label', { for: id, text: t('req.other') }),
      h('input', { id, type: 'text', dir: 'auto', value: d.receivingRequirements, 'data-preserve': 'crew:receivingRequirements', 'data-model-backed': '',
        oninput: (e) => set({ receivingRequirements: e.target.value }) })),
  ];
}

function destinationFixed(view) {
  return [h('p', {}, h('strong', { text: view.destination.name })), h('p', { class: 'small muted', text: t('crew.destinationFixed') })];
}

function destinationSection(s, d, set) {
  const n = now();
  const list = rankedFor(s, d);
  const selected = list.find((x) => x.id === d.destinationHospitalId) ?? null;
  const districtId = nextUid('crew-district');
  const etaId = nextUid('crew-eta');
  const select = (id) => set({ destinationHospitalId: id, etaMinutes: '' }, true);
  return [
    h('div', { class: 'field' }, h('label', { for: districtId, text: t('crew.location') }),
      h('select', { id: districtId, 'data-focus-key': 'crew-district', onchange: (e) => set({ districtId: e.target.value, etaMinutes: '' }, true) },
        DISTRICTS.map((x) => h('option', { value: x.id, selected: x.id === d.districtId, text: t(`district.${x.id}`) }))),
      h('span', { class: 'hint', text: t('crew.locationHint') })),
    h('div', { class: 'map-wrap' }, cityMap({ hospitals: list, point: pointOf(d), pointLabel: t('crew.ambulanceHere'), selectedId: d.destinationHospitalId, onSelect: select }),
      h('p', { class: 'small muted', text: `${t('city.name')} · ${t('hospitals.simulated')}` })),
    h('ul', { class: 'hospital-list', 'aria-label': t('crew.section.destination') }, list.map((x) => hospitalItem(x, x.id === d.destinationHospitalId, 'ambulance', select, n))),
    selected ? h('div', { class: 'field' }, h('label', { for: etaId, text: t('crew.eta') }),
      h('span', { class: 'with-unit' },
        h('input', { id: etaId, type: 'text', inputmode: 'numeric', value: d.etaMinutes || String(selected.trip.minutes), 'data-preserve': 'crew:eta', 'data-model-backed': '',
          'aria-describedby': `${etaId}-hint`, oninput: (e) => set({ etaMinutes: e.target.value }) }),
        h('span', { class: 'unit', text: t('crew.minutesUnit') })),
      h('span', { class: 'hint', id: `${etaId}-hint`, text: t('crew.etaHint') })) : h('p', { class: 'small muted', text: t('crew.missingDestination') }),
  ];
}

// ---------- Preview: the card exactly as the ER will see it ----------
export const renderCrewPreview = withCrew((main, u, caseId = null) => {
  const s = state();
  const n = now();
  const view = caseId ? crewCaseView(s, caseId, u) : null;
  if (caseId && !view) { notFound(main); return; }
  if (view && !editable(view)) { go(`crew/case/${caseId}`); return; }
  const d = loadDraft(u, caseId);
  const hosp = view ? null : rankedFor(s, d).find((x) => x.id === d.destinationHospitalId) ?? null;
  const payload = payloadFrom(d, caseId, hosp);
  const data = {
    ref: view?.case.ref ?? null, unitId: u.ambulanceId, destinationName: view ? view.destination.name : hosp?.name ?? '', etaAt: view ? view.notice.etaAt : payload.etaAt,
    approxAge: payload.approxAge, sex: payload.sex, patientCount: payload.patientCount, concern: payload.concern, history: payload.history, allergies: payload.allergies,
    vitals: [...(view?.notice.handover?.vitals ?? []), ...draftReadings(u, d)], crewAcuity: payload.crewAcuity ? { level: payload.crewAcuity, source: 'crew' } : null,
    interventions: payload.interventions, requirements: payload.requirements, receivingRequirements: payload.receivingRequirements, crewNotes: payload.crewNotes,
  };
  const why = !payload.concern ? t('crew.missingConcern') : !view && !hosp ? t('crew.missingDestination') : null;
  const verdict = why ? { ok: false } : check('submitArrival', payload);
  const reason = why ?? (verdict.ok ? null : t('common.whyDisabled', { reason: verdict.reason }));
  const seen = seenVersion('submitArrival', payload);
  const editRoute = caseId ? `crew/edit/${caseId}` : 'crew/new';
  append(main, [
    h('h1', { text: view ? t('crew.previewUpdate', { ref: view.case.ref }) : t('crew.previewTitle') }),
    h('p', { class: 'muted', text: t('crew.erSees') }),
    handoverCard(data, { now: n, onEdit: (sec) => { jumpTo = sec; go(editRoute); } }),
    h('div', { class: 'sticky-actions' },
      h('a', { class: 'btn big', href: `#/${editRoute}` }, t('crew.edit')),
      h('button', { type: 'button', class: 'btn big primary', disabled: !!reason, 'aria-describedby': reason ? 'send-why' : null, 'data-focus-key': 'crew-send',
        onclick: () => send(u, caseId, payload, seen) }, icon('check', { size: 20 }), view ? t('crew.sendUpdate') : t('crew.send'))),
    reason ? h('p', { class: 'small muted', id: 'send-why', text: reason }) : null,
  ]);
});

function send(u, caseId, payload, seen) {
  const res = run('submitArrival', payload, { seen, silent: true });
  if (!res.ok) return res;
  stopVoice();
  discardDraft(u, caseId);
  toast(t(caseId ? 'crew.updateSent' : 'crew.sent'), 'success');
  go(`crew/case/${res.result.caseId}`);
  return res;
}

// ---------- Guided demo hooks: fill the device draft as a crew would, then use the preview's own send() ----------
export function demoCrew(kind) {
  const u = state().users[DEMO_CREW_USER];
  if (!hasDraft(u, null) || loadDraft(u, null).clientRef !== DEMO_CREW_REF) {
    const f = crewDraftFields(now());
    discardDraft(u, null);
    saveDraft(u, null, { ...f, clientRef: DEMO_CREW_REF, vitals: f.vitals.map((r, i) => ({ ...r, localId: `r-demo-${i}` })), entry: blankEntry() });
  }
  if (kind === 'crewPrepareDraft') return null;
  const s = state();
  const d = loadDraft(u, null);
  const hosp = rankedFor(s, d).find((x) => x.id === d.destinationHospitalId) ?? null;
  return send(u, null, payloadFrom(d, null, hosp), undefined);
}
export function discardDemoCrewDraft() {
  discardDraft(state().users[DEMO_CREW_USER], null);
}

// ---------- Case view after sending ----------
export const renderCrewCase = withCrew((main, u, caseId) => {
  const s = state();
  const n = now();
  const view = crewCaseView(s, caseId, u);
  if (!view) { notFound(main); return; }
  const { case: c, notice: nt } = view;
  const st = c.status === 'canceled' ? 'canceled' : nt.status;
  const live = isLive(c, nt);
  const preHospital = view.patient.location.kind === 'pre_hospital';
  append(main, [
    h('a', { class: 'btn', href: '#/crew' }, t('crew.backHome')),
    h('h1', { text: t('crew.caseTitle', { ref: c.ref }) }),
    h('section', { class: 'panel' },
      h('dl', { class: 'facts big-facts' },
        h('dt', { text: t('case.status') }), h('dd', {}, statusPill(st)),
        h('dt', { text: t('case.destination') }), h('dd', { text: view.destination.name }),
        h('dt', { text: t('case.eta') }), h('dd', {}, nt.etaAt ? `${formatTime(nt.etaAt)} (${formatRelative(nt.etaAt, n)}) · ${t('incoming.etaSimulated')}` : t('common.unknown'),
          nt.etaSource === 'simulated' ? [' ', h('span', { class: 'chip', text: t('eta.recalculated') })] : null),
        h('dt', { text: t('crew.section.acuity') }), h('dd', { text: crewAcuityText(c.crewAcuity) })),
      st === 'canceled' ? h('p', { class: 'small', text: t('case.canceledReason', { reason: c.cancelReason ?? '' }) }) : progress(st),
      routeStrip(view, n)),
    h('section', { class: 'panel', 'aria-labelledby': 'crew-ack' },
      h('h2', { id: 'crew-ack', text: t('crew.ack') }),
      view.acknowledged ? h('p', {}, icon('check', { size: 18 }), ' ', t('crew.ackBy', { time: formatTime(view.acknowledged.at), name: userName(view.acknowledged.by) }))
        : h('p', {}, pill('pending', t('crew.notAcked'), 'clock')),
      view.reservation ? h('p', { class: 'small', text: t('crew.reservation', { hospital: view.destination.name }) }) : null),
    clarificationThread(view),
    live && preHospital ? h('section', { class: 'panel crew-actions', 'aria-labelledby': 'crew-act' },
      h('h2', { id: 'crew-act', text: t('drawer.actions') }),
      ['submitted', 'acknowledged'].includes(nt.status) ? actionButton({ action: 'updateCrewStatus', payload: { caseId: c.id, status: 'en_route' }, label: t('crew.markEnRoute'), kind: 'primary', iconName: 'ambulance', big: true }) : null,
      nt.status === 'en_route' ? actionButton({ action: 'updateCrewStatus', payload: { caseId: c.id, status: 'arrived' }, label: t('crew.markArrived'), kind: 'primary', iconName: 'hospital', big: true }) : null,
      actionButton({ action: 'updateETA', payload: { caseId: c.id }, label: t('case.updateEta'), iconName: 'clock', big: true, open: (seen) => openEta(view, seen) }),
      h('a', { class: 'btn big', href: `#/crew/edit/${c.id}`, 'data-focus-key': 'crew-edit' }, icon('comment', { size: 20 }), hasDraft(u, c.id) ? t('crew.resumeUpdate') : t('crew.editResend')),
      actionButton({ action: 'changeDestination', payload: { caseId: c.id }, label: t('crew.changeDestination'), iconName: 'transfer', big: true, open: (seen) => openDestination(view, seen) }),
      actionButton({ action: 'cancelCase', payload: { caseId: c.id }, label: t('crew.cancel'), kind: 'danger', big: true, open: (seen) => openCancel(view, seen) })) : null,
    h('section', { class: 'panel' },
      h('h2', { text: t('case.timeline') }),
      h('ol', { class: 'timeline' }, [...nt.timeline].reverse().map((e) => h('li', {},
        h('time', { datetime: e.at, text: formatTime(e.at) }), h('span', { dir: 'auto', text: tm(e.detail) }))))),
  ]);
});

function progress(st) {
  const at = Math.max(0, PROGRESS.indexOf(st === 'closed' ? 'handover_complete' : st));
  return h('ol', { class: 'progress', 'aria-label': t('case.status') }, PROGRESS.map((x, i) => h('li', {
    class: [i < at && 'done', i === at && 'current'], 'aria-current': i === at ? 'step' : null,
  }, icon(i <= at ? 'check' : 'clock', { size: 16 }), t(`crewStatus.${x}`))));
}

// Simulated route strip: the marker moves from the scene toward the destination while en route (CSS animation over the
// time left to the ETA); with reduced motion it is drawn at its current position and does not move.
function routeStrip(view, n) {
  const nt = view.notice;
  const st = view.case.status === 'canceled' ? 'canceled' : nt.status;
  const start = nt.timeline.filter((e) => e.event === 'en_route').at(-1)?.at ?? nt.submittedAt;
  const end = nt.etaAt;
  let p = 0;
  if (['arrived', 'handover_complete', 'closed'].includes(st)) p = 1;
  else if (st === 'en_route' && end) p = Math.min(0.95, Math.max(0, (Date.parse(n) - Date.parse(start)) / Math.max(MIN, Date.parse(end) - Date.parse(start))));
  const remaining = st === 'en_route' && end ? Math.max(0, (Date.parse(end) - Date.parse(n)) / 1000) : 0;
  const moving = remaining > 0;
  return h('figure', { class: 'route-strip' },
    h('div', { class: 'track', style: `--p: ${p.toFixed(3)}; --dur: ${Math.round(remaining)}s`, 'aria-hidden': 'true' },
      h('span', { class: 'road' }),
      h('span', { class: 'end' }, icon('hospital', { size: 22 })),
      h('span', { class: ['amb', moving && 'moving'] }, ambulanceIllustration())),
    h('figcaption', { class: 'small muted' }, t('crew.route', { hospital: view.destination.shortName ?? view.destination.name }), ' ',
      h('span', { class: 'chip', text: t('hospitals.simulated') }), ' · ', t(`crewStatus.${st}`)));
}

function clarificationThread(view) {
  const list = view.clarifications;
  return h('section', { class: 'panel', 'aria-labelledby': 'crew-thread' },
    h('h2', { id: 'crew-thread', text: t('crew.thread') }),
    list.length ? h('ol', { class: 'rows thread' }, list.map((q) => h('li', { class: 'thread-item' },
      h('p', { class: 'small muted' }, h('time', { datetime: q.createdAt, text: formatTime(q.createdAt) }), ` · ${userName(q.authorId)}`),
      h('p', { class: 'question', dir: 'auto' }, icon('comment', { size: 16 }), ' ', q.body),
      q.status === 'answered'
        ? h('p', { class: 'answer', dir: 'auto' }, h('strong', { text: `${t('crew.yourReply')}: ` }), q.answer, h('span', { class: 'small muted', text: ` · ${userName(q.answeredBy)} ${formatTime(q.answeredAt)}` }))
        : replyBox(q)))) : h('p', { class: 'muted', text: t('crew.noThread') }));
}

function replyBox(q) {
  const id = nextUid('reply');
  const verdict = check('respondClarification', { commentId: q.id }, { permissionOnly: true });
  const submit = () => {
    const el = document.getElementById(id);
    const res = run('respondClarification', { commentId: q.id, answer: el?.value ?? '' }, { seen: q.version, silent: true });
    if (res.ok) toast(t('done.respondClarification'), 'success');
  };
  return h('div', { class: 'reply' },
    h('div', { class: 'field' }, h('label', { for: id, text: t('crew.replyLabel') }),
      h('textarea', { id, rows: 2, dir: 'auto', 'data-preserve': `reply:${q.id}`, disabled: !verdict.ok })),
    h('button', { type: 'button', class: 'btn big primary', disabled: !verdict.ok, 'data-focus-key': `reply-send:${q.id}`, onclick: submit }, t('case.reply')),
    verdict.ok ? null : h('p', { class: 'small muted', text: t('common.whyDisabled', { reason: verdict.reason }) }));
}

function openEta(view, seen) {
  openDialog({ title: t('eta.title', { ref: view.case.ref }), submitLabel: t('case.updateEta'),
    fields: () => [
      field({ label: t('eta.minutes'), name: 'minutes', type: 'select', required: true, value: '10',
        options: [2, 5, 10, 15, 20, 30, 45, 60].map((m) => ({ value: String(m), label: t('minutes.option', { n: m }) })) }),
      field({ label: t('eta.reason'), name: 'reason', type: 'text' }),
    ],
    onSubmit: (d) => run('updateETA', { caseId: view.case.id, etaAt: new Date(Date.parse(now()) + Number(d.minutes) * MIN).toISOString(), reason: d.reason || undefined },
      { seen, quiet: true }) });
}

function openDestination(view, seen) {
  const s = state();
  const others = values(s, 'hospitals').filter((x) => x.id !== view.case.destinationHospitalId);
  openDialog({ title: t('dest.title', { ref: view.case.ref }), submitLabel: t('crew.changeDestination'),
    intro: h('p', { class: 'notice warn' }, icon('info', { size: 18 }), h('span', { text: t('dest.notifyOld', { hospital: view.destination.name }) })),
    fields: () => [
      field({ label: t('dest.hospital'), name: 'toHospitalId', type: 'select', required: true, value: '',
        options: [{ value: '', label: t('dest.choose') }, ...others.map((x) => ({ value: x.id, label: x.name }))] }),
      field({ label: t('dest.reason'), name: 'reason', type: 'textarea', required: true, hint: t('common.reasonHint'), maxlength: 300 }),
      field({ label: t('dest.etaOverride'), name: 'minutes', type: 'text', hint: t('dest.etaOverrideHint') }),
    ],
    // Without an override the engine recalculates a simulated ETA to the new hospital.
    onSubmit: (d) => run('changeDestination', { caseId: view.case.id, toHospitalId: d.toHospitalId, reason: d.reason,
      ...(/^\d+$/.test(d.minutes ?? '') ? { etaAt: new Date(Date.parse(now()) + Number(d.minutes) * MIN).toISOString() } : {}) }, { seen, quiet: true }) });
}

function openCancel(view, seen) {
  openDialog({ title: t('cancelNotice.title', { ref: view.case.ref }), submitLabel: t('crew.cancel'), danger: true,
    fields: () => [field({ label: t('cancelNotice.reason'), name: 'reason', type: 'textarea', required: true, hint: t('common.reasonHint'), maxlength: 300 })],
    onSubmit: (d) => run('cancelCase', { caseId: view.case.id, reason: d.reason }, { seen, quiet: true }) });
}
