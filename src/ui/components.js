// Shared widgets. Permission state always comes from the engine (preflight → can()), never from the UI.

import { t, tm, formatTime, formatRelative, localizeData } from '../i18n.js';
import { commentsFor, historyFor } from '../selectors.js';
import { h, nextUid } from './dom.js';
import { icon } from './icons.js';
import { ctx, state, now, check, seenVersion, run, currentUser } from './core.js';

const PREFLIGHT_COMMENT = '…';

export const userName = (id) => (id ? localizeData(state().users[id]?.name ?? id) : t('common.unassigned'));
export const roleLabel = (role) => (role ? t(`role.${role}`) : '');

const LEVEL_ICON = { ready: 'check', pending: 'clock', blocked: 'alert', reserved: 'lock', occupied: 'person', urgent: 'alert', neutral: 'info' };
export function pill(level, text = t(`level.${level}`), iconName = LEVEL_ICON[level]) {
  return h('span', { class: ['pill', level] }, icon(iconName, { size: 14 }), text);
}

export function emptyState(text, iconName = 'inbox') {
  return h('p', { class: 'empty' }, icon(iconName, { size: 20 }), text);
}

export function panel(title, iconName, count, ...children) {
  const id = nextUid('panel');
  return h('section', { class: 'panel', 'aria-labelledby': id },
    h('header', {}, h('h2', { id }, icon(iconName), title, count != null ? h('span', { class: 'count-badge', text: String(count) }) : null)),
    ...children);
}

/**
 * A button for one engine action. Disabled with the engine's reason when the current user may not do it now.
 * - Direct actions run immediately (full preflight: permission + transition).
 * - `open` actions (dialogs) check permission only; the dialog collects the required input and the engine validates.
 */
export function actionButton({ action, payload, label, kind = '', iconName = null, open = null, focusKey = null, small = false, big = false, onDone = null }) {
  const verdict = check(action, payload, { permissionOnly: !!open });
  const seen = seenVersion(action, payload);
  const whyId = nextUid('why');
  const btn = h('button', {
    type: 'button', class: ['btn', kind, small && 'small', big && 'big'], disabled: !verdict.ok,
    'aria-describedby': verdict.ok ? null : whyId, 'data-focus-key': focusKey ?? `${action}:${JSON.stringify(payload)}`,
    onclick: (e) => {
      e.stopPropagation();
      if (open) open(seen);
      else run(action, payload, { seen, onDone });
    },
  }, iconName ? icon(iconName, { size: big ? 20 : 16 }) : null, label);
  return h('div', { class: 'action' }, btn,
    verdict.ok ? null : h('span', { class: 'why', id: whyId }, icon('info', { size: 14 }), t('common.whyDisabled', { reason: verdict.reason })));
}

/** A plain UI button (navigation, opening details) — no engine state change. */
export function uiButton(label, onclick, { kind = '', iconName = null, small = false, ...attrs } = {}) {
  return h('button', { type: 'button', class: ['btn', kind, small && 'small'], onclick: (e) => { e.stopPropagation(); onclick(e); }, ...attrs },
    iconName ? icon(iconName, { size: 16 }) : null, label);
}

export function ownerText(role, userId) {
  return userId ? t('bed.ownerNamed', { role: roleLabel(role), name: userName(userId) }) : roleLabel(role);
}

// "Est. ready 14:35 — waiting on Cleaning (Housekeeping: Ahmed Yusuf)" / "Ready time: Unknown …", always tagged Estimate.
export function forecastLine(forecast, tag = 'p') {
  if (!forecast) return null;
  const step = forecast.blockingStep ? t(`blocker.${forecast.blockingStep.type}`) : '';
  const owner = forecast.owner ? ownerText(forecast.owner.role, forecast.owner.userId) : '';
  const text = forecast.estimatedReadyAt
    ? t('bed.forecastEst', { time: formatTime(forecast.estimatedReadyAt), step, owner }) + (forecast.overdue ? ` · ${t('bed.forecastOverdue')}` : '')
    : t('bed.forecastUnknown', { step, owner });
  return h(tag, { class: 'forecast' }, h('span', { class: 'est-tag', text: t('common.estimate') }), text);
}

export function blockerList(blockers) {
  if (!blockers.length) return emptyState(t('empty.blockers'), 'check');
  const SEVERE = ['technical_fault', 'equipment_ticket', 'equipment_check', 'staffing'];
  return h('ul', { class: 'blockers' }, blockers.map((b) => h('li', {},
    pill(SEVERE.includes(b.type) ? 'blocked' : b.type === 'reserved' ? 'reserved' : b.type === 'occupied' ? 'occupied' : 'pending', t(`blocker.${b.type}`)),
    h('div', {},
      h('p', { text: tm(b.description) }),
      h('p', { class: 'small muted' }, t('drawer.owner', { owner: ownerText(b.ownerRole, b.ownerUser) }),
        b.since ? ` · ${t('drawer.since', { rel: formatRelative(b.since, now()) })}` : '')))));
}

export function historyList(entity, id) {
  const events = historyFor(state(), entity, id);
  if (!events.length) return emptyState(t('empty.history'), 'history');
  return h('ol', { class: 'timeline' }, events.slice(0, 40).map((e) => h('li', {},
    h('time', { datetime: e.at, title: e.at, text: formatTime(e.at) }),
    h('div', {},
      h('p', {}, h('strong', { text: e.actorName ?? t('common.system') }), e.actorRole ? h('span', { class: 'muted', text: ` · ${roleLabel(e.actorRole)}` }) : null),
      h('p', { text: tm(e.summary) }),
      e.reason ? h('p', { class: 'small muted', text: `${t('common.reason')}: ${tm(e.reason)}` }) : null))));
}

// Comments thread + add form. The textarea keeps its text across live re-renders (data-preserve).
export function commentsSection(targetType, targetId) {
  const list = commentsFor(state(), targetType, targetId);
  const id = nextUid('comment');
  const form = h('form', { class: 'field', onsubmit: (e) => {
    e.preventDefault();
    const ta = form.querySelector('textarea');
    const res = run('addComment', { targetType, targetId, text: ta.value });
    if (res.ok) ta.value = '';
  } },
  h('label', { for: id, text: t('drawer.commentLabel') }),
  h('textarea', { id, name: 'text', rows: 2, maxlength: 500, 'data-preserve': `comment:${targetType}:${targetId}`, 'aria-describedby': `${id}-hint` }),
  h('span', { class: 'hint', id: `${id}-hint`, text: t('drawer.commentHint') }),
  // The permission preflight needs a non-empty comment; this placeholder is never shown or sent.
  h('div', {}, actionSubmit('addComment', { targetType, targetId, text: PREFLIGHT_COMMENT }, t('drawer.commentSubmit'))));
  return [
    list.length ? h('ol', { class: 'timeline' }, list.map((c) => h('li', {},
      h('time', { datetime: c.createdAt, text: formatTime(c.createdAt) }),
      h('div', {}, h('p', {}, h('strong', { text: userName(c.authorId) }), c.kind === 'clarification' ? h('span', { class: 'chip', text: t('drawer.clarifications') }) : null),
        h('p', { text: c.body }),
        c.answer ? h('p', { class: 'small', text: t('drawer.answer', { text: c.answer }) }) : null)))) : emptyState(t('empty.comments'), 'comment'),
    form,
  ];
}

// A submit button whose enabled state comes from a permission-only preflight.
function actionSubmit(action, payload, label) {
  const verdict = check(action, payload, { permissionOnly: true });
  const whyId = nextUid('why');
  return h('div', { class: 'action' },
    h('button', { type: 'submit', class: 'btn primary small', disabled: !verdict.ok, 'aria-describedby': verdict.ok ? null : whyId, text: label }),
    verdict.ok ? null : h('span', { class: 'why', id: whyId }, icon('info', { size: 14 }), t('common.whyDisabled', { reason: verdict.reason })));
}

export function relTime(iso) {
  return iso ? h('time', { datetime: iso, title: iso, text: formatRelative(iso, now()) }) : t('common.unknown');
}

export function isMine(userId) {
  return userId === currentUser().id;
}

export function highlightClass(type, id) {
  return ctx.ui.highlight?.type === type && ctx.ui.highlight?.id === id ? 'highlight' : null;
}
