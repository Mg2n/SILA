// SILA — pure helpers for the fictional demo city: GPS → grid, nearest district, simulated distance and travel time.

import { DEMO_BOUNDS, DEMO_GRID, DISTRICTS, TRAVEL } from './config.js';

export function insideDemoArea(lat, lng) {
  const b = DEMO_BOUNDS;
  return lat <= b.north && lat >= b.south && lng >= b.west && lng <= b.east;
}

// Converts a GPS fix to a grid point. Outside the demo area → { outside: true, point: nearest district }.
export function pointFromGeo(lat, lng) {
  const b = DEMO_BOUNDS;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const x = ((clamp(lng, b.west, b.east) - b.west) / (b.east - b.west)) * DEMO_GRID.width;
  const y = ((b.north - clamp(lat, b.south, b.north)) / (b.north - b.south)) * DEMO_GRID.height;
  if (insideDemoArea(lat, lng)) return { outside: false, point: { x, y }, district: nearestDistrict({ x, y }) };
  const d = nearestDistrict({ x, y });
  return { outside: true, point: { x: d.x, y: d.y }, district: d };
}

export function nearestDistrict(point) {
  return DISTRICTS.reduce((best, d) => (dist(point, d) < dist(point, best) ? d : best), DISTRICTS[0]);
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Simulated road distance (km, one decimal) and travel time (whole minutes) for a transport mode.
export function simulatedTrip(from, to, mode = 'unknown') {
  const km = Math.round(dist(from, to) * TRAVEL.roadFactor * 10) / 10;
  const m = TRAVEL[mode] ?? TRAVEL.unknown;
  return { km, minutes: Math.round(m.fixed + m.perKm * km) };
}
