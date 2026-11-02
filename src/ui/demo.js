// Guided demo (SPEC §14). A small, movable presenter panel walks through the story: each step signs in as the right
// role, opens the right page or drawer, spotlights the REAL control, and waits for the presenter to click it — or runs
// "Do it for me", which calls the same dispatch() with the same payload and permission checks as that control.
// Nothing here changes state directly. The panel never covers its target; reduced motion removes all animation.

import { STEPS, PATHS, nextAction, actionIndex, stepDone } from '../demo-script.js';
import { t, tm, isRtl } from '../i18n.js';
import { h, clear, nextUid } from './dom.js';
import { icon } from './icons.js';
import { ctx, state, now, currentUser, setCurrentUser, run, seenVersion, requestRender, openDialog, deviceRef } from './core.js';
import { roleLabel, userName } from './components.js';
import { demoCitizen, citizenDemoState, resetDraft } from './citizen.js';
import { demoCrew, discardDemoCrewDraft } from './crew.js';

const KEY = 'sila.demo';
const PAUSE = 750; // visible pause before and between "Do it for me" actions
let demo = load(); // { path, index, startedAt, finishedAt, attempted: { [stepId]: [i…] }, twoScreen }
let message = null; // { kind: 'ok' | 'warn' | 'error', text }
let running = false;
let placedKey = null;
let dragPos = null; // { block, inline } in px from the top / inline-start edges, once the presenter moves the panel

function load() {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { return null; }
}
function persist() {
  try { if (demo) sessionStorage.setItem(KEY, JSON.stringify(demo)); else sessionStorage.removeItem(KEY); } catch { /* storage blocked */ }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const stepId = () => PATHS[demo.path][demo.index];
const step = () => STEPS[stepId()];
const attempted = () => new Set(demo.attempted?.[stepId()] ?? []);
const total = () => PATHS[demo.path].length;
const mmss = (ms) => { const sec = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };

// ---------- Start ----------
export function initDemo() {
  ctx.openDemo = openDemoStart;
  ctx.renderOverlay = renderOverlay;
  window.addEventListener('resize', () => positionSpotlight());
  document.addEventListener('scroll', () => positionSpotlight(), true);
  setInterval(() => { const el = document.getElementById('demo-elapsed'); if (el && demo && !demo.finishedAt) el.textContent = t('demo.elapsed', { time: mmss(Date.now() - demo.startedAt) }); }, 1000);
}

function openDemoStart() {
  const ids = { pitch: nextUid('dp'), tour: nextUid('dt'), reset: nextUid('dr'), two: nextUid('d2') };
  const second = `${location.href.split('#')[0]}#/er`;
  openDialog({
    title: t('demo.startTitle'), submitLabel: t('demo.start'),
    intro: h('p', { class: 'muted', text: t('demo.startIntro') }),
    fields: () => [
      h('fieldset', { class: 'demo-paths' }, h('legend', { text: t('demo.path') }),
        ['pitch', 'tour'].map((p) => h('div', { class: 'choice' },
          h('input', { type: 'radio', name: 'path', value: p, id: ids[p], checked: p === 'pitch' }),
          h('label', { for: ids[p] }, h('strong', { text: t(`demo.path.${p}`) }), h('span', { class: 'small muted', text: ` — ${t(`demo.path.${p}Body`)}` }))))),
      h('div', { class: 'choice' }, h('input', { type: 'checkbox', name: 'reset', id: ids.reset, checked: true }), h('label', { for: ids.reset, text: t('demo.reset') })),
      h('div', { class: 'choice' }, h('input', { type: 'checkbox', name: 'twoScreen', id: ids.two }), h('label', { for: ids.two, text: t('demo.twoScreen') })),
      h('p', { class: 'small muted' }, t('demo.twoScreenHint'), ' ', h('a', { href: second, target: '_blank', rel: 'noopener' }, t('demo.openSecond'))),
    ],
    onSubmit: (d) => { start(d.path === 'tour' ? 'tour' : 'pitch', d.reset === 'on', d.twoScreen === 'on'); return { ok: true }; },
  });
}

function start(path, reset, twoScreen) {
  if (reset) {
    ctx.store.resetDemo(); // every run starts from the same seed
    resetDraft();
    discardDemoCrewDraft();
    try { for (const k of Object.keys(localStorage)) if (k.startsWith('sila.viewed.')) localStorage.removeItem(k); } catch { /* storage blocked */ }
  }
  demo = { path, index: 0, startedAt: Date.now(), finishedAt: null, attempted: {}, twoScreen };
  message = null;
  placedKey = null;
  persist();
  requestRender();
}

function exitDemo() {
  demo = null;
  message = null;
  placedKey = null;
  persist();
  clear(overlayRoot());
  requestRender();
}

function go(delta) {
  if (!demo || running) return;
  const next = demo.index + delta;
  if (next < 0) return;
  if (next >= total()) { exitDemo(); return; }
  demo.index = next;
  message = null;
  placedKey = null;
  persist();
  requestRender();
}

// ---------- Where the presenter should be for the current item ----------
// The "item" is the step's view, or its next action still to do (judged now, so multi-action steps move on by themselves).
function currentItem() {
  const st = step();
  if (st.view) return st.view;
  return nextAction(stepId(), state(), attempted());
}
const itemKey = (item) => `${demo.path}:${demo.index}:${item ? actionIndex(stepId(), item) : 'done'}`;

function place(item) {
  if (!item) return;
  if (item.as && item.as !== 'citizen' && currentUser().id !== item.as) setCurrentUser(item.as);
  if (item.ui) prepare(item.ui);
  if (location.hash !== item.route) location.hash = item.route;
  ctx.ui.drawer = item.drawer ? item.drawer(state()) : null;
  ctx.ui.notifOpen = false;
  scrollTargetOnce = true;
  requestRender();
}

function prepare(kind) {
  if (kind.startsWith('citizen')) return demoCitizen(kind);
  if (kind.startsWith('crew')) return demoCrew(kind);
  return null;
}

// ---------- "Do it for me" ----------
async function doIt() {
  if (!demo || running) return;
  const id = stepId();
  const st = step();
  running = true;
  message = null;
  requestRender();
  try {
    if (st.view) {
      if (st.view.uiAction) { await pause(PAUSE / 2); prepare(st.view.uiAction); }
      return;
    }
    for (const p of st.prepare ?? []) prepare(p);
    for (let guard = 0; guard < 12; guard++) {
      if (!demo || stepId() !== id) return;
      const a = nextAction(id, state(), attempted());
      if (!a) break;
      place(a);
      await pause(PAUSE);
      const res = perform(a);
      demo.attempted[id] = [...attempted(), actionIndex(id, a)];
      persist();
      if (a.expectReject) {
        message = res && !res.ok ? { kind: 'ok', text: t('demo.rejectedExpected', { reason: tm(res.error) }) } : { kind: 'error', text: t('demo.rejected', { reason: '—' }) };
        continue;
      }
      if (!res?.ok) { message = { kind: 'error', text: t('demo.rejected', { reason: res ? tm(res.error) : t('common.unknown') }) }; break; }
      await pause(PAUSE / 2);
    }
  } finally {
    running = false;
    requestRender();
  }
}

// The same call the highlighted control makes: its module's own send(), or run() with the button's payload.
function perform(a) {
  if (a.ui === 'citizenPrepareSend') return demoCitizen('citizenSend');
  if (a.ui === 'crewPrepareDraft') return demoCrew('crewSend');
  const payload = a.payload(state(), { now: now(), deviceRef: deviceRef() });
  return run(a.action, payload, { as: a.as, seen: seenVersion(a.action, payload), quiet: true });
}

// ---------- Rendering: presenter panel + spotlight ----------
let scrollTargetOnce = false;
const overlayRoot = () => {
  let el = document.getElementById('demo-root');
  if (!el) { el = h('div', { id: 'demo-root' }); document.body.append(el); }
  return el;
};

function status(st, item) {
  const s = state();
  const pre = st.pre?.(s);
  if (pre && !stepDone(stepId(), s)) return { kind: 'warn', text: t('demo.blocked', { reason: t(pre) }), blocked: true };
  if (st.view?.uiAction) {
    const c = citizenDemoState();
    const ok = st.view.uiAction === 'citizenLoadSample' ? c.loaded : c.reviewed;
    return ok ? { kind: 'ok', text: t('demo.done'), done: true } : { kind: 'info', text: t('demo.waiting') };
  }
  if (st.view) return { kind: 'info', text: t('demo.viewOnly'), done: true };
  const rejectStep = st.actions.some((a) => a.expectReject);
  if (rejectStep && !item) return { kind: 'ok', text: message?.text ?? t('demo.done'), done: true };
  if (!item) return { kind: 'ok', text: t('demo.done'), done: true };
  return { kind: 'info', text: t('demo.waiting') };
}

function renderOverlay() {
  const root = overlayRoot();
  if (!demo || !PATHS[demo.path]) { clear(root); return; }
  if (demo.index >= total()) demo.index = total() - 1;
  const st = step();
  const item = currentItem();
  const key = itemKey(item);
  if (key !== placedKey && !running) { placedKey = key; place(item); }
  const stat = status(st, item);
  const last = demo.index === total() - 1;
  if (last && stat.done && !demo.finishedAt) { demo.finishedAt = Date.now(); persist(); }
  const shown = message && !(stat.done && message.kind === 'info') ? message : stat;
  const actor = item?.as === 'citizen' ? t('demo.actingCitizen') : item?.as ? t('demo.actingAs', { name: userName(item.as), role: roleLabel(state().users[item.as]?.role) }) : null;
  const pct = Math.round(((demo.index + (stat.done ? 1 : 0.5)) / total()) * 100);

  const panel = h('section', { class: 'demo-panel', role: 'region', 'aria-label': t('demo.panel') },
    h('header', { class: 'demo-head' },
      h('button', { type: 'button', class: 'demo-grip', 'aria-label': t('demo.move'), 'data-focus-key': 'demo-grip', onkeydown: keyMove, onpointerdown: dragStart }, icon('play', { size: 14 })),
      h('strong', { class: 'grow', text: `${t('demo.panel')} · ${t(`demo.path.${demo.path}`)}` }),
      h('span', { class: 'small', id: 'demo-elapsed', text: demo.finishedAt ? t('demo.finished', { time: mmss(demo.finishedAt - demo.startedAt) }) : t('demo.elapsed', { time: mmss(Date.now() - demo.startedAt) }) }),
      h('button', { type: 'button', class: 'btn ghost icon-btn on-dark', 'aria-label': t('demo.exit'), 'data-focus-key': 'demo-exit', onclick: exitDemo }, icon('close', { size: 16 }))),
    h('div', { class: 'demo-progress', role: 'progressbar', 'aria-label': t('demo.progress'), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct },
      h('span', { style: `inline-size: ${pct}%` })),
    h('div', { class: 'demo-body' },
      h('p', { class: 'small muted', text: t('demo.stepOf', { n: demo.index + 1, total: total() }) }),
      h('h2', { text: t(`demo.step.${stepId()}.title`) }),
      h('p', { text: t(`demo.step.${stepId()}.text`) }),
      actor ? h('p', { class: 'small demo-actor' }, icon('staff', { size: 14 }), actor) : null,
      running && item?.action ? h('p', { class: 'small', role: 'status', text: t('demo.running', { action: t(`auditAction.${item.action}`), name: item.as === 'citizen' ? t('role.citizen') : userName(item.as) }) }) : null,
      !running ? h('p', { class: ['demo-msg', shown.kind], role: 'status' }, icon(shown.kind === 'ok' ? 'check' : shown.kind === 'info' ? 'info' : 'alert', { size: 14 }), h('span', { text: shown.text })) : null,
      targetMissing && !stat.done && !running ? h('p', { class: 'small muted', text: t('demo.targetMissing') }) : null,
      demo.twoScreen ? h('p', { class: 'small muted' }, t('demo.twoScreenHint'), ' ', h('a', { href: `${location.href.split('#')[0]}#/er`, target: '_blank', rel: 'noopener' }, t('demo.openSecond'))) : null),
    h('div', { class: 'demo-actions' },
      h('button', { type: 'button', class: 'btn', disabled: demo.index === 0 || running, 'data-focus-key': 'demo-back', onclick: () => go(-1) },
        icon('chevron', { size: 14, cls: 'flip-rtl back' }), t('demo.back')),
      stat.blocked
        ? h('button', { type: 'button', class: 'btn', disabled: running, 'data-focus-key': 'demo-skip', onclick: () => go(1) }, t('demo.skip'))
        : h('button', { type: 'button', class: ['btn', !stat.done && 'primary'], disabled: running || stat.done, 'data-focus-key': 'demo-doit', onclick: doIt },
          icon('spark', { size: 14 }), t('demo.doIt')),
      h('button', { type: 'button', class: ['btn', stat.done && 'primary'], disabled: running, 'data-focus-key': 'demo-next', onclick: () => go(1) },
        last ? t('demo.exit') : t('demo.next'), last ? null : icon('chevron', { size: 14, cls: 'flip-rtl' }))));

  clear(root).append(h('div', { class: 'demo-spot', id: 'demo-spot', hidden: true, 'aria-hidden': 'true' }), panel);
  requestAnimationFrame(() => positionSpotlight());
}

// ---------- Spotlight on the real control; the panel moves out of its way ----------
let targetMissing = false;
function findTarget() {
  if (!demo) return null;
  const item = currentItem();
  const sel = item?.target?.(state());
  if (!sel || sel.includes('undefined')) return null;
  let list = [];
  try { list = [...document.querySelectorAll(sel)]; } catch { return null; }
  const visible = list.filter((el) => el.getClientRects().length > 0);
  return visible.find((el) => el.closest('.drawer')) ?? visible.find((el) => !el.closest('[inert]')) ?? visible[0] ?? null;
}

function positionSpotlight() {
  const spot = document.getElementById('demo-spot');
  const panel = document.querySelector('.demo-panel');
  if (!spot || !panel || !demo) return;
  document.querySelectorAll('.demo-target').forEach((el) => el.classList.remove('demo-target'));
  const target = findTarget();
  const wasMissing = targetMissing;
  targetMissing = !target;
  if (!target) { spot.hidden = true; placePanel(panel, null); if (wasMissing !== targetMissing) requestRender(); return; }
  if (scrollTargetOnce) { scrollTargetOnce = false; target.scrollIntoView({ block: 'center', inline: 'nearest' }); }
  target.classList.add('demo-target');
  const r = target.getBoundingClientRect();
  const pad = 6;
  const inlineStart = isRtl() ? window.innerWidth - r.right : r.left;
  Object.assign(spot.style, { insetBlockStart: `${r.top - pad}px`, insetInlineStart: `${inlineStart - pad}px`, inlineSize: `${r.width + pad * 2}px`, blockSize: `${r.height + pad * 2}px` });
  spot.hidden = false;
  placePanel(panel, r);
  if (wasMissing !== targetMissing) requestRender();
}

// Corners tried in order; the first that does not overlap the target wins (a dragged position is kept unless it overlaps).
function placePanel(panel, targetRect) {
  const pw = panel.offsetWidth;
  const ph = panel.offsetHeight;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const m = 12;
  const candidates = [
    dragPos,
    { block: H - ph - m, inline: W - pw - m },
    { block: m, inline: W - pw - m },
    { block: H - ph - m, inline: m },
    { block: m, inline: m },
  ].filter(Boolean);
  const physical = (c) => { const left = isRtl() ? W - c.inline - pw : c.inline; return { left, top: c.block, right: left + pw, bottom: c.block + ph }; };
  const overlaps = (c) => targetRect && !(physical(c).right < targetRect.left || physical(c).left > targetRect.right || physical(c).bottom < targetRect.top || physical(c).top > targetRect.bottom);
  const pick = candidates.find((c) => !overlaps(c)) ?? candidates[candidates.length - 1];
  panel.style.insetBlockStart = `${Math.max(m, Math.min(pick.block, H - ph - m))}px`;
  panel.style.insetInlineStart = `${Math.max(m, Math.min(pick.inline, W - pw - m))}px`;
}

function currentPos(panel) {
  const r = panel.getBoundingClientRect();
  return { block: r.top, inline: isRtl() ? window.innerWidth - r.right : r.left };
}
function dragStart(e) {
  const panel = e.currentTarget.closest('.demo-panel');
  const startPos = currentPos(panel);
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => {
    const dx = ev.clientX - sx;
    dragPos = { block: startPos.block + (ev.clientY - sy), inline: startPos.inline + (isRtl() ? -dx : dx) };
    placePanel(panel, null);
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); positionSpotlight(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
// Keyboard alternative to dragging: arrow keys move the panel (inline arrows follow the reading direction visually).
function keyMove(e) {
  const panel = e.currentTarget.closest('.demo-panel');
  const step = e.shiftKey ? 64 : 16;
  const d = { ArrowUp: [-step, 0], ArrowDown: [step, 0], ArrowLeft: [0, isRtl() ? step : -step], ArrowRight: [0, isRtl() ? -step : step] }[e.key];
  if (!d) return;
  e.preventDefault();
  const p = dragPos ?? currentPos(panel);
  dragPos = { block: p.block + d[0], inline: p.inline + d[1] };
  placePanel(panel, null);
}

export const demoActive = () => !!demo;
