// App entry: wires the store to the views and re-renders on every change (local or from another tab).

import { t, dir, getLocale } from '../i18n.js';
import { h, clear } from './dom.js';
import { ctx, initStore, requestRender, now, closeDrawer, currentUser, routeAllowed, defaultRoute } from './core.js';
import { renderTopbar, renderNotifications, renderPublicTopbar } from './shell.js';
import { renderWelcome, renderAmbulancePlaceholder, renderCitizenStart, renderCapture, renderReview, renderHospitals } from './citizen.js';
import { renderCase, renderNotices } from './notices.js';
import { renderEr } from './er.js';
import { renderTasks } from './tasks.js';
import { renderIcu } from './icu.js';
import { renderQueue, renderTransport } from './queues.js';
import { renderDrawer } from './drawer.js';

const ROUTES = { er: renderEr, icu: renderIcu, tasks: renderTasks, queue: renderQueue, transport: renderTransport };
// Public pages (no login): welcome, the citizen journey and the ambulance placeholder.
const PUBLIC = {
  welcome: { render: renderWelcome, title: 'app.tagline' },
  ambulance: { render: renderAmbulancePlaceholder, title: 'welcome.ambulanceTitle' },
  citizen: { render: renderCitizenStart, title: 'welcome.citizenTitle' },
  'citizen/capture': { render: renderCapture, title: 'capture.title' },
  'citizen/review': { render: renderReview, title: 'review.title' },
  'citizen/hospitals': { render: renderHospitals, title: 'hospitals.title' },
  'citizen/notices': { render: renderNotices, title: 'notices.title' },
  'citizen/case': { render: (main, id) => renderCase(main, id), title: 'notices.title' },
};
// Each staff account only sees the pages its role may use; anything else falls back to the role's default page.
const resolveRoute = () => {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length) { history.replaceState(null, '', '#/welcome'); return { family: 'public', key: 'welcome' }; }
  if (parts[0] === 'citizen' && parts[1] === 'case') return { family: 'public', key: 'citizen/case', param: parts[2] };
  const pubKey = parts[0] === 'citizen' && parts[1] ? `citizen/${parts[1]}` : parts[0];
  if (PUBLIC[pubKey]) return { family: 'public', key: pubKey };
  const u = currentUser();
  if (ROUTES[parts[0]] && routeAllowed(parts[0], u)) return { family: 'staff', key: parts[0] };
  const fallback = defaultRoute(u);
  history.replaceState(null, '', `#/${fallback}`);
  return { family: 'staff', key: fallback };
};
const TITLE_KEY = { er: 'nav.er', icu: 'nav.icu', tasks: 'nav.tasks', transport: 'nav.transport' };
const el = (id) => document.getElementById(id);

// Live re-renders replace DOM nodes; keep focus, typed text and drawer scroll where the user left them.
function captureView() {
  const active = document.activeElement;
  // data-model-backed fields already save every keystroke, so only their focus and cursor are restored, never the value.
  const preserved = [...document.querySelectorAll('[data-preserve]')].map((x) => ({ key: x.dataset.preserve, value: x.value, start: x.selectionStart, end: x.selectionEnd, modelBacked: 'modelBacked' in x.dataset }));
  return {
    focusKey: active?.dataset?.focusKey ?? null,
    preserveFocus: active?.dataset?.preserve ?? null,
    preserved,
    drawerScroll: document.querySelector('.drawer .body')?.scrollTop ?? 0,
    mainScroll: window.scrollY,
  };
}

function restoreView(v, drawerJustOpened) {
  for (const p of v.preserved) {
    const x = document.querySelector(`[data-preserve="${CSS.escape(p.key)}"]`);
    if (x) {
      if (!p.modelBacked) x.value = p.value;
      if (v.preserveFocus === p.key) { x.focus(); x.setSelectionRange?.(p.start, p.end); }
    }
  }
  const body = document.querySelector('.drawer .body');
  if (body && !drawerJustOpened) body.scrollTop = v.drawerScroll;
  window.scrollTo(0, v.mainScroll);
  if (drawerJustOpened) {
    document.querySelector('[data-drawer-close]')?.focus();
  } else if (v.focusKey && !v.preserveFocus) {
    const target = document.querySelector(`[data-focus-key="${CSS.escape(v.focusKey)}"]`);
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }
}

let lastDrawerKey = null;
let lastRoute = null;
function render() {
  const view = captureView();
  const route = resolveRoute();
  const routeKey = `${route.key}/${route.param ?? ''}`;
  const changed = routeKey !== lastRoute;
  lastRoute = routeKey;
  ctx.ui.route = route.key;
  document.documentElement.lang = getLocale();
  document.documentElement.dir = dir();
  document.body.classList.toggle('public', route.family === 'public');
  document.body.classList.toggle('staff', route.family === 'staff');
  if (changed) view.mainScroll = 0;

  const main = clear(el('main'));
  if (route.family === 'public') {
    document.title = `${t('app.name')} — ${t(PUBLIC[route.key].title)}`;
    renderPublicTopbar(el('topbar'));
    PUBLIC[route.key].render(main, route.param);
    ctx.ui.drawer = null;
    clear(el('drawer-root'));
    clear(el('notif-root'));
    for (const id of ['topbar', 'main', 'footer']) el(id).inert = false;
    restoreView(view, false);
    if (changed && !view.preserveFocus) main.focus({ preventScroll: true });
    return;
  }
  document.title = `${t('app.name')} — ${t(TITLE_KEY[ctx.ui.route] ?? `nav.queue.${currentUser().role}`)}`;
  renderTopbar(el('topbar'));
  ROUTES[ctx.ui.route](main);
  renderDrawer(el('drawer-root'));
  renderNotifications(el('notif-root'));

  const drawerKey = ctx.ui.drawer ? `${ctx.ui.drawer.type}:${ctx.ui.drawer.id}` : null;
  const drawerOpen = !!drawerKey && !!document.querySelector('.drawer');
  for (const id of ['topbar', 'main', 'footer']) el(id).inert = drawerOpen;
  restoreView(view, drawerOpen && drawerKey !== lastDrawerKey);
  lastDrawerKey = drawerOpen ? drawerKey : null;
}

function renderStatic() {
  const skip = el('skip-link');
  skip.textContent = t('app.skipToMain');
  skip.addEventListener('click', (e) => { e.preventDefault(); el('main').focus(); }); // keep the route hash intact
  clear(el('footer')).append(
    h('p', { text: t('app.simulatedNote') }),
    h('p', { text: t('app.persistenceNote') }),
    h('p', { text: t('app.notEmergency') }));
  el('toasts').setAttribute('aria-label', t('toast.region'));
}

export function boot() {
  const store = initStore();
  ctx.render = render;
  renderStatic();
  store.subscribe((_, info) => {
    if (info.source !== 'local') ctx.ui.lastRemoteAt = now();
    requestRender();
  });
  window.addEventListener('hashchange', () => { ctx.ui.highlight = null; requestRender(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (ctx.ui.notifOpen) { ctx.ui.notifOpen = false; requestRender(); requestAnimationFrame(() => document.querySelector('[data-focus-key="bell"]')?.focus()); return; }
    if (ctx.ui.drawer) closeDrawer();
  });
  document.addEventListener('click', (e) => {
    if (ctx.ui.notifOpen && !e.target.closest('#notif-panel') && !e.target.closest('.bell')) { ctx.ui.notifOpen = false; requestRender(); }
  });
  setInterval(requestRender, 30000); // relative times ("Updated 4 min ago") and derived expiry stay current
  render();
}
