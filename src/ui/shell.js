// App shell: top bar (brand, demo badge, navigation, active user, demo role switcher, bell, reset) and notifications.

import { values } from '../data.js';
import { notificationsFor } from '../readiness.js';
import { unreadCount, selectMyWork, citizenCases } from '../selectors.js';
import { t, tm, formatRelative } from '../i18n.js';
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { ctx, state, now, currentUser, setCurrentUser, isStaff, requestRender, run, openRecord, seenVersion, deptAccess, QUEUE_ROLES, deviceRef } from './core.js';
import { emptyState, pill, roleLabel } from './components.js';
import { openReset } from './forms.js';

export function renderTopbar(el) {
  clear(el);
  const s = state();
  const u = currentUser();
  const unread = unreadCount(notificationsFor(s, u), u);
  const myWork = selectMyWork(s, u, now());
  const navLink = (route, iconName, label, badge) => h('a', { href: `#/${route}`, 'aria-current': ctx.ui.route === route ? 'page' : null },
    icon(iconName, { size: 16 }), label, badge ? h('span', { class: 'count-badge', text: String(badge) }) : null);

  el.append(
    h('div', { class: 'brand' }, icon('logo', { size: 30, cls: 'logo' }),
      h('div', {}, h('div', { class: 'brand-name', text: t('app.name') }), h('div', { class: 'brand-tag', text: t('app.tagline') }))),
    h('span', { class: 'demo-badge' }, icon('info', { size: 14 }), t('app.demoBadge')),
    h('nav', { class: 'topnav', 'aria-label': t('nav.main') },
      deptAccess(u).includes('ER') ? navLink('er', 'dashboard', t('nav.er')) : null,
      deptAccess(u).includes('ICU') ? navLink('icu', 'bed', t('nav.icu')) : null,
      QUEUE_ROLES.includes(u.role) ? navLink('queue', 'broom', t(`nav.queue.${u.role}`)) : null,
      u.role === 'porter' ? navLink('transport', 'transfer', t('nav.transport')) : null,
      navLink('tasks', 'tasks', t('nav.tasks'), myWork.tasks.length + myWork.tickets.length)),
    h('div', { class: 'topbar-end' },
      userCard(s, u),
      switcher(s, u),
      h('button', {
        type: 'button', class: 'btn on-dark icon-btn bell', 'aria-label': unread ? t('notif.buttonCount', { n: unread }) : t('notif.button'),
        'aria-expanded': String(ctx.ui.notifOpen), 'aria-controls': 'notif-panel', 'data-focus-key': 'bell',
        onclick: () => { ctx.ui.notifOpen = !ctx.ui.notifOpen; requestRender(); },
      }, icon('bell', { size: 20 }), unread ? h('span', { class: 'count', 'aria-hidden': 'true', text: String(unread) }) : null),
      h('button', { type: 'button', class: 'btn on-dark', 'data-focus-key': 'reset', onclick: openReset }, icon('reset', { size: 16 }), t('reset.button'))));
}

function userCard(s, u) {
  const dept = u.department ? t(`dept.${u.department}`) : t('user.hospitalWide');
  const initials = u.name.replace(/^Dr\.\s*/, '').split(/\s+/).map((p) => p[0]).slice(0, 2).join('');
  return h('div', { class: 'user-card', 'aria-label': t('user.active') },
    h('span', { class: 'avatar', 'aria-hidden': 'true', text: initials }),
    h('span', { class: 'who' }, h('strong', { text: u.name }), h('span', { text: t('user.dept', { role: roleLabel(u.role), dept }) }),
      h('span', { text: s.hospitals[u.hospitalId]?.shortName ?? '' })));
}

function switcher(s, u) {
  const staff = values(s, 'users').filter(isStaff);
  const groups = values(s, 'hospitals').map((hosp) => ({ hosp, users: staff.filter((x) => x.hospitalId === hosp.id) })).filter((g) => g.users.length);
  return h('div', { class: 'switcher' },
    h('label', { for: 'role-switcher', text: t('switcher.label') }),
    h('select', { id: 'role-switcher', 'aria-describedby': 'role-switcher-hint', 'data-focus-key': 'switcher', onchange: (e) => setCurrentUser(e.target.value) },
      groups.map(({ hosp, users }) => h('optgroup', { label: hosp.name }, users.map((x) => h('option', { value: x.id, selected: x.id === u.id,
        text: t('switcher.option', { name: x.name, role: roleLabel(x.role), dept: x.department ? t('switcher.deptSuffix', { dept: t(`dept.${x.department}`) }) : '' }) }))))),
    h('span', { id: 'role-switcher-hint', class: 'sr-only', text: t('switcher.hint') }));
}

// Header for public pages (citizens): no accounts, no role switcher — just home, this device's notices and staff entry.
export function renderPublicTopbar(el) {
  clear(el);
  const count = citizenCases(state(), deviceRef()).length;
  el.append(
    h('a', { class: 'brand', href: '#/welcome', 'aria-label': t('public.home') }, icon('logo', { size: 30, cls: 'logo' }),
      h('div', {}, h('div', { class: 'brand-name', text: t('app.name') }), h('div', { class: 'brand-tag', text: t('app.tagline') }))),
    h('span', { class: 'demo-badge' }, icon('info', { size: 14 }), t('app.demoBadge')),
    h('nav', { class: 'topnav public-nav', 'aria-label': t('nav.main') },
      h('a', { href: '#/citizen/notices', 'aria-current': ctx.ui.route === 'citizen/notices' ? 'page' : null }, icon('inbox', { size: 16 }), t('public.myNotices'),
        count ? h('span', { class: 'count-badge', text: String(count) }) : null),
      h('a', { href: '#/er' }, icon('staff', { size: 16 }), t('public.staff'))));
}

export function renderNotifications(root) {
  clear(root);
  if (!ctx.ui.notifOpen) return;
  const s = state();
  const u = currentUser();
  const list = notificationsFor(s, u);
  root.append(h('section', { class: 'notif-panel', id: 'notif-panel', role: 'dialog', 'aria-labelledby': 'notif-title' },
    h('header', {}, h('h2', { id: 'notif-title', text: t('notif.title') }),
      h('button', { type: 'button', class: 'btn ghost icon-btn', 'aria-label': t('common.close'), 'data-focus-key': 'notif-close',
        onclick: () => { ctx.ui.notifOpen = false; requestRender(); } }, icon('close'))),
    h('p', { class: 'small muted notif-note', text: t('notif.simulated') }),
    list.length ? h('ul', {}, list.map((nt) => {
      const unread = !nt.readBy.includes(u.id);
      return h('li', {}, h('button', {
        type: 'button', class: ['notif-item', unread && 'unread'], 'data-focus-key': `notif:${nt.id}`,
        onclick: () => {
          if (unread) run('markNotificationRead', { notificationId: nt.id }, { seen: seenVersion('markNotificationRead', { notificationId: nt.id }), silent: true });
          openRecord(nt.ref);
        },
      },
      icon(nt.urgent ? 'alert' : 'bell', { size: 18 }),
      h('span', { class: 'grow' },
        h('span', { class: 'meta' }, unread ? pill('reserved', t('notif.unread'), 'spark') : null, nt.urgent ? pill('urgent', t('notif.urgent')) : null,
          h('time', { datetime: nt.createdAt, text: formatRelative(nt.createdAt, now()) })),
        h('span', { text: tm(nt.message) }))));
    })) : emptyState(t('notif.empty'), 'bell')));
}
