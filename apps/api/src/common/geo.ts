import type { LatLng } from '@relay/contracts';

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Grid ("Manhattan") distance — the mock road network is a street grid. */
export function gridDistanceM(a: LatLng, b: LatLng): number {
  return haversineM(a, { lat: a.lat, lng: b.lng }) + haversineM({ lat: a.lat, lng: b.lng }, b);
}

export function pointInPolygon(p: LatLng, poly: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng, yi = poly[i].lat, xj = poly[j].lng, yj = poly[j].lat;
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Move along an L-shaped grid path (longitude leg first, then latitude) by `meters`. */
export function stepAlongGrid(from: LatLng, to: LatLng, meters: number): { pos: LatLng; arrived: boolean; heading: number } {
  let remaining = meters;
  let pos = { ...from };
  const lngLeg = haversineM(pos, { lat: pos.lat, lng: to.lng });
  if (lngLeg > 1) {
    const heading = to.lng > pos.lng ? 90 : 270;
    if (remaining < lngLeg) {
      const f = remaining / lngLeg;
      return { pos: { lat: pos.lat, lng: pos.lng + (to.lng - pos.lng) * f }, arrived: false, heading };
    }
    remaining -= lngLeg;
    pos = { lat: pos.lat, lng: to.lng };
  }
  const latLeg = haversineM(pos, to);
  const heading = to.lat > pos.lat ? 0 : 180;
  if (remaining < latLeg) {
    const f = remaining / latLeg;
    return { pos: { lat: pos.lat + (to.lat - pos.lat) * f, lng: to.lng }, arrived: false, heading };
  }
  return { pos: { ...to }, arrived: true, heading };
}
