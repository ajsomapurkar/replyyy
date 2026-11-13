import type { LatLng } from '@relay/contracts';
import type { Ctx } from '../../common/context.js';
import type { Queryable } from '../../database/db.js';
import { zoneForPoint } from '../zones/zones.cache.js';
import { computeFare } from './fare.js';
import { config } from '../../config.js';

export async function zoneMultiplier(db: Queryable, zoneId: string | undefined): Promise<number> {
  if (!zoneId) return 1;
  const { rows } = await db.query(`select multiplier from zone_pricing_state where zone_id=$1`, [zoneId]);
  return rows[0]?.multiplier ?? 1;
}

export async function quoteTrip(ctx: Ctx, pickup: LatLng, destination: LatLng, opts: { pool?: boolean } = {}) {
  const route = await ctx.routing.route(pickup, destination);
  const zone = zoneForPoint(pickup);
  const m = await zoneMultiplier(ctx.db, zone?.id);
  const fare = computeFare({
    distanceM: route.distanceM,
    durationS: route.durationS,
    surgeMultiplier: m,
    poolDiscount: opts.pool ? config.pool.discount : 0,
    provider: route.provider,
    fallback: route.fallback,
  });
  return { route, fare, pickupZone: zone ?? null, destinationZone: zoneForPoint(destination) ?? null };
}
