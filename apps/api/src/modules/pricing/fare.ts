import type { FareBreakdown, FareLine } from '@relay/contracts';
import { config } from '../../config.js';

export interface FareInput {
  distanceM: number;
  durationS: number;
  surgeMultiplier: number;
  poolDiscount?: number; // 0..1
  provider: string;
  fallback: boolean;
}

/**
 * fare = base + km×rate + min×rate + zone_adjustment − discounts, then floor/cap.
 * Computed in fractional minor units and rounded ONCE at the end; a ROUNDING line keeps lines summing to the total.
 */
export function computeFare(i: FareInput, cfg = config.fare, currency = config.currency): FareBreakdown {
  const base = cfg.baseMinor;
  const dist = (i.distanceM / 1000) * cfg.perKmMinor;
  const time = (i.durationS / 60) * cfg.perMinuteMinor;
  const subtotal = base + dist + time;
  const m = Math.max(1, i.surgeMultiplier);
  const zoneAdj = subtotal * (m - 1);
  const discount = i.poolDiscount ? (subtotal + zoneAdj) * i.poolDiscount : 0;
  let raw = subtotal + zoneAdj - discount;
  const lines: FareLine[] = [
    { code: 'BASE', label: 'Base fare', amountMinor: Math.round(base) },
    { code: 'DISTANCE', label: `Distance · ${(i.distanceM / 1000).toFixed(1)} km`, amountMinor: Math.round(dist) },
    { code: 'TIME', label: `Time · ${Math.round(i.durationS / 60)} min`, amountMinor: Math.round(time) },
  ];
  if (zoneAdj > 0) lines.push({ code: 'ZONE_ADJUSTMENT', label: `Zone demand ×${m.toFixed(2)} (simulated)`, amountMinor: Math.round(zoneAdj) });
  if (discount > 0) lines.push({ code: 'POOL_DISCOUNT', label: `Shared ride −${Math.round((i.poolDiscount ?? 0) * 100)}%`, amountMinor: -Math.round(discount) });
  if (raw < cfg.floorMinor) {
    lines.push({ code: 'FLOOR', label: 'Minimum fare adjustment', amountMinor: Math.round(cfg.floorMinor - raw) });
    raw = cfg.floorMinor;
  } else if (raw > cfg.capMinor) {
    lines.push({ code: 'CAP', label: 'Maximum fare cap', amountMinor: -Math.round(raw - cfg.capMinor) });
    raw = cfg.capMinor;
  }
  const totalMinor = Math.round(raw);
  const sum = lines.reduce((a, l) => a + l.amountMinor, 0);
  if (sum !== totalMinor) lines.push({ code: 'ROUNDING', label: 'Rounding', amountMinor: totalMinor - sum });
  return {
    currency,
    lines,
    totalMinor,
    surgeMultiplier: m,
    simulated: true,
    distanceM: Math.round(i.distanceM),
    durationS: Math.round(i.durationS),
    routingProvider: i.provider,
    routeFallback: i.fallback,
  };
}
