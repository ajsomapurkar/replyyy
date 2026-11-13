import type { LatLng } from '@relay/contracts';

/** "Relay Demo City" — synthetic labels on a synthetic street grid. Not a real service area. */
const LAT = [12.985, 12.9575, 12.93];
const LNG = [77.57, 77.595, 77.62, 77.645];
const J = (k: number) => ((Math.sin(k * 12.9898) * 43758.5453) % 1) * 0.0022; // deterministic jitter

const V = LAT.map((lat, r) => LNG.map((lng, c) => {
  const inner = r === 1 && (c === 1 || c === 2);
  return { lat: lat + (inner ? J(r * 7 + c) : 0), lng: lng + (inner ? J(r * 11 + c + 3) : 0) };
}));
const mid = (a: LatLng, b: LatLng, k: number, edge: boolean) => ({ lat: (a.lat + b.lat) / 2 + (edge ? 0 : J(k) * 0.8), lng: (a.lng + b.lng) / 2 + (edge ? 0 : J(k + 50) * 0.8) });
const H = V.map((row, r) => row.slice(0, -1).map((v, c) => mid(v, row[c + 1], r * 5 + c + 100, r === 0 || r === 2)));
const W = V.slice(0, -1).map((row, r) => row.map((v, c) => mid(v, V[r + 1][c], r * 9 + c + 200, c === 0 || c === 3)));

function poly(r: number, c: number): LatLng[] {
  return [V[r][c], H[r][c], V[r][c + 1], W[r][c + 1], V[r + 1][c + 1], H[r + 1][c], V[r + 1][c], W[r][c], V[r][c]];
}

export const ZONES = [
  { code: 'OLD', name: 'Old Town', r: 0, c: 0, speed: 16 },
  { code: 'TECH', name: 'Tech Park', r: 0, c: 1, speed: 20 },
  { code: 'UNIV', name: 'University', r: 0, c: 2, speed: 24 },
  { code: 'HARB', name: 'Harbor', r: 1, c: 0, speed: 26 },
  { code: 'MRKT', name: 'Market', r: 1, c: 1, speed: 18 },
  { code: 'AIRP', name: 'Airport Link', r: 1, c: 2, speed: 34 },
].map((z) => ({ ...z, polygon: poly(z.r, z.c) }));

/** Point inside a zone's bounding cell by fraction (fx west→east, fy north→south). */
export function inZone(code: string, fx: number, fy: number): LatLng {
  const z = ZONES.find((x) => x.code === code)!;
  const lat = LAT[z.r] + (LAT[z.r + 1] - LAT[z.r]) * fy;
  const lng = LNG[z.c] + (LNG[z.c + 1] - LNG[z.c]) * fx;
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

export const PLACES: { label: string; zone: string; fx: number; fy: number }[] = [
  { label: 'Clocktower Square', zone: 'OLD', fx: 0.72, fy: 0.55 },
  { label: 'Lantern Lane', zone: 'OLD', fx: 0.3, fy: 0.3 },
  { label: 'Old Mill Library', zone: 'OLD', fx: 0.35, fy: 0.62 },
  { label: 'Fort Gate', zone: 'OLD', fx: 0.6, fy: 0.18 },
  { label: 'Tech Park Gate 2', zone: 'TECH', fx: 0.3, fy: 0.4 },
  { label: 'Orbit Towers', zone: 'TECH', fx: 0.62, fy: 0.55 },
  { label: 'Innovation Plaza', zone: 'TECH', fx: 0.75, fy: 0.25 },
  { label: 'Data Bay', zone: 'TECH', fx: 0.45, fy: 0.78 },
  { label: 'University Main Gate', zone: 'UNIV', fx: 0.25, fy: 0.5 },
  { label: 'Science Block', zone: 'UNIV', fx: 0.6, fy: 0.3 },
  { label: 'Hostel Circle', zone: 'UNIV', fx: 0.7, fy: 0.7 },
  { label: 'Botanical Walk', zone: 'UNIV', fx: 0.45, fy: 0.2 },
  { label: 'Harbor Pier 3', zone: 'HARB', fx: 0.25, fy: 0.7 },
  { label: 'Lighthouse Road', zone: 'HARB', fx: 0.5, fy: 0.4 },
  { label: 'Ferry Terminal', zone: 'HARB', fx: 0.7, fy: 0.75 },
  { label: 'Boatyard Café', zone: 'HARB', fx: 0.3, fy: 0.3 },
  { label: 'Central Market', zone: 'MRKT', fx: 0.5, fy: 0.45 },
  { label: 'Spice Arcade', zone: 'MRKT', fx: 0.3, fy: 0.7 },
  { label: 'Weavers Street', zone: 'MRKT', fx: 0.7, fy: 0.3 },
  { label: 'Metro Interchange', zone: 'MRKT', fx: 0.7, fy: 0.75 },
  { label: 'Airport Link Station', zone: 'AIRP', fx: 0.3, fy: 0.4 },
  { label: 'Cargo Village', zone: 'AIRP', fx: 0.7, fy: 0.7 },
  { label: 'Skyline Hotel', zone: 'AIRP', fx: 0.55, fy: 0.25 },
  { label: 'Runway View Park', zone: 'AIRP', fx: 0.8, fy: 0.45 },
];
export const placePoint = (label: string) => {
  const p = PLACES.find((x) => x.label === label)!;
  return inZone(p.zone, p.fx, p.fy);
};
export const DEMO_HUB = 'Clocktower Square';
export const DEMO_DESTINATION = 'Orbit Towers';
export const HUB_EXCLUSION_M = 1300;
export const CITY_BOUNDS = { north: LAT[0], south: LAT[2], west: LNG[0], east: LNG[3] };
