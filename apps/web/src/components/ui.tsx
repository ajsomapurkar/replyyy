import { useEffect, useRef, type ReactNode } from 'react';
import { formatDistance, formatDuration, formatMoney, REASON_LABELS, STATUS_LABELS, statusTone, type DispatchDecision, type FareBreakdown as Fare, type RideStatus } from '@relay/contracts';
import { AlertTriangle, CheckCircle2, CircleDot, Clock, Loader2, Radio, WifiOff, XCircle } from 'lucide-react';
import { useConnection, useNow, type ConnState } from '../lib/api';

export function StatusBadge({ status, size }: { status: RideStatus; size?: 'lg' }) {
  const tone = statusTone(status);
  const Icon = tone === 'green' ? CheckCircle2 : tone === 'red' ? XCircle : tone === 'amber' ? AlertTriangle : tone === 'blue' ? Loader2 : CircleDot;
  return (
    <span className={`badge tone-${tone} ${size ?? ''}`}>
      <Icon size={size ? 15 : 12} className={tone === 'blue' ? 'spin-slow' : ''} aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function MetricCard({ label, value, hint, tone, unit }: { label: string; value: ReactNode; hint?: string; tone?: string; unit?: string }) {
  return (
    <div className={`metric ${tone ? 'tone-' + tone : ''}`} title={hint}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}{unit && <span className="metric-unit">{unit}</span>}</div>
      {hint && <div className="metric-hint">{hint}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return <div className="empty">{icon}<div className="empty-title">{title}</div>{body && <p>{body}</p>}{action}</div>;
}

export function Skeleton({ h = 16, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} />;
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <AlertTriangle size={18} /> <span>{(error as Error)?.message ?? 'Something went wrong'}</span>
      {retry && <button className="btn sm ghost" onClick={retry}>Retry</button>}
    </div>
  );
}

const CONN: Record<ConnState, [string, string]> = { live: ['Live', 'green'], connecting: ['Connecting', 'blue'], reconnecting: ['Reconnecting…', 'amber'], offline: ['Offline', 'red'] };
export function ConnectionIndicator() {
  const s = useConnection();
  const [label, tone] = CONN[s];
  return (
    <span className={`conn tone-${tone}`} role="status" aria-live="polite">
      {s === 'offline' ? <WifiOff size={13} /> : <Radio size={13} className={s === 'live' ? 'pulse' : ''} />} {label}
    </span>
  );
}

export function DataFreshnessLabel({ at, staleAfter = 30 }: { at?: string | number | Date | null; staleAfter?: number }) {
  const now = useNow(1000);
  if (!at) return <span className="fresh stale">No data</span>;
  const age = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  return <span className={`fresh ${age > staleAfter ? 'stale' : ''}`}><Clock size={11} /> {age > staleAfter ? `Stale · ${formatDuration(age)} ago` : age < 3 ? 'Just now' : `${age}s ago`}</span>;
}

export function ConfirmDialog({ open, title, body, confirmLabel, danger, onConfirm, onCancel, children }: { open: boolean; title: string; body?: string; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; children?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => { e.preventDefault(); onCancel(); }} aria-labelledby="dlg-title">
      <h3 id="dlg-title">{title}</h3>
      {body && <p>{body}</p>}
      {children}
      <div className="dialog-actions">
        <button className="btn ghost" onClick={onCancel}>Keep as is</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} autoFocus>{confirmLabel}</button>
      </div>
    </dialog>
  );
}

export function FareBreakdown({ fare, compact }: { fare: Fare; compact?: boolean }) {
  return (
    <div className={`fare ${compact ? 'compact' : ''}`}>
      {fare.lines.map((l, i) => (
        <div key={i} className={`fare-line ${l.amountMinor < 0 ? 'neg' : ''} ${l.code === 'ZONE_ADJUSTMENT' ? 'sim' : ''}`}>
          <span>{l.label}</span><span className="num">{l.amountMinor < 0 ? '−' : ''}{formatMoney(Math.abs(l.amountMinor), fare.currency)}</span>
        </div>
      ))}
      <div className="fare-total"><span>Estimated total</span><span className="num">{formatMoney(fare.totalMinor, fare.currency)}</span></div>
      <div className="fare-note">Simulated demo pricing · {fare.routingProvider === 'mock-grid-v1' ? 'mock road model' : fare.routingProvider}{fare.routeFallback ? ' · fallback ETA' : ''}. The quoted price is what you pay.</div>
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  CREATED: 'Ride requested', OFFER_SENT: 'Offer sent', OFFER_WITHDRAWN: 'Offer withdrawn', POOL_RIDER_JOINED: 'Co-rider joined', EXCEPTION_FLAGGED: 'Exception flagged',
  EXCEPTION_CLEARED: 'Exception cleared', POOL_OPT_IN: 'Opted into shared ride', SCENARIO_SEEDED: 'Demo scenario created',
};
const REASON_TEXT: Record<string, string> = {
  DISPATCH_STARTED: 'Searching for the best eligible driver', RETRYING_NEXT_CANDIDATE: 'Offering the next candidate', DRIVER_REJECTED: 'Driver declined the offer',
  OFFER_TIMEOUT: 'Driver did not respond in time', DRIVER_ACCEPTED: 'Driver accepted', DRIVER_ACCEPTED_POOL: 'Driver accepted (shared ride)', DRIVER_AT_PICKUP: 'Driver at pickup',
  TRIP_STARTED: 'Trip started', TRIP_COMPLETED: 'Trip completed', RIDER_CANCELLED: 'Rider cancelled', OPERATOR_CANCELLED: 'Operator cancelled', NO_ELIGIBLE_DRIVERS: 'No eligible driver',
  MAX_OFFER_ATTEMPTS: 'Too many unanswered offers', DRIVER_CANCELLED: 'Driver cancelled after accepting', OPERATOR_REASSIGN: 'Operator reassigned', DRIVER_LOCATION_STALE: 'Driver GPS went stale',
  DRIVER_OFFLINE: 'Driver went offline', DELAYED_ARRIVAL: 'Driver running late', DRIVER_UNREACHABLE: 'Driver unreachable', DRIVER_RECONNECTED: 'Driver reconnected', PASSENGER_RETRY: 'Retry requested',
  POOL_MATCH: 'Shared-ride match', POOL_PLAN_STALE: 'Shared route changed', OPERATOR_RESOLVED: 'Resolved by operator', RIDE_CANCELLED: 'Ride cancelled',
};
export function RideTimeline({ events }: { events: any[] }) {
  if (!events.length) return <EmptyState title="No events yet" />;
  return (
    <ol className="timeline">
      {events.map((e) => {
        const title = e.type === 'STATUS_CHANGED' ? STATUS_LABELS[e.to as RideStatus] ?? e.to : EVENT_LABEL[e.type] ?? e.type;
        const tone = e.to ? statusTone(e.to) : e.type.includes('EXCEPTION') ? 'amber' : 'neutral';
        return (
          <li key={e.id} className={`tl tone-${tone}`}>
            <div className="tl-dot" />
            <div className="tl-body">
              <div className="tl-head"><strong>{title}</strong><time>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div>
              {e.reason && <div className="tl-reason">{REASON_TEXT[e.reason] ?? e.reason}{e.actorName ? ` · ${e.actorName}` : ''}</div>}
              {e.type === 'OFFER_SENT' && e.metadata?.etaSeconds != null && <div className="tl-meta">#{e.metadata.sequence} · ETA {formatDuration(e.metadata.etaSeconds)}{e.metadata.score != null ? ` · score ${Number(e.metadata.score).toFixed(3)}` : ''}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const COMP_LABELS: [string, string, number][] = [['pickupEta', 'Pickup ETA', 1], ['roadDistance', 'Road distance', 1], ['workload', 'Recent workload', 1], ['reliabilityPenalty', 'Reliability penalty', 1], ['idleBonus', 'Idle-time bonus', -1]];
export function DecisionCard({ decision, compact }: { decision: DispatchDecision; compact?: boolean }) {
  const eligible = decision.candidates.filter((c) => c.eligible);
  const ineligible = decision.candidates.filter((c) => !c.eligible);
  const top = eligible.slice(0, compact ? 3 : 5);
  return (
    <div className="decision">
      <p className="decision-sentence">{decision.explanation}</p>
      {top.length > 0 && (
        <table className="cand-table">
          <thead><tr><th>#</th><th>Driver</th><th>ETA</th><th>Road</th><th>Idle</th><th title="Lower is better">Score</th></tr></thead>
          <tbody>
            {top.map((c) => (
              <tr key={c.driverId} className={c.driverId === decision.selectedDriverId ? 'chosen' : ''}>
                <td>{c.rank}</td>
                <td><div className="cand-name">{c.driverName}</div><div className="chips">{(c.reasonCodes ?? []).slice(0, 3).map((r) => <span key={r} className="chip">{REASON_LABELS[r]}</span>)}</div></td>
                <td className="num">{formatDuration(c.etaSeconds!)}</td>
                <td className="num">{formatDistance(c.roadDistanceM!)}</td>
                <td className="num">{c.idleMinutes} m</td>
                <td className="num">
                  <div className="score">{c.score?.toFixed(3)}</div>
                  {!compact && c.components && (
                    <div className="comp-bars" aria-label="Score components">
                      {COMP_LABELS.map(([k, label, sign]) => {
                        const v = (c.components as any)[k] * (decision.weights as any)[k];
                        return <i key={k} title={`${label}: ${(sign * v).toFixed(3)}`} style={{ width: `${Math.max(2, v * 100)}%` }} className={sign < 0 ? 'bonus' : ''} />;
                      })}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {ineligible.length > 0 && (
        <details className="inelig">
          <summary>{ineligible.length} nearby driver{ineligible.length > 1 ? 's' : ''} skipped by eligibility rules</summary>
          <ul>{ineligible.map((c) => <li key={c.driverId}><span>{c.driverName}</span><span className="chips">{c.ineligibleReasons.map((r) => <span key={r} className={`chip ${r === 'LOCATION_STALE' ? 'warn' : ''}`}>{REASON_LABELS[r]}</span>)}</span><span className="num muted">{formatDistance(c.straightDistanceM)}</span></li>)}</ul>
        </details>
      )}
      <div className="decision-foot">Weights: ETA {decision.weights.pickupEta} · distance {decision.weights.roadDistance} · workload {decision.weights.workload} · reliability {decision.weights.reliabilityPenalty} · idle −{decision.weights.idleBonus} (demo starting values) · computed in {decision.durationMs} ms</div>
    </div>
  );
}
