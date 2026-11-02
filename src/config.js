// SILA — demo configuration. Region contact and the fictional demo city used for simulated maps and distances.

// Emergency-services contact for the selected region. VERIFY BEFORE DEMO: confirm the correct public number for
// the audience's region. SILA never dials it; the UI only shows it with "call from your phone".
export const REGION = {
  region: 'SA',
  number: '997',
  verified: false, // shown as "verify before demo" until someone checks it
};

// A fictional city laid out on a 20 km × 16 km grid. Hospitals and districts use grid coordinates (km).
// A real GPS fix is only used if it falls inside DEMO_BOUNDS; otherwise the UI snaps to the nearest demo district.
export const DEMO_GRID = { width: 20, height: 16 };
export const DEMO_BOUNDS = { north: 24.80, south: 24.66, west: 46.58, east: 46.78 };

export const DISTRICTS = [
  { id: 'al-noor', x: 6.5, y: 4.5 },
  { id: 'university', x: 15.5, y: 2.5 },
  { id: 'old-town', x: 10.8, y: 9.6 },
  { id: 'al-safa', x: 2.2, y: 14.8 },
  { id: 'harbour', x: 13.5, y: 12.5 },
  { id: 'coastal', x: 18.5, y: 14.5 },
];

// Simulated travel model (minutes = fixed + per-km × road distance). Labelled "Simulated" everywhere it is shown.
export const TRAVEL = {
  roadFactor: 1.3,
  private_car: { fixed: 3, perKm: 2 },
  taxi: { fixed: 8, perKm: 2 },
  walking: { fixed: 0, perKm: 12 },
  unknown: { fixed: 3, perKm: 2 },
  ambulance: { fixed: 1, perKm: 1.5 }, // simulated: lights and sirens, no parking
};
