// Minimal DOM builder. Text is always set as text (never parsed as HTML); only icons.js markup is parsed.
// Text passes through localizeData(): an exact seeded demo string (a hospital, a staff name, a demo patient's reported
// text) is shown in the viewer's language; anything a person typed is shown exactly as typed.

import { localizeData } from '../i18n.js';

const BOOLEAN_PROPS = ['disabled', 'hidden', 'required', 'checked', 'selected', 'open', 'multiple'];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'text') el.textContent = localizeData(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (BOOLEAN_PROPS.includes(k)) el[k] = Boolean(v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(localizeData(c))));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

const svgCache = new Map();
export function svg(markup) {
  if (!svgCache.has(markup)) {
    const tpl = document.createElement('template');
    tpl.innerHTML = markup.trim();
    svgCache.set(markup, tpl.content.firstElementChild);
  }
  return svgCache.get(markup).cloneNode(true);
}

let uid = 0;
export const nextUid = (prefix = 'id') => `${prefix}-${++uid}`;
