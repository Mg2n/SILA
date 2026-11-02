// Illustrative SVG map of the fictional demo city (simulated). Hospital markers are keyboard-focusable buttons
// kept in sync with the hospital list. Geography is never mirrored for right-to-left layouts.

import { DISTRICTS, DEMO_GRID } from '../config.js';
import { t } from '../i18n.js';

const NS = 'http://www.w3.org/2000/svg';
const K = 10; // px per km
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

/** cityMap({ hospitals: [{ id, shortName, name, position, trip? }], point, selectedId, onSelect }) */
export function cityMap({ hospitals, point, selectedId, onSelect }) {
  const W = DEMO_GRID.width * K;
  const H = DEMO_GRID.height * K;
  const selected = hospitals.find((h) => h.id === selectedId);
  const svg = s('svg', { class: 'city-map', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': t('hospitals.mapLabel'), dir: 'ltr' },
    s('rect', { x: 0, y: 0, width: W, height: H, rx: 8, class: 'land' }),
    s('path', { d: `M${W} ${H * 0.62} C ${W * 0.86} ${H * 0.7}, ${W * 0.84} ${H * 0.86}, ${W * 0.7} ${H} L ${W} ${H} Z`, class: 'sea' }),
    s('path', { d: `M0 ${H * 0.45} C ${W * 0.3} ${H * 0.4}, ${W * 0.6} ${H * 0.55}, ${W} ${H * 0.35}`, class: 'road' }),
    s('path', { d: `M${W * 0.45} 0 C ${W * 0.48} ${H * 0.4}, ${W * 0.4} ${H * 0.7}, ${W * 0.5} ${H}`, class: 'road' }),
    s('path', { d: `M${W * 0.1} ${H} C ${W * 0.25} ${H * 0.7}, ${W * 0.7} ${H * 0.75}, ${W * 0.95} ${H * 0.15}`, class: 'road minor' }),
    DISTRICTS.filter((d) => !point || Math.hypot(d.x - point.x, d.y - point.y) > 1.5).map((d) => s('text', { x: d.x * K, y: d.y * K, class: 'district-label', 'text-anchor': 'middle', 'aria-hidden': 'true' }, t(`district.${d.id}`))),
    point && selected ? s('line', { x1: point.x * K, y1: point.y * K, x2: selected.position.x * K, y2: selected.position.y * K, class: 'route' }) : null,
    point ? s('g', { class: 'you', 'aria-hidden': 'true' },
      s('circle', { cx: point.x * K, cy: point.y * K, r: 6 }), s('circle', { cx: point.x * K, cy: point.y * K, r: 2.5, class: 'dot' }),
      s('text', { x: point.x * K, y: point.y * K - 10, 'text-anchor': 'middle' }, t('hospitals.you'))) : null,
    hospitals.map((h) => {
      const x = h.position.x * K;
      const y = h.position.y * K;
      const g = s('g', { class: ['marker', h.id === selectedId ? 'selected' : ''].join(' '), tabindex: 0, role: 'button',
        'aria-pressed': String(h.id === selectedId), 'data-focus-key': `map:${h.id}`,
        'aria-label': h.trip ? `${h.name}, ${t('hospitals.distance', { km: h.trip.km })} (${t('hospitals.simulated')})` : h.name },
        s('circle', { cx: x, cy: y, r: 9 }),
        s('path', { d: `M${x} ${y - 4.5}v9M${x - 4.5} ${y}h9`, class: 'cross' }),
        s('text', { x, y: y + 20, 'text-anchor': 'middle' }, h.shortName));
      g.addEventListener('click', () => onSelect(h.id));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(h.id); } });
      return g;
    }));
  return svg;
}
