// Citizen tracking: confirmation/notice page and "My notices" for this device. Live — the store re-renders when the
// hospital acknowledges in another tab. Only notices owned by this device are ever shown (citizenCaseView).

import { citizenCases, citizenCaseView } from '../selectors.js';
import { t, tm, formatTime, formatRelative } from '../i18n.js';
import { h, append, nextUid } from './dom.js';
import { icon } from './icons.js';
import { state, now, openDialog, field, runCitizen, checkCitizen, deviceRef } from './core.js';
import { pill, emptyState } from './components.js';

const PROGRESS = ['submitted', 'acknowledged', 'en_route', 'arrived'];
const statusLevel = (st) => (st === 'canceled' ? 'blocked' : ['arrived', 'handover_complete', 'closed'].includes(st) ? 'ready' : st === 'submitted' ? 'pending' : 'reserved');
const statusPill = (st) => pill(statusLevel(st), t(`citizenStatus.${st}`), st === 'canceled' ? 'alert' : st === 'submitted' ? 'clock' : 'check');

function citizenButton({ action, payload, label, kind = '', open }) {
  const verdict = checkCitizen(action, payload, { permissionOnly: true });
  const whyId = nextUid('why');
  return h('div', { class: 'action' },
    h('button', { type: 'button', class: ['btn', 'big', kind], disabled: !verdict.ok, 'aria-describedby': verdict.ok ? null : whyId,
      'data-focus-key': `${action}:${JSON.stringify(payload)}`, onclick: open }, label),
    verdict.ok ? null : h('span', { class: 'why', id: whyId }, icon('info', { size: 14 }), t('common.whyDisabled', { reason: verdict.reason })));
}

function citizenDialog({ title, fields, submitLabel, danger = false, submit }) {
  return openDialog({ title, fields, submitLabel, danger, onSubmit: (data) => submit(data) });
}

function progress(view) {
  if (['canceled', 'closed'].includes(view.status)) return null;
  const at = Math.max(0, PROGRESS.indexOf(view.status === 'handover_complete' ? 'arrived' : view.status));
  return h('ol', { class: 'progress', 'aria-label': t('case.status') }, PROGRESS.map((st, i) => h('li', {
    class: [i < at && 'done', i === at && 'current'], 'aria-current': i === at ? 'step' : null,
  }, icon(i <= at ? 'check' : 'clock', { size: 16 }), t(`citizenStatus.${st}`))));
}

export function renderCase(main, caseId) {
  const view = citizenCaseView(state(), caseId, deviceRef());
  if (!view) {
    append(main, [h('h1', { text: t('notices.title') }), emptyState(t('case.notFound'), 'inbox'), h('a', { class: 'btn big', href: '#/citizen/notices' }, t('public.myNotices'))]);
    return;
  }
  let justSent = false;
  try { justSent = sessionStorage.getItem('sila.justSent') === caseId; } catch { /* storage blocked */ }
  const n = now();
  const active = view.caseStatus === 'active' && ['submitted', 'acknowledged', 'en_route'].includes(view.status);
  append(main, [
    justSent ? h('p', { class: 'notice success-notice', role: 'status' }, icon('check', { size: 20 }), h('strong', { text: t('case.sentTitle') })) : null,
    h('h1', { text: t('case.title', { ref: view.ref }) }),
    h('section', { class: 'panel' },
      h('dl', { class: 'facts big-facts' },
        h('dt', { text: t('case.ref') }), h('dd', {}, h('strong', { class: 'ref-big', text: view.ref })),
        h('dt', { text: t('case.status') }), h('dd', {}, statusPill(view.status)),
        h('dt', { text: t('case.destination') }), h('dd', { text: view.destination.name }),
        h('dt', { text: t('case.submitted') }), h('dd', { text: `${formatTime(view.submittedAt)} (${formatRelative(view.submittedAt, n)})` }),
        h('dt', { text: t('case.transport') }), h('dd', { text: t(`transport.${view.transportMode}`) }),
        h('dt', { text: t('case.eta') }), h('dd', { text: view.etaAt ? `${formatTime(view.etaAt)} (${formatRelative(view.etaAt, n)})` : t('common.unknown') })),
      progress(view),
      view.cancelReason ? h('p', { class: 'small', text: t('case.canceledReason', { reason: view.cancelReason }) }) : null,
      h('p', { class: 'small muted', text: t('case.notReservation') })),
    view.clarifications.length ? h('section', { class: 'panel' }, view.clarifications.map((q) => h('div', { class: 'rows' },
      h('p', { dir: 'auto' }, icon('comment', { size: 16 }), ' ', t('case.question', { question: q.question })),
      q.status === 'answered' ? h('p', { class: 'small', dir: 'auto', text: t('case.answered', { answer: q.answer }) })
        : citizenButton({ action: 'respondClarification', payload: { commentId: q.id }, label: t('case.reply'), kind: 'primary',
          open: () => citizenDialog({ title: t('reply.title', { ref: view.ref }), submitLabel: t('case.reply'),
            fields: () => [field({ label: t('reply.answer'), name: 'answer', type: 'textarea', required: true, maxlength: 300 })],
            submit: (d) => runCitizen('respondClarification', { commentId: q.id, answer: d.answer }, { seen: q.version, quiet: true }) }) })))) : null,
    active ? h('div', { class: 'step-actions' },
      citizenButton({ action: 'updateETA', payload: { caseId: view.id }, label: t('case.updateEta'), kind: 'primary',
        open: () => citizenDialog({ title: t('eta.title', { ref: view.ref }), submitLabel: t('case.updateEta'),
          fields: () => [
            field({ label: t('eta.minutes'), name: 'minutes', type: 'select', required: true, value: '15',
              options: [5, 10, 15, 20, 30, 45, 60].map((m) => ({ value: String(m), label: t('minutes.option', { n: m }) })) }),
            h('div', { class: 'choice' }, h('input', { type: 'checkbox', id: 'eta-enroute', name: 'enRoute' }), h('label', { for: 'eta-enroute', text: t('eta.enRoute') })),
            field({ label: t('eta.reason'), name: 'reason', type: 'text' }),
          ],
          submit: (d) => runCitizen('updateETA', { caseId: view.id, etaAt: new Date(Date.parse(now()) + Number(d.minutes) * 60000).toISOString(),
            enRoute: d.enRoute === 'on', reason: d.reason || undefined }, { seen: view.version, quiet: true }) }) }),
      citizenButton({ action: 'cancelCase', payload: { caseId: view.id }, label: t('case.cancel'), kind: 'danger',
        open: () => citizenDialog({ title: t('cancelNotice.title', { ref: view.ref }), submitLabel: t('case.cancel'), danger: true,
          fields: () => [field({ label: t('cancelNotice.reason'), name: 'reason', type: 'textarea', required: true, hint: t('common.reasonHint'), maxlength: 300 })],
          submit: (d) => runCitizen('cancelCase', { caseId: view.id, reason: d.reason }, { seen: view.version, quiet: true }) }) })) : null,
    h('section', { class: 'panel' },
      h('h2', { text: t('case.timeline') }),
      h('ol', { class: 'timeline' }, [...view.timeline].reverse().map((e) => h('li', {},
        h('time', { datetime: e.at, text: formatTime(e.at) }), h('span', { dir: 'auto', text: tm(e.detail) }))))),
    h('div', { class: 'step-actions' },
      h('a', { class: 'btn big', href: '#/citizen/notices' }, icon('inbox', { size: 20 }), t('public.myNotices')),
      h('a', { class: 'btn big', href: '#/citizen' }, t('case.newNotice'))),
  ]);
}

export function renderNotices(main) {
  const s = state();
  const n = now();
  const views = citizenCases(s, deviceRef()).map((c) => citizenCaseView(s, c.id, deviceRef())).filter(Boolean);
  append(main, [
    h('h1', { text: t('notices.title') }),
    h('p', { class: 'muted', text: t('notices.subtitle') }),
    views.length ? h('ul', { class: 'rows' }, views.map((v) => h('li', {},
      h('a', { class: 'notice-card', href: `#/citizen/case/${v.id}`, 'data-focus-key': `notice:${v.id}`, 'aria-label': t('notices.open', { ref: v.ref }) },
        h('span', { class: 'hospital-head' }, h('strong', { class: 'ref', text: v.ref }), statusPill(v.status)),
        h('span', { text: v.destination.name }),
        h('span', { class: 'small muted', text: `${t('case.eta')}: ${v.etaAt ? formatTime(v.etaAt) : t('common.unknown')} · ${t('case.submitted')} ${formatRelative(v.submittedAt, n)}` }),
        v.timeline.length ? h('span', { class: 'small', dir: 'auto', text: tm(v.timeline.at(-1).detail) }) : null)))) : emptyState(t('notices.empty'), 'inbox'),
    h('a', { class: 'btn big primary', href: '#/citizen' }, t('case.newNotice')),
  ]);
}
