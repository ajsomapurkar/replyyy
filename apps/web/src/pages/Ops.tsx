import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDistance, formatDuration, formatMoney, STATUS_LABELS, type RideStatus } from '@relay/contracts';
import { Activity, AlertTriangle, BarChart3, Download, FlaskConical, Layers, LogOut, Map as MapIcon, RefreshCw, RotateCcw, Search, Settings2, Signal, Truck, Users, X, Zap } from 'lucide-react';
import { api, getSession, post, queryClient, useConnection, useLive } from '../lib/api';
import { useSignOut } from '../components/AppBar';
import { Wordmark } from '../components/Brand';
import { CityMap, MapLegend } from '../components/CityMap';
import { BarChart, ForecastChart } from '../components/Charts';
import { ConfirmDialog, ConnectionIndicator, DataFreshnessLabel, DecisionCard, EmptyState, ErrorState, MetricCard, RideTimeline, Skeleton, StatusBadge } from '../components/ui';

type View = 'live' | 'zones' | 'analytics';

export function OpsApp() {
  const [view, setView] = useState<View>('live');
  const [sel, setSel] = useState<{ kind: 'ride' | 'driver' | 'zone'; id: string } | null>(null);
  const [locs, setLocs] = useState<Record<string, any>>({});
  const [demoOpen, setDemoOpen] = useState(false);
  const conn = useConnection();
  const overview = useQuery({ queryKey: ['ops-overview'], queryFn: () => api('/ops/overview'), refetchInterval: conn === 'live' ? 5000 : 2500 });
  const zones = useQuery({ queryKey: ['ops-zones'], queryFn: () => api('/ops/zones'), refetchInterval: 30_000 });
  useLive((e) => {
    if (e.type === 'driver.location_updated') {
      const list = (e.payload as any).drivers as any[];
      setLocs((prev) => { const n = { ...prev }; list.forEach((d) => (n[d.driverId] = { ...d, at: Date.now() })); return n; });
      return;
    }
    if (e.type.startsWith('zone.')) queryClient.invalidateQueries({ queryKey: ['ops-zones'] });
    queryClient.invalidateQueries({ queryKey: ['ops-overview'] });
    if (sel?.kind === 'ride' && e.entityId === sel.id) queryClient.invalidateQueries({ queryKey: ['ops-ride', sel.id] });
  });
  const o = overview.data;
  const out = useSignOut();
  const s = getSession();
  const fleet = useMemo(() => (o?.fleet ?? []).map((d: any) => {
    const l = locs[d.id];
    return l && !d.stale ? { ...d, lat: l.lat, lng: l.lng, heading: l.heading } : d;
  }), [o, locs]);

  return (
    <div className="ops">
      <header className="ops-top">
        <Wordmark />
        <span className="ops-title">Control Tower</span>
        <span className="sim-pill" title="Drivers move faster than real time so trips finish quickly in a demo">SIM ×{o?.simulation.speed ?? '–'} · synthetic city</span>
        <div className="grow" />
        <ConnectionIndicator />
        {o && <DataFreshnessLabel at={o.serverTime} staleAfter={12} />}
        <button className="icon-btn" onClick={() => queryClient.invalidateQueries()} aria-label="Resync now" title="Resync from server"><RefreshCw size={15} /></button>
        <button className="icon-btn" onClick={() => setDemoOpen((v) => !v)} aria-label="Demo controls" title="Demo controls" aria-expanded={demoOpen}><Settings2 size={15} /></button>
        <span className="ops-user">{s?.user.displayName}<small>{s?.user.role.toLowerCase()}</small></span>
        <button className="icon-btn" onClick={out} aria-label="Sign out"><LogOut size={15} /></button>
      </header>
      {demoOpen && <DemoControls onClose={() => setDemoOpen(false)} fleet={o?.fleet ?? []} />}
      <nav className="ops-rail" aria-label="Control Tower sections">
        {([['live', MapIcon, 'Live map'], ['zones', Layers, 'Zones'], ['analytics', BarChart3, 'Analytics']] as const).map(([k, I, l]) => (
          <button key={k} className={view === k ? 'on' : ''} onClick={() => setView(k)} aria-current={view === k}><I size={18} /><span>{l}</span></button>
        ))}
      </nav>
      <div className="ops-body">
        {conn !== 'live' && conn !== 'connecting' && <div className="banner amber" role="status"><Signal size={14} /> Live connection lost — showing last known state and polling. Data will resync automatically on reconnect.</div>}
        {overview.error && <ErrorState error={overview.error} retry={() => overview.refetch()} />}
        <div className="kpis">
          {o ? <>
            <MetricCard label="Active rides" value={o.kpis.activeRides} />
            <MetricCard label="Available drivers" value={o.kpis.availableDrivers} hint={`${o.kpis.onlineDrivers} online · ${o.kpis.staleDrivers} stale GPS`} tone={o.kpis.availableDrivers < 5 ? 'amber' : undefined} />
            <MetricCard label="Median pickup ETA" value={o.kpis.medianPickupEtaS != null ? formatDuration(o.kpis.medianPickupEtaS) : '—'} hint="Estimated at acceptance · last 60 min" />
            <MetricCard label="Request → accept" value={o.kpis.medianRequestToAcceptS != null ? formatDuration(o.kpis.medianRequestToAcceptS) : '—'} hint="Median · last 60 min" />
            <MetricCard label="Last hour" value={<>{o.kpis.lastHour.completed}<span className="metric-unit"> done</span> {o.kpis.lastHour.cancelled}<span className="metric-unit"> cxl</span> {o.kpis.lastHour.noDriver}<span className="metric-unit"> no-drv</span></>} />
            <MetricCard label="Exceptions" value={o.kpis.exceptions} tone={o.kpis.exceptions ? 'red' : 'green'} hint="Needs attention" />
          </> : [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} h={64} />)}
        </div>
        {view === 'live' && <LiveView o={o} fleet={fleet} zones={zones.data?.zones ?? []} sel={sel} setSel={setSel} />}
        {view === 'zones' && <ZonesView zones={zones.data?.zones} sel={sel?.kind === 'zone' ? sel.id : null} setSel={(id) => setSel({ kind: 'zone', id })} fleet={fleet} />}
        {view === 'analytics' && <AnalyticsView zones={zones.data?.zones ?? []} />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- live */
const FILTERS: [string, RideStatus[] | null][] = [['All', null], ['Searching', ['REQUESTED', 'DISPATCHING', 'REASSIGNING']], ['Assigned', ['ACCEPTED', 'ARRIVING']], ['On trip', ['ONGOING']], ['Exception', ['EXCEPTION']]];

function LiveView({ o, fleet, zones, sel, setSel }: any) {
  const [tab, setTab] = useState<'rides' | 'exceptions' | 'drivers'>('rides');
  const [filter, setFilter] = useState(0);
  const [zoneF, setZoneF] = useState('');
  const [q, setQ] = useState('');
  const [heat, setHeat] = useState(false);
  if (!o) return <div className="live-grid"><Skeleton h={500} /><Skeleton h={500} /><Skeleton h={500} /></div>;
  const rides = o.rides.filter((r: any) => (!FILTERS[filter][1] || FILTERS[filter][1]!.includes(r.status)) && (!zoneF || r.pickupZoneId === zoneF) &&
    (!q || `${r.id} ${r.passenger.name} ${r.pickup.label} ${r.driver?.name ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const selRide = sel?.kind === 'ride' ? o.rides.find((r: any) => r.id === sel.id) : null;
  const pins = (selRide ? [selRide] : rides.filter((r: any) => ['REQUESTED', 'DISPATCHING', 'REASSIGNING', 'ACCEPTED', 'ARRIVING'].includes(r.status))).flatMap((r: any) => [
    { id: `${r.id}p`, kind: 'pickup', lat: r.pickup.lat, lng: r.pickup.lng },
    ...(selRide ? [{ id: `${r.id}d`, kind: 'dropoff', lat: r.destination.lat, lng: r.destination.lng }] : []),
  ]);
  const selDriver = selRide?.driver ? fleet.find((d: any) => d.id === selRide.driver.id) : null;
  const routes = selRide ? (selDriver ? [{ id: 'r1', from: selDriver, to: selRide.status === 'ONGOING' ? selRide.destination : selRide.pickup, tone: 'accent' }] : [{ id: 'r2', from: selRide.pickup, to: selRide.destination }]) : [];
  const maxGap = Math.max(1, ...zones.map((z: any) => z.expectedGap));
  const exCount = o.exceptions.rides.length + o.exceptions.staleDrivers.length;
  return (
    <div className="live-grid">
      <section className="panel list-panel" aria-label="Rides and exceptions">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'rides'} className={tab === 'rides' ? 'on' : ''} onClick={() => setTab('rides')}>Rides <span className="count">{o.rides.length}</span></button>
          <button role="tab" aria-selected={tab === 'exceptions'} className={tab === 'exceptions' ? 'on' : ''} onClick={() => setTab('exceptions')}>Exceptions <span className={`count ${exCount ? 'red' : ''}`}>{exCount}</span></button>
          <button role="tab" aria-selected={tab === 'drivers'} className={tab === 'drivers' ? 'on' : ''} onClick={() => setTab('drivers')}>Fleet <span className="count">{fleet.length}</span></button>
        </div>
        {tab === 'rides' && (
          <>
            <div className="filters">
              <label className="search"><Search size={14} /><input placeholder="Search ride, rider, driver…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search rides" /></label>
              <div className="chips-row">{FILTERS.map(([l], i) => <button key={l} className={`fchip ${filter === i ? 'on' : ''}`} onClick={() => setFilter(i)} aria-pressed={filter === i}>{l}</button>)}</div>
              <select value={zoneF} onChange={(e) => setZoneF(e.target.value)} aria-label="Filter by zone"><option value="">All zones</option>{zones.map((z: any) => <option key={z.id} value={z.id}>{z.name}</option>)}</select>
            </div>
            <div className="scroll">
              {!rides.length && <EmptyState title="No rides match" body="Adjust filters, or spawn demand from demo controls." />}
              {rides.map((r: any) => (
                <button key={r.id} className={`row-item ${sel?.id === r.id ? 'sel' : ''}`} onClick={() => setSel({ kind: 'ride', id: r.id })}>
                  <div className="ri-top"><span className="mono">#{r.id.slice(0, 6).toUpperCase()}</span><StatusBadge status={r.status} />{r.poolGroupId && <span className="chip"><Users size={10} /> shared</span>}{r.exceptionReason && <AlertTriangle size={13} className="amber" />}</div>
                  <div className="ri-main">{r.pickup.label} → {r.destination.label}</div>
                  <div className="ri-sub">{r.passenger.name}{r.driver ? ` · ${r.driver.name}` : ''} · {new Date(r.requestedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{r.offerCount > 1 ? ` · ${r.offerCount} offers` : ''}</div>
                </button>
              ))}
            </div>
          </>
        )}
        {tab === 'exceptions' && (
          <div className="scroll">
            {!exCount && <EmptyState icon={<Activity size={24} />} title="All clear" body="No rides need intervention right now." />}
            {o.exceptions.rides.map((x: any) => (
              <button key={x.rideId} className={`row-item ex ${x.severity} ${sel?.id === x.rideId ? 'sel' : ''}`} onClick={() => setSel({ kind: 'ride', id: x.rideId })}>
                <div className="ri-top"><AlertTriangle size={13} /><b>{x.title}</b><span className="mono muted">#{x.rideId.slice(0, 6).toUpperCase()}</span><div className="grow" /><time className="muted small">{new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
                <div className="ri-sub">{x.passenger} · {x.pickup}</div>
                <div className="ri-next">Next: {x.nextAction}</div>
              </button>
            ))}
            {o.exceptions.staleDrivers.map((x: any) => (
              <button key={x.driverId} className={`row-item ex amber ${sel?.id === x.driverId ? 'sel' : ''}`} onClick={() => setSel({ kind: 'driver', id: x.driverId })}>
                <div className="ri-top"><Signal size={13} /><b>Stale GPS · {x.name}</b><div className="grow" /><span className="muted small">{formatDuration(x.ageSeconds)}</span></div>
                <div className="ri-next">{x.nextAction}</div>
              </button>
            ))}
          </div>
        )}
        {tab === 'drivers' && (
          <div className="scroll">
            {fleet.map((d: any) => (
              <button key={d.id} className={`row-item ${sel?.id === d.id ? 'sel' : ''}`} onClick={() => setSel({ kind: 'driver', id: d.id })}>
                <div className="ri-top"><b>{d.name}</b><span className={`state st-${d.state.toLowerCase()}`}>{d.state.replace('_', ' ').toLowerCase()}</span>{d.stale && <span className="chip warn">stale</span>}{d.controlledBy === 'DEMO_USER' && <span className="chip accent">demo user</span>}</div>
                <div className="ri-sub">{d.zone ?? '—'} · {d.vehicle}</div>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="panel map-panel" aria-label="Live map">
        <CityMap zones={zones.map((z: any) => ({ ...z, heat: z.expectedGap / maxGap, badge: heat ? `gap ${z.expectedGap} · ${z.availableDrivers} avail` : undefined }))} showHeat={heat}
          drivers={fleet.filter((d: any) => d.lat != null && d.state !== 'OFFLINE').map((d: any) => ({ id: d.id, lat: d.lat, lng: d.lng, state: d.state, stale: d.stale, heading: d.heading, label: d.name }))}
          pins={pins} routes={routes} selectedId={sel?.id ?? selRide?.driver?.id} onSelectDriver={(id) => setSel({ kind: 'driver', id })} onSelectZone={(id) => setSel({ kind: 'zone', id })} />
        <div className="map-overlay-top"><button className={`fchip ${heat ? 'on' : ''}`} onClick={() => setHeat(!heat)} aria-pressed={heat}><Zap size={12} /> Demand-gap overlay</button></div>
        <MapLegend heat={heat} />
      </section>
      <section className="panel detail-panel" aria-label="Details">
        {!sel && <EmptyState icon={<MapIcon size={26} />} title="Select a ride, driver or zone" body="Click a marker or list item to see the dispatch rationale, timeline and available actions." />}
        {sel?.kind === 'ride' && <RideDetail id={sel.id} onClose={() => setSel(null)} />}
        {sel?.kind === 'driver' && <DriverDetail d={fleet.find((x: any) => x.id === sel.id)} onRide={(id: string) => setSel({ kind: 'ride', id })} onClose={() => setSel(null)} />}
        {sel?.kind === 'zone' && <ZoneDetail id={sel.id} onClose={() => setSel(null)} />}
      </section>
    </div>
  );
}

function RideDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useQuery({ queryKey: ['ops-ride', id], queryFn: () => api(`/ops/rides/${id}`), refetchInterval: 4000 });
  const ev = useQuery({ queryKey: ['ops-ride', id, 'events'], queryFn: () => api(`/rides/${id}/events`), refetchInterval: 4000 });
  const [confirm, setConfirm] = useState<null | 'cancel' | 'reassign' | 'resolve'>(null);
  const [target, setTarget] = useState<string>('');
  const [cands, setCands] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  if (d.isLoading) return <Skeleton h={400} />;
  if (d.error) return <ErrorState error={d.error} retry={() => d.refetch()} />;
  const { ride: r, offers, decisions, pool } = d.data;
  const last = decisions[decisions.length - 1];
  const canReassign = !r.startedAt && ['DISPATCHING', 'ACCEPTED', 'ARRIVING', 'EXCEPTION', 'NO_DRIVER'].includes(r.status);
  const canCancel = !['COMPLETED', 'CANCELLED'].includes(r.status);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); queryClient.invalidateQueries(); } catch (e) { setErr(e); } };
  const openReassign = async () => { setConfirm('reassign'); setTarget(''); setCands(null); try { setCands(await api(`/ops/rides/${id}/dispatch-candidates`)); } catch (e) { setErr(e); } };
  const reassignReason = offers.filter((x: any) => x.status !== 'ACCEPTED' && x.status !== 'PENDING');
  return (
    <div className="detail">
      <div className="detail-head">
        <div><div className="mono muted">RIDE #{r.id.slice(0, 8).toUpperCase()}</div><h3>{r.pickup.label} → {r.destination.label}</h3></div>
        <button className="icon-btn" onClick={onClose} aria-label="Close details"><X size={16} /></button>
      </div>
      <div className="row gap wrap"><StatusBadge status={r.status} size="lg" />{r.exceptionReason && <span className="chip warn">{r.exceptionReason.replaceAll('_', ' ').toLowerCase()}</span>}{r.poolOptIn && <span className="chip">pool opt-in</span>}</div>
      <dl className="facts">
        <div><dt>Passenger</dt><dd>{r.passenger.name}</dd></div>
        <div><dt>Driver</dt><dd>{r.driver ? `${r.driver.name} · ${r.driver.vehicle.plate}` : '—'}</dd></div>
        <div><dt>Pickup ETA</dt><dd>{r.pickupEtaSeconds ? `${formatDuration(r.pickupEtaSeconds)} est.` : '—'}</dd></div>
        <div><dt>Fare</dt><dd>{formatMoney(r.finalFareMinor ?? r.quotedFareMinor)} {r.finalFareMinor == null ? 'quoted' : 'final'}</dd></div>
        <div><dt>Trip</dt><dd>{formatDistance(r.estTripMeters)} · {formatDuration(r.estTripSeconds)}</dd></div>
        <div><dt>Offers</dt><dd>{r.offerCount}</dd></div>
      </dl>
      {err ? <ErrorState error={err} /> : null}
      <div className="actions">
        {canReassign && <button className="btn" onClick={openReassign}><RotateCcw size={14} /> Reassign</button>}
        {(r.status === 'EXCEPTION' || r.exceptionReason) && <button className="btn" onClick={() => setConfirm('resolve')}>Resolve exception</button>}
        {r.status === 'NO_DRIVER' && <button className="btn" onClick={() => run(() => post(`/rides/${id}/retry`))}>Retry dispatch</button>}
        {canCancel && <button className="btn danger-ghost" onClick={() => setConfirm('cancel')}>Cancel ride</button>}
      </div>
      {last ? (
        <div className="section"><h4>Dispatch decision <span className="muted">· attempt {last.attempt}</span></h4><DecisionCard decision={last} /></div>
      ) : <div className="section"><h4>Dispatch decision</h4><p className="muted">Not dispatched yet.</p></div>}
      {offers.length > 0 && (
        <div className="section"><h4>Offer attempts</h4>
          <table className="mini"><tbody>{offers.map((x: any) => (
            <tr key={x.id}><td>#{x.sequence}</td><td>{x.driver_name}{x.pooled ? ' · shared' : ''}</td><td><span className={`ostat o-${x.status.toLowerCase()}`}>{x.status.toLowerCase()}</span></td><td className="muted small">{x.response_reason?.replaceAll('_', ' ').toLowerCase() ?? ''}</td><td className="num">{x.eta_seconds ? formatDuration(x.eta_seconds) : ''}</td></tr>
          ))}</tbody></table>
          {reassignReason.length > 0 && <p className="muted small">Reassigned {reassignReason.length}× — every reassignment is visible above and in the timeline.</p>}
        </div>
      )}
      {pool && (
        <div className="section"><h4>Shared ride · capacity {pool.capacity} · route v{pool.routeVersion}</h4>
          <ol className="stops">{pool.stops.map((s: any, i: number) => <li key={i}><span className={`dot ${s.kind === 'PICKUP' ? 'pick' : 'drop'}`} />{s.kind.toLowerCase()} · #{s.rideId.slice(0, 6).toUpperCase()}</li>)}</ol>
          <table className="mini"><tbody>{pool.members.map((m: any) => <tr key={m.ride_id}><td>{m.first_name}</td><td>{STATUS_LABELS[m.status as RideStatus]}</td><td>+{formatDuration(m.detour_seconds)} detour</td><td className="num">{formatMoney(m.agreed_fare_minor)} agreed</td></tr>)}</tbody></table>
        </div>
      )}
      <div className="section"><h4>Timeline</h4><RideTimeline events={ev.data?.events ?? []} /></div>
      <ConfirmDialog open={confirm === 'cancel'} title="Cancel this ride?" body="The rider and driver are notified immediately. This is recorded in the audit log." confirmLabel="Cancel ride" danger onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); run(() => post(`/ops/rides/${id}/cancel`, { reason: 'Operator intervention' })); }} />
      <ConfirmDialog open={confirm === 'resolve'} title="Resolve exception?" body="Clears the flag and returns the ride to its normal flow." confirmLabel="Resolve" onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); run(() => post(`/ops/rides/${id}/resolve`)); }} />
      <ConfirmDialog open={confirm === 'reassign'} title="Reassign this ride" body="The current driver/offer is released and the ride is re-dispatched. Pick a specific driver or let ranking choose." confirmLabel={target ? 'Offer to selected driver' : 'Re-dispatch automatically'}
        onCancel={() => setConfirm(null)} onConfirm={() => { setConfirm(null); run(() => post(`/ops/rides/${id}/reassign`, { driverId: target || undefined, reason: 'Manual reassignment' })); }}>
        {!cands ? <Skeleton h={80} /> : (
          <div className="reassign-list">
            <label className="radio"><input type="radio" name="t" checked={!target} onChange={() => setTarget('')} /> Best eligible (automatic ranking)</label>
            {cands.candidates.filter((c: any) => c.eligible && c.driverId !== r.driver?.id).slice(0, 5).map((c: any) => (
              <label key={c.driverId} className="radio"><input type="radio" name="t" checked={target === c.driverId} onChange={() => setTarget(c.driverId)} /> {c.driverName} <span className="muted">· {formatDuration(c.etaSeconds)} · score {c.score.toFixed(3)}</span></label>
            ))}
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}

function DriverDetail({ d, onRide, onClose }: any) {
  if (!d) return <EmptyState title="Driver not found" />;
  return (
    <div className="detail">
      <div className="detail-head"><div><div className="mono muted">DRIVER</div><h3>{d.name}</h3></div><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
      <div className="row gap wrap"><span className={`state st-${d.state.toLowerCase()}`}>{d.state.replace('_', ' ').toLowerCase()}</span>{d.stale && <span className="chip warn">location stale · excluded from dispatch</span>}<span className="chip">{d.controlledBy === 'DEMO_USER' ? 'demo user' : 'simulated driver'}</span></div>
      <dl className="facts">
        <div><dt>Vehicle</dt><dd>{d.vehicle}</dd></div><div><dt>Seats</dt><dd>{d.seats}</dd></div>
        <div><dt>Zone</dt><dd>{d.zone ?? '—'}</dd></div><div><dt>GPS age</dt><dd>{d.locationAgeSeconds != null ? formatDuration(d.locationAgeSeconds) : '—'}</dd></div>
      </dl>
      {d.stale && <div className="notice amber">Last location is {formatDuration(d.locationAgeSeconds)} old — Relay never shows stale GPS as live and will not offer rides to this driver until it recovers.</div>}
      {d.rideId && <button className="btn" onClick={() => onRide(d.rideId)}>Open current ride</button>}
      {d.offerRideId && <button className="btn" onClick={() => onRide(d.offerRideId)}>Open offered ride</button>}
    </div>
  );
}

function ZoneDetail({ id, onClose }: { id: string; onClose?: () => void }) {
  const q = useQuery({ queryKey: ['zone', id], queryFn: () => api(`/ops/zones/${id}/intelligence`), refetchInterval: 30_000 });
  if (q.isLoading) return <Skeleton h={400} />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const z = q.data;
  return (
    <div className="detail">
      <div className="detail-head"><div><div className="mono muted">ZONE · {z.code}</div><h3>{z.name}</h3></div>{onClose && <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>}</div>
      <div className="row gap wrap"><span className="chip">simulated forecast · {z.model}</span><span className={`chip ${z.confidence === 'Low' ? 'warn' : ''}`}>confidence {z.confidence.toLowerCase()}</span></div>
      <div className="zone-stats">
        <MetricCard label="Forecast next 15 min" value={`${Math.round(z.forecastNext.low)}–${Math.round(z.forecastNext.high)}`} hint={`point ≈ ${z.forecastNext.value.toFixed(1)} requests`} />
        <MetricCard label="Available now" value={z.availableDrivers} hint={`${z.onlineDrivers} online in zone`} />
        <MetricCard label="Expected gap" value={z.expectedGap} tone={z.expectedGap >= 1 ? 'amber' : 'green'} hint={`forecast − available × ${z.capacityFactor}`} />
        <MetricCard label="Zone multiplier" value={`×${z.surgeMultiplier.toFixed(2)}`} hint={`simulated · bounded ${z.pricingPreview.bounds.min}–${z.pricingPreview.bounds.max}`} />
      </div>
      <div className="section"><h4>Predicted vs actual · last 24 h</h4><ForecastChart series={z.series} />
        <p className="muted small">Backtest (7 days): MAE {z.forecastError.mae ?? '—'} req/bucket · WAPE {z.forecastError.wape != null ? `${Math.round(z.forecastError.wape * 100)}%` : '—'} over {z.forecastError.n} buckets. City-scale simulated demand; {z.liveDemoRequests15m} live demo requests in the last 15 min.</p></div>
      <div className="section"><h4>Pricing impact <span className="muted">· simulated</span></h4>
        <p>Sample {z.pricingPreview.sampleTrip}: <b className="num">{formatMoney(z.pricingPreview.baseMinor)}</b> → <b className="num">{formatMoney(z.pricingPreview.withMultiplierMinor)}</b> at ×{z.surgeMultiplier.toFixed(2)}. Smoothed, with a ±{z.pricingPreview.bounds.noChangeBand} no-change band to avoid oscillation. Not real pricing.</p></div>
      <div className="section"><h4>Reposition suggestions</h4>
        {!z.recommendations.length ? <p className="muted">{z.expectedGap >= 1 ? 'Gap detected; no idle drivers with spare supply nearby right now.' : 'No supply gap forecast — no suggestions.'}</p> : z.recommendations.map((r: any) => (
          <div key={r.id} className="rec-item">
            <div className="row gap"><Truck size={14} className="accent" /><b>{r.driverName}</b><span className="muted">from {r.fromZone}</span><div className="grow" /><span className="chip">{r.status === 'ACCEPTED' ? 'heading there' : 'advisory'}</span></div>
            <p className="small">{r.reason}</p>
            <div className="muted small">{formatDistance(r.distanceM)} · ≈ {formatDuration(r.travelSeconds)} · predicted gap {r.gapBefore} → {r.gapAfter} · horizon {r.horizonMinutes} min · expires {new Date(r.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- zones */
function ZonesView({ zones, sel, setSel, fleet }: { zones: any[] | undefined; sel: string | null; setSel: (id: string) => void; fleet: any[] }) {
  if (!zones) return <Skeleton h={400} />;
  const current = sel ?? [...zones].sort((a, b) => b.expectedGap - a.expectedGap)[0]?.id;
  const maxGap = Math.max(1, ...zones.map((z) => z.expectedGap));
  return (
    <div className="zones-grid">
      <div className="zone-cards">
        {zones.map((z) => (
          <button key={z.id} className={`zone-card ${current === z.id ? 'sel' : ''} ${z.expectedGap >= 1 ? 'gap' : ''}`} onClick={() => setSel(z.id)}>
            <div className="row gap"><b>{z.name}</b><div className="grow" />{z.expectedGap >= 1 ? <span className="chip warn">gap {z.expectedGap}</span> : <span className="chip ok">balanced</span>}</div>
            <div className="zc-stats">
              <div><small>Forecast 15 m</small><b className="num">{Math.round(z.forecastNext.low)}–{Math.round(z.forecastNext.high)}</b></div>
              <div><small>Available</small><b className="num">{z.availableDrivers}</b></div>
              <div><small>Multiplier</small><b className="num">×{z.surgeMultiplier.toFixed(2)}</b></div>
            </div>
            <div className="zc-bar"><i style={{ width: `${(z.expectedGap / maxGap) * 100}%` }} /></div>
            <div className="muted small">WAPE {z.forecastError.wape != null ? `${Math.round(z.forecastError.wape * 100)}%` : '—'} · {z.activeRecommendations} suggestion{z.activeRecommendations === 1 ? '' : 's'} · simulated</div>
          </button>
        ))}
        <div className="panel mini-map"><CityMap zones={zones.map((z) => ({ ...z, heat: z.expectedGap / maxGap, badge: `gap ${z.expectedGap}` }))} showHeat selectedId={current} onSelectZone={setSel}
          drivers={fleet.filter((d: any) => d.lat != null && d.state !== 'OFFLINE').map((d: any) => ({ id: d.id, lat: d.lat, lng: d.lng, state: d.state, stale: d.stale }))} /></div>
      </div>
      <section className="panel detail-panel">{current && <ZoneDetail id={current} />}</section>
    </div>
  );
}

/* ------------------------------------------------------------ analytics */
function AnalyticsView({ zones }: { zones: any[] }) {
  const [days, setDays] = useState(4);
  const [zoneId, setZoneId] = useState('');
  const [seed, setSeed] = useState(42);
  const from = useMemo(() => new Date(Date.now() - days * 86_400_000).toISOString(), [days]);
  const qs = `from=${from}${zoneId ? `&zoneId=${zoneId}` : ''}`;
  const a = useQuery({ queryKey: ['analytics', qs], queryFn: () => api(`/ops/analytics?${qs}`) });
  const sim = useQuery({ queryKey: ['strategies', seed], queryFn: () => api(`/ops/simulation/strategies?seed=${seed}`), staleTime: Infinity });
  const csv = async () => {
    const s = getSession();
    const res = await fetch(`/api/v1/ops/analytics.csv?${qs}`, { headers: { authorization: `Bearer ${s?.token}` } });
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: 'relay-metrics.csv' }).click();
    URL.revokeObjectURL(url);
  };
  const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
  return (
    <div className="analytics">
      <div className="toolbar">
        <div className="chips-row">{[1, 2, 4].map((d) => <button key={d} className={`fchip ${days === d ? 'on' : ''}`} onClick={() => setDays(d)}>{d === 1 ? '24 h' : `${d} days`}</button>)}</div>
        <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} aria-label="Zone filter"><option value="">All zones</option>{zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select>
        <div className="grow" />
        {a.data?.includesSimulatedHistory && <span className="sim-pill">includes simulated history</span>}
        <button className="btn sm" onClick={csv}><Download size={14} /> Export CSV</button>
      </div>
      {a.isLoading && <Skeleton h={300} />}
      {a.error && <ErrorState error={a.error} retry={() => a.refetch()} />}
      {a.data && (
        <>
          {a.data.sampleSize === 0 ? <EmptyState title="No rides in this range" body="Widen the date range or remove the zone filter." /> : (
            <>
              <div className="kpis">
                <MetricCard label="Completion" value={pct(a.data.kpis.completionRate)} hint={a.data.definitions.completionRate} />
                <MetricCard label="Cancellation" value={pct(a.data.kpis.cancellationRate)} hint={`No driver: ${pct(a.data.kpis.noDriverRate)}`} />
                <MetricCard label="Median pickup ETA" value={a.data.kpis.medianPickupEtaS != null ? formatDuration(a.data.kpis.medianPickupEtaS) : '—'} hint={`p90 ${a.data.kpis.p90PickupEtaS != null ? formatDuration(a.data.kpis.p90PickupEtaS) : '—'} · ${a.data.definitions.medianPickupEtaS}`} />
                <MetricCard label="Request → accept" value={a.data.kpis.medianRequestToAcceptS != null ? formatDuration(a.data.kpis.medianRequestToAcceptS) : '—'} hint={a.data.definitions.medianRequestToAcceptS} />
                <MetricCard label="Reassignment rate" value={pct(a.data.kpis.reassignmentRate)} hint={a.data.definitions.reassignmentRate} />
                <MetricCard label="Driver utilization" value={pct(a.data.kpis.utilization)} hint={a.data.definitions.utilization} />
                <MetricCard label="Forecast WAPE" value={pct(a.data.kpis.forecastWape)} hint={`MAE ${a.data.kpis.forecastMae ?? '—'} · ${a.data.definitions.forecastWape}`} />
              </div>
              <div className="chart-grid">
                <div className="panel chart-card"><h4>Pickup ETA distribution <span className="muted">· minutes</span></h4><BarChart data={a.data.pickupEtaHistogram.map((b: any) => ({ label: b.label, value: b.count }))} unit=" rides" /></div>
                <div className="panel chart-card"><h4>Request → accept <span className="muted">· seconds</span></h4><BarChart data={a.data.requestToAcceptHistogram.map((b: any) => ({ label: b.label, value: b.count }))} unit=" rides" tone="blue" /></div>
                <div className="panel chart-card"><h4>Completion by day</h4><BarChart data={a.data.outcomesByDay.map((d: any) => ({ label: d.day.slice(5), value: d.total ? (d.completed / d.total) * 100 : 0 }))} unit="%" tone="green" format={(v) => v.toFixed(0)} /></div>
                <div className="panel chart-card"><h4>Reassignment rate by day</h4><BarChart data={a.data.outcomesByDay.map((d: any) => ({ label: d.day.slice(5), value: (d.reassignmentRate ?? 0) * 100 }))} unit="%" tone="amber" format={(v) => v.toFixed(0)} /></div>
                <div className="panel chart-card"><h4>Driver utilization <span className="muted">· hourly</span></h4><BarChart data={a.data.utilizationByHour.slice(-24).map((h: any) => ({ label: new Date(h.hour).getHours().toString(), value: h.utilization * 100 }))} unit="%" format={(v) => v.toFixed(0)} /></div>
                <div className="panel chart-card"><h4>Forecast error by zone <span className="muted">· WAPE</span></h4><BarChart data={a.data.forecastErrorByZone.map((z: any) => ({ label: z.zone.split(' ')[0], value: (z.wape ?? 0) * 100 }))} unit="%" tone="blue" format={(v) => v.toFixed(0)} /></div>
              </div>
            </>
          )}
        </>
      )}
      <div className="panel strategy">
        <div className="row gap"><FlaskConical size={16} className="accent" /><h4>Matching strategy evaluation</h4><span className="sim-pill">simulation · not field evidence</span><div className="grow" />
          <label className="small muted">Seed <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 1)} className="seed" aria-label="Simulation seed" /></label></div>
        {sim.isLoading && <Skeleton h={120} />}
        {sim.data && (
          <>
            <table className="strat-table">
              <thead><tr><th>Strategy</th><th>Median pickup</th><th>p90 pickup</th><th>Req → accept</th><th>Completion</th><th>Cancellation</th><th>Utilization</th><th title="Gini of trips per driver; lower is fairer">Trip Gini</th></tr></thead>
              <tbody>{sim.data.results.map((r: any) => {
                const best = (k: string, lower = true) => { const vals = sim.data.results.map((x: any) => x[k]); return r[k] === (lower ? Math.min(...vals) : Math.max(...vals)); };
                return (
                  <tr key={r.strategy}>
                    <td><b>{r.label}</b></td>
                    <td className={`num ${best('medianPickupEtaS') ? 'best' : ''}`}>{formatDuration(r.medianPickupEtaS)}</td>
                    <td className={`num ${best('p90PickupEtaS') ? 'best' : ''}`}>{formatDuration(r.p90PickupEtaS)}</td>
                    <td className={`num ${best('medianRequestToAcceptS') ? 'best' : ''}`}>{formatDuration(r.medianRequestToAcceptS)}</td>
                    <td className={`num ${best('completionRate', false) ? 'best' : ''}`}>{pct(r.completionRate)}</td>
                    <td className={`num ${best('cancellationRate') ? 'best' : ''}`}>{pct(r.cancellationRate)}</td>
                    <td className="num">{pct(r.utilization)}</td>
                    <td className={`num ${best('tripGini') ? 'best' : ''}`}>{r.tripGini.toFixed(3)}</td>
                  </tr>
                );
              })}</tbody>
            </table>
            <ul className="assumptions">{sim.data.assumptions.map((s: string) => <li key={s}>{s}</li>)}</ul>
          </>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- demo */
function DemoControls({ onClose, fleet }: { onClose: () => void; fleet: any[] }) {
  const st = useQuery({ queryKey: ['demo-state'], queryFn: () => api('/demo/state') });
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const run = async (label: string, fn: () => Promise<unknown>) => { setMsg(`${label}…`); try { await fn(); setMsg(`${label} ✓`); queryClient.invalidateQueries(); } catch (e: any) { setMsg(e.message); } };
  const busyBot = fleet.find((d) => d.controlledBy === 'SIMULATED' && d.state === 'EN_ROUTE' && !d.stale);
  return (
    <div className="demo-pop" role="dialog" aria-label="Demo controls">
      <div className="row gap"><b>Demo controls</b><span className="sim-pill">demo tooling</span><div className="grow" /><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={15} /></button></div>
      <label className="switch-row"><input type="checkbox" checked={!!st.data?.backgroundDemand} onChange={(e) => run('Background demand', () => post('/demo/background', { enabled: e.target.checked }))} /> Background simulated demand</label>
      <button className="btn sm block" onClick={() => run('Spawned ride', () => post('/demo/spawn-ride'))}>Spawn one simulated ride</button>
      <button className="btn sm block" onClick={() => run('Shared-ride scenario', () => post('/demo/pool-scenario'))}>Re-create shared-ride scenario near Clocktower Sq.</button>
      <button className="btn sm block" disabled={!busyBot} onClick={() => run('GPS frozen', () => post(`/demo/drivers/${busyBot.id}/gps`, { frozen: true }))}>Freeze GPS of a busy simulated driver{busyBot ? ` (${busyBot.name})` : ''}</button>
      <button className="btn sm block danger-ghost" onClick={() => setConfirmReset(true)}>Reset demo to seed state</button>
      {msg && <div className="muted small">{msg}</div>}
      <ConfirmDialog open={confirmReset} title="Reset demo data?" body="All rides, offers and forecasts are restored to the deterministic seed. Sessions stay signed in." confirmLabel="Reset" danger onCancel={() => setConfirmReset(false)}
        onConfirm={() => { setConfirmReset(false); run('Reset', () => post('/demo/reset')); }} />
    </div>
  );
}
