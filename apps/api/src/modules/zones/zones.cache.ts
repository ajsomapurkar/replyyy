import type { LatLng } from '@relay/contracts';
import type { Queryable } from '../../database/db.js';
import { pointInPolygon } from '../../common/geo.js';

export interface ZoneInfo {
  id: string;
  code: string;
  name: string;
  polygon: LatLng[];
  centroid: LatLng;
  baseSpeedKmh: number;
}

let zones: ZoneInfo[] = [];

export async function loadZones(db: Queryable): Promise<ZoneInfo[]> {
  const { rows } = await db.query(
    `select id, code, name, base_speed_kmh, ST_AsGeoJSON(boundary) as b, ST_Y(centroid::geometry) lat, ST_X(centroid::geometry) lng
       from zones where active order by code`,
  );
  zones = rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    baseSpeedKmh: Number(r.base_speed_kmh),
    centroid: { lat: r.lat, lng: r.lng },
    polygon: (JSON.parse(r.b).coordinates[0] as [number, number][]).map(([lng, lat]) => ({ lat, lng })),
  }));
  return zones;
}
export const getZones = () => zones;
export const zoneById = (id: string | null | undefined) => zones.find((z) => z.id === id);
export function zoneForPoint(p: LatLng): ZoneInfo | undefined {
  return zones.find((z) => pointInPolygon(p, z.polygon));
}
export function setZonesForTest(z: ZoneInfo[]) {
  zones = z;
}
