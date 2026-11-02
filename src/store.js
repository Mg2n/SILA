// SILA — persistence and cross-tab sync for the demo.
// localStorage under one key, BroadcastChannel between tabs, `storage` events as the fallback.
// Demo boundary: localStorage cannot provide production-grade transactions or secure multi-user access;
// a real deployment needs a server that owns state, permissions and concurrency control.

import { seed, checkInvariants, SCHEMA_VERSION } from './data.js';
import { bindEngine, dispatch as engineDispatch } from './actions.js';

export const STORAGE_KEY = 'sila.state.v1';
export const CHANNEL_NAME = 'sila-sync';

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
      if (s?.meta?.schemaVersion !== SCHEMA_VERSION || checkInvariants(s).length) return null;
      return s;
    } catch {
      return null;
    }
  };
  const write = (s) => {
    try { storage?.setItem(key, JSON.stringify(s)); return true; } catch { return false; }
  };
  const isNewer = (s) => !!s && (s.meta.epoch !== state.meta.epoch || s.meta.rev > state.meta.rev);
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

  // Load persisted state, or seed when missing, corrupt or from an older schema.
  state = deepFreeze(read() ?? freshSeed());
  write(state);

  let channel = null;
  if (typeof BroadcastChannelImpl === 'function') {
    channel = new BroadcastChannelImpl(channelName);
    channel.onmessage = (e) => {
      const m = e.data;
      if (m?.type === 'state' && m.from !== tabId && isNewer(m.state)) adopt(m.state, 'broadcast', { action: m.action });
    };
  }
  const onStorage = (e) => {
    if (e.key !== key) return;
    const s = read();
    if (isNewer(s)) adopt(s, 'storage-event');
  };
  eventTarget?.addEventListener('storage', onStorage);

  const publish = (s, info) => {
    write(s);
    adopt(s, 'local', info);
    channel?.postMessage({ type: 'state', from: tabId, action: info.action ?? null, state: s });
  };

  // Dispatch always works against the freshest persisted copy so a stale tab cannot overwrite newer state.
  const getFresh = () => {
    const s = read();
    if (isNewer(s)) adopt(s, 'storage');
    return state;
  };
  const binding = { getState: getFresh, commit: (s, info) => publish(s, info), now };

  return {
    tabId,
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
