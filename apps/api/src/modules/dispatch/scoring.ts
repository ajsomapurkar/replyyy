import type { ReasonCode, ScoreComponents } from '@relay/contracts';
import { config } from '../../config.js';

export interface RankInput {
  driverId: string;
  etaSeconds: number;
  roadDistanceM: number;
  idleMinutes: number;
  recentTrips: number;
  reliability: number; // 0..1 acceptance rate
  routeFallback: boolean;
}
export interface Ranked extends RankInput {
  components: ScoreComponents;
  score: number;
  rank: number;
  reasonCodes: ReasonCode[];
}
export type Weights = Record<keyof ScoreComponents, number>;
export type Strategy = 'NEAREST' | 'ETA_ONLY' | 'ETA_FAIRNESS';

/** Min-max normalise to [0,1]; identical values map to 0 (no one is penalised). */
export function normalize(values: number[]): number[] {
  const min = Math.min(...values), max = Math.max(...values);
  if (!values.length || max - min < 1e-9) return values.map(() => 0);
  return values.map((v) => (v - min) / (max - min));
}

/**
 * score = 0.55·eta + 0.15·distance + 0.10·workload + 0.10·reliability_penalty − 0.10·idle_bonus   (lower is better)
 * All components are normalised among the current candidates.
 */
export function rankCandidates(cands: RankInput[], weights: Weights = config.dispatch.weights, strategy: Strategy = 'ETA_FAIRNESS'): Ranked[] {
  if (!cands.length) return [];
  const eta = normalize(cands.map((c) => c.etaSeconds));
  const dist = normalize(cands.map((c) => c.roadDistanceM));
  const work = normalize(cands.map((c) => c.recentTrips));
  const idleCap = config.dispatch.idleCapMinutes;
  const idle = cands.map((c) => Math.min(c.idleMinutes, idleCap) / idleCap);
  const w: Weights =
    strategy === 'ETA_ONLY' ? { pickupEta: 1, roadDistance: 0, workload: 0, reliabilityPenalty: 0, idleBonus: 0 }
    : strategy === 'NEAREST' ? { pickupEta: 0, roadDistance: 1, workload: 0, reliabilityPenalty: 0, idleBonus: 0 }
    : weights;
  const scored = cands.map((c, i) => {
    const components: ScoreComponents = {
      pickupEta: eta[i],
      roadDistance: dist[i],
      workload: work[i],
      reliabilityPenalty: Math.max(0, Math.min(1, 1 - c.reliability)),
      idleBonus: idle[i],
    };
    const score =
      w.pickupEta * components.pickupEta +
      w.roadDistance * components.roadDistance +
      w.workload * components.workload +
      w.reliabilityPenalty * components.reliabilityPenalty -
      w.idleBonus * components.idleBonus;
    return { ...c, components, score: Number(score.toFixed(4)) };
  });
  scored.sort((a, b) => a.score - b.score || a.etaSeconds - b.etaSeconds || a.driverId.localeCompare(b.driverId));
  const minEta = Math.min(...cands.map((c) => c.etaSeconds));
  const minDist = Math.min(...cands.map((c) => c.roadDistanceM));
  return scored.map((s, i) => {
    const reasonCodes: ReasonCode[] = [];
    if (s.etaSeconds === minEta) reasonCodes.push('LOWEST_PICKUP_ETA');
    if (s.roadDistanceM === minDist) reasonCodes.push('SHORT_ROAD_DISTANCE');
    if (s.idleMinutes >= config.dispatch.longIdleMinutes) reasonCodes.push('LONG_IDLE_TIME');
    if (s.reliability >= 0.9) reasonCodes.push('HIGH_RELIABILITY');
    if (cands.length > 1 && Math.max(...cands.map((c) => c.recentTrips)) > s.recentTrips && s.components.workload === 0) reasonCodes.push('LOW_RECENT_WORKLOAD');
    if (s.routeFallback) reasonCodes.push('ROUTE_FALLBACK');
    return { ...s, rank: i + 1, reasonCodes };
  });
}

const mins = (s: number) => Math.max(1, Math.round(s / 60));

/** A plain-language sentence for the operator — never just a number. */
export function explain(ranked: Ranked[], names: Record<string, string>, eligibleCount: number, consideredCount: number): string {
  if (!ranked.length) {
    return consideredCount
      ? `No driver could be offered this ride: all ${consideredCount} nearby drivers failed an eligibility rule.`
      : 'No drivers were found within the search radius.';
  }
  const a = ranked[0];
  const parts = [`${names[a.driverId]} was offered this ride: ~${mins(a.etaSeconds)} min estimated pickup`];
  if (a.reasonCodes.includes('LOWEST_PICKUP_ETA')) parts[0] += ` (fastest of ${eligibleCount} eligible)`;
  parts.push(`${(a.roadDistanceM / 1000).toFixed(1)} km by road`);
  if (a.reasonCodes.includes('LONG_IDLE_TIME')) parts.push(`idle ${Math.round(a.idleMinutes)} min, which earned a fairness bonus`);
  let s = parts.join(', ') + '.';
  const b = ranked[1];
  if (b) {
    const d = b.etaSeconds - a.etaSeconds;
    s += ` Runner-up ${names[b.driverId]} ${d > 30 ? `was ${mins(d)} min slower to pickup` : d < -30 ? `was ${mins(-d)} min faster but scored lower on fairness/reliability` : 'had a similar ETA but a weaker overall score'}.`;
  }
  if (a.routeFallback) s += ' Routing was unavailable, so ETAs use the labeled fallback speed model.';
  return s;
}
