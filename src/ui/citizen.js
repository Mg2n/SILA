// Citizen journey (SPEC §4): welcome → start → describe (voice or typed) → review the demo extraction →
// choose a nearby hospital → send. Mobile-first. Sending is the only state change and goes through dispatch().

import { REGION, DISTRICTS } from '../config.js';
import { extractIntake } from '../extract.js';
import { pointFromGeo } from '../geo.js';
import { publicHospitals, rankHospitals, citizenCases } from '../selectors.js';
import { t, getLocale, formatRelative } from '../i18n.js';
import { h, append, nextUid } from './dom.js';
import { icon, citizenIllustration, ambulanceCardIllustration } from './icons.js';
import { state, now, requestRender, runCitizen, checkCitizen, deviceRef } from './core.js';
import { pill } from './components.js';
import { voicePanel, stopVoice } from './voice.js';
import { cityMap } from './citymap.js';
import { langToggle, demoButton } from './shell.js';

// ---------- Draft (this tab, survives reload) ----------
const DRAFT_KEY = 'sila.citizenDraft';
const newRef = () => `cit-${Math.random().toString(36).slice(2, 10)}`;
const blank = () => ({ transcript: '', fields: null, matches: {}, edited: [], reviewed: false, point: null, place: null, locationNote: null,
  hospitalId: null, clientRef: newRef() });
let cache = null;
export function draft() {
  if (!cache) {
    try { cache = { ...blank(), ...JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '{}') }; } catch { cache = blank(); }
  }
  return cache;
}
function save(patch) {
  Object.assign(draft(), patch);
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(cache)); } catch { /* storage blocked: keep in memory */ }
}
export function resetDraft() {
  cache = blank();
  save({});
}

const go = (route) => { location.hash = `#/${route}`; };
const lang = () => (getLocale() === 'ar' ? 'ar' : 'en');
const note = (text, kind = '', iconName = null) => h('p', { class: ['notice', kind], role: kind === 'danger' ? 'alert' : null },
  icon(iconName ?? (kind ? 'alert' : 'info'), { size: 18 }), h('span', { text }));
const bigButton = (label, onclick, { kind = 'primary', iconName = null, disabled = false, describedBy = null, focusKey = null } = {}) =>
  h('button', { type: 'button', class: ['btn', 'big', kind], onclick, disabled, 'aria-describedby': describedBy, 'data-focus-key': focusKey },
    iconName ? icon(iconName, { size: 20 }) : null, label);

const STEP_NAMES = ['steps.start', 'steps.capture', 'steps.review', 'steps.hospital', 'steps.send'];
function stepper(n) {
  return h('div', { class: 'stepper' },
    h('p', { class: 'small muted', text: t('steps.label', { n, name: t(STEP_NAMES[n - 1]) }) }),
    h('div', { class: 'stepper-bar', 'aria-hidden': 'true' }, STEP_NAMES.map((_, i) => h('span', { class: i < n ? 'on' : '' }))));
}

function emergencyBox() {
  return h('section', { class: 'emergency', 'aria-labelledby': 'emergency-title' },
    icon('phone', { size: 26 }),
    h('div', {},
      h('h2', { id: 'emergency-title', text: t('emergency.title', { number: REGION.number }) }),
      h('p', { text: t('emergency.body') }),
      h('p', { class: 'small' }, t('emergency.region', { region: t(`region.${REGION.region}`) }),
        REGION.verified ? null : [' · ', h('span', { class: 'chip', text: t('emergency.verify') })])));
}

// ---------- Welcome ----------
export function renderWelcome(main) {
  append(main, [
    h('div', { class: 'welcome-tools' }, langToggle({ onDark: false }), demoButton({ onDark: false }),
      h('a', { class: 'btn', href: '#/about', 'data-focus-key': 'welcome-about' }, icon('info', { size: 16 }), t('about.link'))),
    h('section', { class: 'hero' },
      h('h1', { text: t('welcome.title') }),
      h('p', { class: 'lead', text: t('welcome.mission') })),
    h('div', { class: 'entry-cards' },
      h('a', { class: 'entry-card', href: '#/citizen', 'data-focus-key': 'entry-citizen' },
        citizenIllustration(), h('span', { class: 'entry-title', text: t('welcome.citizenTitle') }), h('span', { class: 'muted', text: t('welcome.citizenBody') }),
        h('span', { class: 'entry-go' }, icon('arrow', { size: 20, cls: 'flip-rtl' }))),
      h('a', { class: 'entry-card', href: '#/crew', 'data-focus-key': 'entry-ambulance' },
        ambulanceCardIllustration(), h('span', { class: 'entry-title', text: t('welcome.ambulanceTitle') }), h('span', { class: 'muted', text: t('welcome.ambulanceBody') }),
        h('span', { class: 'entry-go' }, icon('arrow', { size: 20, cls: 'flip-rtl' })))),
    h('a', { class: 'staff-entry', href: '#/er', 'data-focus-key': 'entry-staff' }, icon('staff', { size: 22 }),
      h('span', {}, h('strong', { text: t('welcome.staffTitle') }), h('span', { class: 'small muted', text: ` — ${t('welcome.staffBody')}` }))),
    emergencyBox(),
  ]);
}

// ---------- Step A: start ----------
const SAMPLES = ['fever', 'fall', 'crash', 'arabic'];
let showSamples = false;

function startFrom(transcript) {
  const r = extractIntake(transcript, /[؀-ۿ]/.test(transcript) ? 'ar' : lang());
  save({ transcript, fields: r.fields, matches: r.matches, edited: [], reviewed: false });
}

export function renderCitizenStart(main) {
  const mine = citizenCases(state(), deviceRef());
  append(main, [
    stepper(1),
    h('h1', { text: t('start.title') }),
    note(t('start.notice'), 'warn'),
    h('div', { class: 'choice-cards' },
      choiceCard('mic', 'start.voice', 'start.voiceBody', () => { save({ mode: 'voice' }); go('citizen/capture'); }),
      choiceCard('comment', 'start.type', 'start.typeBody', () => { save({ mode: 'type' }); go('citizen/capture'); }),
      choiceCard('spark', 'start.sample', 'start.sampleBody', () => { showSamples = !showSamples; requestRender(); }, showSamples)),
    showSamples ? h('section', { class: 'panel', 'aria-label': t('start.samples') },
      h('h2', { text: t('start.samples') }),
      h('ul', { class: 'rows' }, SAMPLES.map((id) => h('li', {},
        h('button', { type: 'button', class: 'btn big sample', lang: id === 'arabic' ? 'ar' : null, 'data-focus-key': `sample:${id}`,
          onclick: () => { startFrom(t(`sample.${id}.text`)); showSamples = false; go('citizen/review'); } },
        h('span', { class: 'entry-title', text: t(`sample.${id}.title`) }),
        h('span', { class: 'small muted', dir: 'auto', text: t(`sample.${id}.text`) })))))) : null,
    mine.length ? h('a', { class: 'btn big', href: '#/citizen/notices' }, icon('inbox', { size: 20 }), `${t('public.myNotices')} (${mine.length})`) : null,
    emergencyBox(),
  ]);
}

function choiceCard(iconName, titleKey, bodyKey, onclick, pressed = null) {
  return h('button', { type: 'button', class: 'choice-card', onclick, 'aria-pressed': pressed === null ? null : String(pressed), 'data-focus-key': `choice:${titleKey}` },
    icon(iconName, { size: 28 }), h('span', { class: 'entry-title', text: t(titleKey) }), h('span', { class: 'small muted', text: t(bodyKey) }));
}

// ---------- Step B: describe (voice or typed) ----------
export function renderCapture(main) {
  const d = draft();
  const id = nextUid('transcript');
  const ready = d.transcript.trim().length > 0;
  append(main, [
    stepper(2),
    h('h1', { text: t('capture.title') }),
    h('p', { class: 'muted', text: t('capture.prompts') }),
    voicePanel({ key: 'citizen', lang: lang() === 'ar' ? 'ar-SA' : 'en-US', label: t('start.voice'), rerender: requestRender,
      onFinal: (text) => save({ transcript: `${draft().transcript} ${text}`.trim() }) }),
    h('div', { class: 'field' },
      h('label', { for: id, text: t('capture.textLabel') }),
      h('textarea', { id, rows: 7, dir: 'auto', 'data-preserve': 'citizen:transcript', 'data-model-backed': '', value: d.transcript, 'aria-describedby': `${id}-hint`,
        oninput: (e) => {
          const was = draft().transcript.trim().length > 0;
          save({ transcript: e.target.value });
          if (was !== e.target.value.trim().length > 0) requestRender();
        } }),
      h('span', { class: 'hint', id: `${id}-hint`, text: t('capture.textHint') })),
    h('div', { class: 'step-actions' },
      h('a', { class: 'btn big', href: '#/citizen' }, t('common.back')),
      bigButton(t('capture.continue'), () => { stopVoice(); startFrom(draft().transcript); go('citizen/review'); },
        { disabled: !ready, describedBy: ready ? null : 'need-text', focusKey: 'capture-continue' })),
    ready ? null : h('p', { class: 'small muted', id: 'need-text', text: t('capture.needText') }),
  ]);
}

// ---------- Step C: review ----------
const FIELD_DEFS = [
  { key: 'concern', label: 'field.concern', type: 'textarea', required: true },
  { key: 'age', label: 'field.age' },
  { key: 'onset', label: 'field.onset' },
  { key: 'awake', label: 'field.awake', type: 'select', options: ['unknown', 'yes', 'no'], optionLabel: (v) => t(`awake.${v}`) },
  { key: 'breathing', label: 'field.breathing', type: 'select', options: ['unknown', 'yes', 'no'], optionLabel: (v) => t(`awake.${v}`) },
  { key: 'conditions', label: 'field.conditions' },
  { key: 'allergies', label: 'field.allergies' },
  { key: 'patientCount', label: 'field.patientCount' },
  { key: 'location', label: 'field.location' },
  { key: 'transportMode', label: 'field.transport', type: 'select', options: ['unknown', 'private_car', 'taxi', 'walking'], optionLabel: (v) => t(`transport.${v}`) },
  { key: 'contact', label: 'field.contact', optional: true },
  { key: 'assistance', label: 'field.accessibility' },
];
const known = (v) => (v && v !== 'unknown' ? v : '');

function fieldControl(def, d) {
  const id = nextUid(`f-${def.key}`);
  const value = d.fields?.[def.key] ?? 'unknown';
  const edited = d.edited.includes(def.key);
  const phrase = d.matches?.[def.key];
  const hintText = edited ? t('review.edited') : phrase ? t('review.from', { phrase }) : null;
  const onChange = (e) => {
    const v = e.target.value.trim();
    const fields = { ...draft().fields, [def.key]: v || 'unknown' };
    save({ fields, edited: [...new Set([...draft().edited, def.key])] });
    if (def.required) requestRender();
  };
  let control;
  if (def.type === 'select') {
    control = h('select', { id, onchange: (e) => { onChange(e); requestRender(); }, 'data-focus-key': `field:${def.key}` },
      def.options.map((o) => h('option', { value: o, selected: o === value, text: def.optionLabel(o) })));
  } else if (def.type === 'textarea') {
    control = h('textarea', { id, rows: 3, dir: 'auto', value: known(value), placeholder: t('review.unknown'), 'data-preserve': `field:${def.key}`, 'data-model-backed': '', oninput: onChange, required: def.required });
  } else {
    control = h('input', { id, type: 'text', dir: 'auto', value: known(value), placeholder: t('review.unknown'), 'data-preserve': `field:${def.key}`, 'data-model-backed': '', oninput: onChange });
  }
  return h('div', { class: 'field' },
    h('label', { for: id }, t(def.label), def.required ? h('span', { class: 'req', 'aria-hidden': 'true', text: ' *' }) : null,
      def.optional ? h('span', { class: 'muted small', text: ` (${t('review.optional')})` }) : null),
    control,
    hintText ? h('span', { class: 'hint', dir: 'auto', text: hintText }) : null);
}

export function renderReview(main) {
  const d = draft();
  if (!d.fields) { go('citizen'); return; }
  const hasConcern = !!known(d.fields.concern);
  const canGo = d.reviewed && hasConcern;
  const checkId = nextUid('reviewed');
  append(main, [
    stepper(3),
    h('h1', { text: t('review.title') }),
    note(t('review.unverified'), 'warn'),
    h('p', { class: 'small' }, h('span', { class: 'est-tag', text: t('extraction.demo-rule-based') }), t('review.demo')),
    h('div', { class: 'review-grid' },
      h('section', { class: 'panel', 'aria-label': t('review.transcript') },
        h('h2', { text: t('review.transcript') }),
        d.transcript ? h('blockquote', { class: 'transcript', dir: 'auto', text: d.transcript }) : h('p', { class: 'muted', text: t('review.noTranscript') }),
        h('a', { class: 'btn', href: '#/citizen/capture' }, icon('comment', { size: 18 }), t('review.backToText'))),
      h('section', { class: 'panel', 'aria-label': t('review.fields') },
        h('h2', { text: t('review.fields') }),
        h('div', { class: 'form-grid' }, FIELD_DEFS.map((def) => fieldControl(def, d))))),
    h('div', { class: 'confirm-row' },
      h('input', { type: 'checkbox', id: checkId, checked: d.reviewed, 'data-focus-key': 'reviewed',
        onchange: (e) => { save({ reviewed: e.target.checked }); requestRender(); } }),
      h('label', { for: checkId, text: t('review.confirm') })),
    h('div', { class: 'step-actions' },
      h('a', { class: 'btn big', href: '#/citizen/capture' }, t('common.back')),
      bigButton(t('review.continue'), () => go('citizen/hospitals'), { disabled: !canGo, describedBy: canGo ? null : 'review-why', focusKey: 'review-continue' })),
    canGo ? null : h('p', { class: 'small muted', id: 'review-why', text: !hasConcern ? t('review.needConcern') : t('review.needReview') }),
  ]);
}

// ---------- Step D/E: hospitals and send ----------
let locating = false;
let locateAttempt = 0;
const LOCATE_GIVE_UP_MS = 15000;

function useMyLocation() {
  const override = '__silaGeoOverride' in globalThis ? globalThis.__silaGeoOverride : undefined;
  const geo = override === undefined ? globalThis.navigator?.geolocation : override;
  if (!geo) { save({ locationNote: 'hospitals.unsupported' }); requestRender(); return; }
  // The browser's own timeout only starts once permission is granted; an unanswered permission prompt would leave
  // "Finding your location…" forever, so the app gives up after 15 s and points to the district list instead.
  const attempt = ++locateAttempt;
  const current = () => attempt === locateAttempt && locating;
  const done = (lat, lng) => {
    if (!current()) return;
    const r = pointFromGeo(lat, lng);
    save({ point: r.point, place: r.outside ? { kind: 'district', id: r.district.id } : { kind: 'gps' },
      locationNote: r.outside ? 'hospitals.outside' : null, outsideDistrict: r.district.id });
    locating = false;
    requestRender();
  };
  const failed = (code) => { if (!current()) return; locating = false; save({ locationNote: code === 1 ? 'hospitals.denied' : 'hospitals.unavailable' }); requestRender(); };
  locating = true;
  requestRender();
  setTimeout(() => failed(3), LOCATE_GIVE_UP_MS);
  if (override) {
    // Verification seam: { lat, lng } or { error: 1|2|3 }.
    setTimeout(() => (override.error ? failed(override.error) : done(override.lat, override.lng)), 50);
    return;
  }
  geo.getCurrentPosition((p) => done(p.coords.latitude, p.coords.longitude), (e) => failed(e.code), { timeout: 10000, maximumAge: 60000 });
}

const transportFor = (d) => (['private_car', 'taxi', 'walking'].includes(d.fields?.transportMode) ? d.fields.transportMode : 'unknown');

function sendPayload(d, hospital) {
  const f = d.fields;
  const val = (k) => known(f[k]) || null;
  const both = f.awake === 'no' || f.breathing === 'no' ? 'no' : f.awake === 'yes' && f.breathing === 'yes' ? 'yes' : 'unknown';
  return { destinationHospitalId: hospital.id, clientRef: d.clientRef, origin: d.point, concern: val('concern'), ageText: val('age'), onset: val('onset'),
    awake: f.awake, breathing: f.breathing, awakeBreathing: both, conditions: val('conditions'), allergies: val('allergies'),
    patientCount: val('patientCount') ?? 1, location: val('location'), contact: val('contact'), accessibilityNeeds: val('assistance'),
    transcript: d.transcript || null, extractionMethod: 'demo-rule-based', transportMode: transportFor(d),
    etaAt: new Date(Date.parse(now()) + hospital.trip.minutes * 60000).toISOString() };
}

export function renderHospitals(main) {
  const d = draft();
  if (!d.fields || !d.reviewed) { go(d.fields ? 'citizen/review' : 'citizen'); return; }
  const s = state();
  const n = now();
  const mode = transportFor(d);
  const pub = publicHospitals(s, n);
  const list = d.point ? rankHospitals(pub, d.point, mode) : pub.map((x) => ({ ...x, trip: null, nearest: false }));
  const selected = list.find((x) => x.id === d.hospitalId) ?? null;
  const districtId = nextUid('district');
  const modeId = nextUid('mode');
  const place = d.place?.kind === 'gps' ? t('hospitals.fromGps') : d.place ? t(`district.${d.place.id}`) : null;
  const sendCheck = selected?.trip ? checkCitizen('submitArrival', sendPayload(d, selected)) : null;
  const select = (id) => { save({ hospitalId: id }); requestRender(); };

  append(main, [
    stepper(4),
    h('h1', { text: t('hospitals.title') }),
    note(t('hospitals.routing'), '', 'info'),
    h('section', { class: 'panel location-panel' },
      h('div', { class: 'step-actions' },
        bigButton(locating ? t('hospitals.locating') : t('hospitals.useLocation'), useMyLocation, { kind: '', iconName: 'pin', disabled: locating, focusKey: 'use-location' }),
        h('div', { class: 'field' },
          h('label', { for: districtId, text: t('hospitals.district') }),
          h('select', { id: districtId, 'data-focus-key': 'district',
            onchange: (e) => { const dd = DISTRICTS.find((x) => x.id === e.target.value); if (dd) { save({ point: { x: dd.x, y: dd.y }, place: { kind: 'district', id: dd.id }, locationNote: null }); requestRender(); } } },
          h('option', { value: '', text: t('hospitals.chooseDistrict'), selected: d.place?.kind !== 'district' }),
          DISTRICTS.map((x) => h('option', { value: x.id, selected: d.place?.kind === 'district' && d.place.id === x.id, text: t(`district.${x.id}`) }))))),
      d.locationNote ? note(t(d.locationNote, { district: t(`district.${d.outsideDistrict ?? 'al-noor'}`) }), d.locationNote === 'hospitals.outside' ? '' : 'warn', 'pin') : null,
      place ? h('p', { class: 'small' }, icon('pin', { size: 16 }), ' ', t('hospitals.youAreIn', { place }), ' ', h('span', { class: 'chip', text: t('hospitals.simulated') })) : h('p', { class: 'small muted', text: t('hospitals.needPlace') }),
      h('div', { class: 'field' },
        h('label', { for: modeId, text: t('hospitals.travelMode') }),
        h('select', { id: modeId, 'data-focus-key': 'travel-mode', onchange: (e) => { save({ fields: { ...draft().fields, transportMode: e.target.value }, edited: [...new Set([...draft().edited, 'transportMode'])] }); requestRender(); } },
          ['unknown', 'private_car', 'taxi', 'walking'].map((m) => h('option', { value: m, selected: m === mode, text: t(`transport.${m}`) }))))),
    h('div', { class: 'map-wrap' }, cityMap({ hospitals: list, point: d.point, selectedId: d.hospitalId, onSelect: select }),
      h('p', { class: 'small muted', text: `${t('city.name')} · ${t('hospitals.simulated')}` })),
    h('ul', { class: 'hospital-list', 'aria-label': t('hospitals.title') }, list.map((x) => hospitalItem(x, x.id === d.hospitalId, mode, select, n))),
    h('section', { class: 'panel send-panel', 'aria-labelledby': 'send-title' },
      h('h2', { id: 'send-title', text: t('send.title') }),
      selected?.trip ? h('p', { text: t('send.summary', { hospital: selected.name, mode: t(`transport.${mode}`), min: selected.trip.minutes }) }) : null,
      bigButton(t('send.button'), () => send(d, selected), { disabled: !sendCheck?.ok, describedBy: sendCheck?.ok ? null : 'send-why', focusKey: 'send' }),
      sendCheck?.ok ? null : h('p', { class: 'small muted', id: 'send-why', text: !selected?.trip ? (d.point ? t('send.needHospital') : t('hospitals.needPlace')) : t('common.whyDisabled', { reason: sendCheck.reason }) }),
      h('p', { class: 'small muted', text: t('send.notReservation') })),
  ]);
}

export function hospitalItem(x, isSelected, mode, select, n) {
  const capIcon = { high: 'check', medium: 'clock', low: 'alert' }[x.capacity];
  return h('li', {},
    h('button', { type: 'button', class: ['hospital-item', isSelected && 'selected'], 'aria-pressed': String(isSelected), onclick: () => select(x.id),
      'data-focus-key': `hospital:${x.id}`, 'aria-label': `${t('hospitals.select', { name: x.name })}${x.nearest ? ` — ${t('hospitals.nearest')}` : ''}` },
    h('span', { class: 'hospital-head' }, icon('hospital', { size: 22 }), h('strong', { text: x.name }),
      x.nearest ? pill('ready', t('hospitals.nearest'), 'pin') : null, isSelected ? pill('reserved', t('hospitals.selected'), 'check') : null),
    x.trip ? h('span', { class: 'hospital-trip' },
      h('span', { text: t('hospitals.distance', { km: x.trip.km }) }), ' · ',
      h('span', { text: t('hospitals.travel', { min: x.trip.minutes, mode: t(`transport.${mode}`).toLowerCase() }) }), ' ',
      h('span', { class: 'chip', text: t('hospitals.simulated') })) : null,
    h('span', { class: 'hospital-meta' },
      pill(x.erOpen ? 'ready' : 'blocked', t(x.erOpen ? 'hospitals.erOpen' : 'hospitals.erClosed'), x.erOpen ? 'check' : 'alert'),
      h('span', { class: ['capacity', x.capacity] }, icon(capIcon, { size: 16 }), h('span', { text: `${t(`capacity.${x.capacity}`)} (${t('hospitals.simulated')})` }))),
    h('span', { class: 'hospital-services' }, x.services.map((sv) => h('span', { class: 'chip', text: t(`service.${sv}`) }))),
    h('span', { class: 'small muted', text: t('hospitals.updated', { rel: formatRelative(x.updatedAt, n) }) })));
}

function send(d, hospital) {
  const res = runCitizen('submitArrival', sendPayload(d, hospital));
  if (res.ok) {
    resetDraft();
    try { sessionStorage.setItem('sila.justSent', res.result.caseId); } catch { /* storage blocked */ }
    go(`citizen/case/${res.result.caseId}`);
  }
  return res;
}

// ---------- Guided demo hooks (the demo drives the same draft and the same send() as the buttons) ----------
const DEMO_DISTRICT = 'al-noor';
const demoSampleText = () => t('sample.fever.text');
function demoNearest(d) {
  const list = rankHospitals(publicHospitals(state(), now()), d.point, transportFor(d));
  return list.find((x) => x.nearest) ?? null;
}
export function citizenDemoState() {
  const d = draft();
  return { loaded: !!d.fields && d.transcript === demoSampleText(), reviewed: !!d.reviewed && !!d.fields };
}
/** Prepares (or completes) one citizen step for the guided demo; 'send' returns the engine result. */
export function demoCitizen(kind) {
  if (kind === 'citizenShowSamples') { showSamples = true; return null; }
  if (kind === 'citizenLoadSample' || !citizenDemoState().loaded) { startFrom(demoSampleText()); showSamples = false; if (kind === 'citizenLoadSample') { go('citizen/review'); return null; } }
  if (kind === 'citizenConfirmReview') { save({ reviewed: true }); requestRender(); return null; }
  const dd = DISTRICTS.find((x) => x.id === DEMO_DISTRICT);
  save({ reviewed: true, point: { x: dd.x, y: dd.y }, place: { kind: 'district', id: dd.id }, locationNote: null, clientRef: 'demo-citizen' });
  const nearest = demoNearest(draft());
  save({ hospitalId: nearest?.id ?? null });
  if (kind === 'citizenPrepareSend') return null;
  return nearest ? send(draft(), nearest) : null;
}
