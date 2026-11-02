// Original inline SVG icons (24×24, stroke = currentColor). Decorative unless a label is given.

import { svg } from './dom.js';

const P = {
  logo: '<path d="M4 12h4l2-5 4 10 2-5h4"/><circle cx="12" cy="12" r="10"/>',
  ambulance: '<path d="M2 16V8a1 1 0 0 1 1-1h10v9"/><path d="M13 10h4l3 3v3h-7"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M7 9.5v3M5.5 11h3"/>',
  person: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21v-1.5A5.5 5.5 0 0 1 10.5 14h3a5.5 5.5 0 0 1 5.5 5.5V21"/>',
  bed: '<path d="M3 18V7M21 18v-5a3 3 0 0 0-3-3h-7v6"/><path d="M3 15h18"/><circle cx="7" cy="11.5" r="1.8"/>',
  broom: '<path d="M14 3l-4 9"/><path d="M6 12h8l2 9H4z"/><path d="M8 16v5M12 16v5"/>',
  cart: '<path d="M4 4h3l2 11h9"/><rect x="9" y="6" width="9" height="6" rx="1"/><circle cx="10" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M6 10h3l1.5-3 2 6 1.5-3H18M9 20h6M12 16v4"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17v.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  dashboard: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  nurse: '<circle cx="12" cy="8" r="3.5"/><path d="M8 4.5h8M12 2.5v3"/><path d="M5 21v-1a6 6 0 0 1 14 0v1"/>',
  staff: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M14 20a4.5 4.5 0 0 1 7-3.7"/>',
  transfer: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1.5 2h5L16 13h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  hourglass: '<path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9"/>',
  stethoscope: '<path d="M6 3v6a5 5 0 0 0 10 0V3"/><path d="M11 14v2a4 4 0 0 0 8 0v-2"/><circle cx="19" cy="12" r="2"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  phone: '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
  hospital: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 7v6M9 10h6M9 21v-4h6v4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 0 0-4V4H3z" transform="translate(0 2)"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
};

export function icon(name, { size = 18, label = null, cls = '' } = {}) {
  const body = P[name] ?? P.info;
  const esc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true" focusable="false"';
  return svg(`<svg class="icon ${cls}" ${a11y} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`);
}

// Small original illustration for incoming ambulance cards.
export function ambulanceIllustration() {
  return svg(`<svg class="illus-ambulance" aria-hidden="true" focusable="false" width="44" height="28" viewBox="0 0 44 28">
    <rect x="1" y="6" width="26" height="15" rx="2.5" fill="#fff" stroke="#0b2340" stroke-width="1.5"/>
    <path d="M27 10h8l6 6v5H27z" fill="#e6f4f3" stroke="#0b2340" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M30 12h4l3.5 3.5H30z" fill="#9fd6d3"/>
    <path d="M12 9.5v8M8 13.5h8" stroke="#b42318" stroke-width="2.2" stroke-linecap="round"/>
    <rect x="3" y="3" width="6" height="3" rx="1" fill="#0f7f7c"/>
    <circle cx="9" cy="22" r="3.2" fill="#0b2340"/><circle cx="34" cy="22" r="3.2" fill="#0b2340"/>
    <circle cx="9" cy="22" r="1.2" fill="#fff"/><circle cx="34" cy="22" r="1.2" fill="#fff"/></svg>`);
}

// Welcome-card illustrations (original artwork; decorative).
export function citizenIllustration() {
  return svg(`<svg class="illus" aria-hidden="true" focusable="false" width="120" height="96" viewBox="0 0 120 96">
    <rect x="4" y="70" width="112" height="20" rx="10" fill="#e6f4f3"/>
    <circle cx="44" cy="30" r="12" fill="#f4d3b5" stroke="#0b2340" stroke-width="2"/>
    <path d="M24 74c0-14 9-24 20-24s20 10 20 24" fill="#0f7f7c" stroke="#0b2340" stroke-width="2"/>
    <circle cx="80" cy="38" r="9" fill="#f4d3b5" stroke="#0b2340" stroke-width="2"/>
    <path d="M66 74c0-11 6-19 14-19s14 8 14 19" fill="#9fd6d3" stroke="#0b2340" stroke-width="2"/>
    <rect x="58" y="44" width="12" height="20" rx="2.5" fill="#fff" stroke="#0b2340" stroke-width="2"/>
    <path d="M61 49h6M61 53h6" stroke="#0f7f7c" stroke-width="2" stroke-linecap="round"/>
    <path d="M92 14c3-5 10-3 9 2-1 4-9 9-9 9s-8-5-9-9c-1-5 6-7 9-2z" fill="#e5484d"/></svg>`);
}

export function ambulanceCardIllustration() {
  return svg(`<svg class="illus" aria-hidden="true" focusable="false" width="132" height="96" viewBox="0 0 132 96">
    <rect x="4" y="76" width="124" height="14" rx="7" fill="#e6f4f3"/>
    <rect x="10" y="30" width="70" height="40" rx="6" fill="#fff" stroke="#0b2340" stroke-width="2.5"/>
    <path d="M80 40h22l16 16v14H80z" fill="#e6f4f3" stroke="#0b2340" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M86 45h14l10 10H86z" fill="#9fd6d3"/>
    <path d="M45 39v22M34 50h22" stroke="#b42318" stroke-width="5" stroke-linecap="round"/>
    <rect x="18" y="22" width="16" height="8" rx="2" fill="#0f7f7c"/>
    <circle cx="30" cy="72" r="9" fill="#0b2340"/><circle cx="100" cy="72" r="9" fill="#0b2340"/>
    <circle cx="30" cy="72" r="3.5" fill="#fff"/><circle cx="100" cy="72" r="3.5" fill="#fff"/></svg>`);
}
