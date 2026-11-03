// SILA — persistence and cross-tab sync for the demo.
// localStorage under one key, BroadcastChannel between tabs, `storage` events as the fallback.
// Demo boundary: localStorage cannot provide production-grade transactions or secure multi-user access;
// a real deployment needs a server that owns state, permissions and concurrency control.

import { seed, checkInvariants, SCHEMA_VERSION, COLLECTIONS } from './data.js';
import { bindEngine, dispatch as engineDispatch } from './actions.js';

export const STORAGE_KEY = 'sila.state.v1';
export const CHANNEL_NAME = 'sila-sync';

// Saved data must carry every collection and its sync metadata; a well-formed but hollow object is not a demo state.
const complete = (s) => !!s && typeof s.meta?.epoch === 'string' && Number.isFinite(s.meta?.rev)
  && COLLECTIONS.every((c) => s[c] && typeof s[c] === 'object' && !Array.isArray(s[c]));
const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = '__sila_probe__';
    s.setItem(probe, '1');
    const works = s.getItem(probe) === '1';
    s.removeItem(probe);
    return works ? s : null;
  } catch {
    return null; // private mode / blocked storage: run in memory, tabs still sync over BroadcastChannel
  }
}

export function createStore({
  key = STORAGE_KEY,
  channelName = CHANNEL_NAME,
  storage = defaultStorage(),
  now = () => new Date().toISOString(),
  BroadcastChannelImpl = globalThis.BroadcastChannel,
  eventTarget = globalThis.addEventListener ? globalThis : null,
} = {}) {
  const tabId = randomId();
  const subscribers = new Set();
  let state;

  const read = () => {
    try {
      const raw = storage?.getItem(key);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s?.meta?.schemaVersion !== SCHEMA_VERSION || !complete(s) || checkInvariants(s).length) return null;
      return s;
    } catch {
      return null;
    }
  };
  const write = (s) => {
    try { storage?.setItem(key, JSON.stringify(s)); return true; } catch { return false; }
  };
  // Two tabs can commit the same revision at the same instant; each commit carries an id and the persisted copy
  // decides which one stands. Anything that differs from what this tab holds is adopted from storage.
  const differs = (s) => !!s && (s.meta.epoch !== state.meta.epoch || s.meta.rev !== state.meta.rev || s.meta.commitId !== state.meta.commitId);
  const isNewer = (s) => !!s && (s.meta.epoch !== state.meta.epoch || s.meta.rev > state.meta.rev);
  let lastCommit = null; // { rev, commitId, action } of this tab's latest write, until confirmed or found overwritten
  const emit = (source, info = {}) => {
    for (const fn of [...subscribers]) {
      try { fn(state, { source, ...info }); } catch (e) { console.error('SILA subscriber failed', e); }
    }
  };
  const adopt = (s, source, info) => {
    state = deepFreeze(s);
    emit(source, info);
  };
  const freshSeed = () => {
    const s = seed(now());
    s.meta.epoch = randomId();
    return s;
  };

  // Load persisted state, or seed when missing, damaged or from an older schema. A damaged or outdated copy is
  // reported (recoveredFrom) so the UI can say why the demo restarted instead of failing silently.
  let recoveredFrom = null;
  const initial = () => {
    let raw = null;
    try { raw = storage?.getItem(key); } catch { return null; }
    if (!raw) return null;
    try {
      const s = JSON.parse(raw);
      if (s?.meta?.schemaVersion !== SCHEMA_VERSION) { recoveredFrom = 'old-schema'; return null; }
      if (!complete(s) || checkInvariants(s).length) { recoveredFrom = 'invalid'; return null; }
      return s;
    } catch {
      recoveredFrom = 'corrupt';
      return null;
    }
  };
  state = deepFreeze(initial() ?? freshSeed());
  write(state);

  let channel = null;
  if (typeof BroadcastChannelImpl === 'function') {
    channel = new BroadcastChannelImpl(channelName);
    channel.onmessage = (e) => {
      const m = e.data;
      if (m?.type !== 'state' || m.from === tabId) return;
      if (lastCommit && m.state.meta.rev === lastCommit.rev) { sync('broadcast'); return; } // a same-revision race: storage decides
      if (isNewer(m.state)) adopt(m.state, 'broadcast', { action: m.action });
    };
  }
  // Adopt the persisted copy when it differs from ours; if it replaced this tab's own latest write (two tabs
  // committed the same revision at once), report that the change was lost instead of letting the UI claim success.
  function sync(source) {
    const cur = read();
    if (!differs(cur)) { if (cur && lastCommit && cur.meta.commitId === lastCommit.commitId) lastCommit = null; return; }
    const lost = lastCommit && cur.meta.epoch === state.meta.epoch && cur.meta.rev === lastCommit.rev && cur.meta.commitId !== lastCommit.commitId;
    const action = lastCommit?.action ?? null;
    if (lost || (lastCommit && cur.meta.rev > lastCommit.rev)) lastCommit = null;
    if (lost) adopt(cur, 'conflict-lost', { action });
    else if (cur.meta.epoch !== state.meta.epoch || cur.meta.rev >= state.meta.rev) adopt(cur, source);
  }
  const onStorage = (e) => {
    if (e.key !== key) return;
    sync('storage-event');
  };
  eventTarget?.addEventListener('storage', onStorage);

  const publish = (s, info) => {
    s.meta.commitId = randomId();
    write(s);
    adopt(s, 'local', info);
    channel?.postMessage({ type: 'state', from: tabId, action: info.action ?? null, state: s });
  };

  // Dispatch always works against the freshest persisted copy so a stale tab cannot overwrite newer state.
  const getFresh = () => {
    sync('storage');
    return state;
  };
  // localStorage has no compare-and-swap: re-check right before writing and refuse if another tab committed since
  // this action read its state; afterwards confirm our write was not overwritten by a commit at the same instant.
  const commit = (s, info) => {
    const cur = read();
    if (differs(cur)) { adopt(cur, 'storage'); return false; }
    publish(s, info);
    lastCommit = { rev: s.meta.rev, commitId: s.meta.commitId, action: info?.action ?? null };
    setTimeout(() => sync('storage'), 60);
    return true;
  };
  const binding = { getState: getFresh, commit, now };

  return {
    tabId,
    recoveredFrom,
    getState: () => state,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    dispatch(actionName, payload, user) {
      bindEngine(binding);
      return engineDispatch(actionName, payload, user);
    },
    bind() { bindEngine(binding); },
    sync() { sync('storage'); },
    resetDemo() {
      publish(freshSeed(), { action: 'resetDemo' });
      return state;
    },
    close() {
      channel?.close();
      eventTarget?.removeEventListener('storage', onStorage);
      subscribers.clear();
    },
  };
}

// App-wide singleton, created on first use so importing this module has no side effects.
let appStore = null;
export function getStore(options) {
  if (!appStore) {
    appStore = createStore(options);
    appStore.bind();
  }
  return appStore;
}

export function resetDemo() {
  return getStore().resetDemo();
}
