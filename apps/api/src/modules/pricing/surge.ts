import { config } from '../../config.js';

/**
 * Bounded, smoothed, banded multiplier from demand/supply ratio (SIMULATED pricing).
 * target = clamp(1 + sensitivity × (ratio − 1), min, max)
 * next   = prev + smoothing × (target − prev), ignored if inside the no-change band, snapped to step.
 */
export function targetMultiplier(ratio: number, c = config.surge): number {
  if (!Number.isFinite(ratio) || ratio <= 1) return c.min;
  return Math.min(c.max, Math.max(c.min, 1 + c.sensitivity * (ratio - 1)));
}
export function nextMultiplier(prev: number, ratio: number, c = config.surge): { multiplier: number; target: number } {
  const target = targetMultiplier(ratio, c);
  const smoothed = prev + c.smoothing * (target - prev);
  if (Math.abs(smoothed - prev) < c.noChangeBand && Math.abs(target - prev) < c.noChangeBand * 2) return { multiplier: prev, target };
  const snapped = Math.round(smoothed / c.step) * c.step;
  return { multiplier: Math.min(c.max, Math.max(c.min, Number(snapped.toFixed(2)))), target };
}
