import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDistance, formatDuration, formatMoney } from '@relay/contracts';
import { Car, Compass, LogOut, Menu, Navigation, Satellite, Users, Wallet, X } from 'lucide-react';
import {
  api, Avatar, Button, ConfirmSheet, ConnectionDot, Countdown, DemoLogin, getSession, haversineM, Logo, MapShell, newKey, Notice, post,
  queryClient, Rating, Row, StopList, useLive, useSignOut,
} from '@relay/ui';

export function App() {
  const [authed, setAuthed] = useState(!!getSession());
  if (!authed) return <DemoLogin role="DRIVER" title="Drive and earn with Relay" subtitle="Get ride requests near you. Go on duty when you're ready." onDone={() => setAuthed(true)} />;
  return <Driver onSignOut={() => setAuthed(false)} />;
}

function Driver({ onSignOut }: { onSignOut: () => void }) {
  const me = useQuery({ queryKey: ['driver-me'], queryFn: () => api('/drivers/me'), refetchInterval: 4000 });
  const [pos, setPos] = useState<any>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [handBack, setHandBack] = useState<string | null>(null);
  useLive((e) => {
    if (e.type === 'driver.location_updated') setPos((e.payload as any).drivers[0]);
    else queryClient.invalidateQueries({ queryKey: ['driver-me'] });
  });
  const signOut = useSignOut(onSignOut);
  if (!me.data) return <div className="r-app"><div className="r-splash">{me.error ? <Notice tone="error">{(me.error as Error).message}</Notice> : <Logo size={34} />}</div></div>;
  const d = me.data;
  if (menu) return <Earnings d={d} onClose={() => setMenu(false)} onSignOut={signOut} />;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); queryClient.invalidateQueries({ queryKey: ['driver-me'] }); }
  };
  const online = d.availability === 'ONLINE';
  const loc = pos ?? d.location;
  const next = d.stops?.[0];
  const nextRide = next ? d.activeRides.find((r: any) => r.id === next.rideId) : d.activeRides[0];
  const target = next?.point ?? d.offer?.pickup;
  const car = loc ? [{ id: d.id, lat: loc.lat, lng: loc.lng, heading: loc.heading, tone: 'me' as const }] : [];
  const fit = [loc, target, d.offer?.destination].filter(Boolean);
  const mapPickup = d.offer ? d.offer.pickup : next?.kind === 'PICKUP' ? next.point : null;
  const mapDrop = d.offer ? d.offer.destination : next?.kind === 'DROPOFF' ? next.point : null;
  const routes = loc && target ? [{ id: 'go', points: [loc, target] }, ...(d.offer ? [{ id: 'trip', points: [d.offer.pickup, d.offer.destination], style: 'muted' as const }] : [])] : [];

  return (
    <MapShell
      map={{ cars: car, pickup: mapPickup, drop: mapDrop, routes, fit: fit.length ? fit : undefined, fitKey: `${d.offer?.id ?? ''}-${next?.rideId ?? ''}-${next?.kind ?? ''}-${!!loc}` }}
      top={<>
        <button className="r-icon" onClick={() => setMenu(true)} aria-label="Menu"><Menu size={20} /></button>
        <button className={`d-duty ${online ? 'on' : ''}`} role="switch" aria-checked={online} disabled={busy || d.activeRides.length > 0}
          onClick={() => act(() => api('/drivers/me/availability', { method: 'PATCH', body: { status: online ? 'OFFLINE' : 'ONLINE' } }))}>
          <span className="d-knob" /> {online ? 'On duty' : 'Off duty'}
        </button>
        <span className="d-earn"><Wallet size={15} /> {formatMoney(d.earningsToday.estEarningsMinor)}</span>
      </>}
      sheet={
        <>
          <ConnectionDot />
          {err && <Notice tone="error">{err}</Notice>}
          {d.offer ? <OfferCard offer={d.offer} onDone={() => queryClient.invalidateQueries({ queryKey: ['driver-me'] })} />
            : d.activeRides.length ? (
              <ActiveTrip d={d} nextRide={nextRide} next={next} loc={loc} busy={busy} act={act} onHandBack={setHandBack} />
            ) : online ? (
              <>
                <h2>Finding rides near you</h2>
                <p className="r-sub">You'll get a request when you're the best match nearby.</p>
                <div className="r-progress"><i /></div>
                {d.recommendation && <Suggestion rec={d.recommendation} act={act} />}
                <Stats d={d} />
              </>
            ) : (
              <>
                <h2>You're off duty</h2>
                <p className="r-sub">Go on duty to start getting ride requests.</p>
                <Button variant="success" size="lg" block onClick={() => act(() => api('/drivers/me/availability', { method: 'PATCH', body: { status: 'ONLINE' } }))} loading={busy}>Go on duty</Button>
                <Stats d={d} />
              </>
            )}
          <ConfirmSheet open={!!handBack} title="Can't make this trip?" body="The rider will be matched with another driver right away. Hand-backs are recorded on your account."
            confirm="Hand back trip" cancel="Keep trip" danger onClose={() => setHandBack(null)}
            onConfirm={() => { const id = handBack!; setHandBack(null); act(() => post(`/driver/rides/${id}/cancel`, { reason: 'Driver unable to reach pickup' })); }} />
        </>
      }
    />
  );
}

function OfferCard({ offer, onDone }: { offer: any; onDone: () => void }) {
  const [key] = useState(newKey);
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const respond = async (what: 'accept' | 'reject') => {
    setBusy(what); setErr(null);
    try { await post(`/driver/offers/${offer.id}/${what}`, {}, `${key}:${what}`); } catch (e: any) { setErr(e.message); } finally { setBusy(null); onDone(); }
  };
  return (
    <div className="d-offer" role="alertdialog" aria-labelledby="offer-h">
      <div className="d-offer-head">
        <div><div className="r-label" id="offer-h">{offer.pooled ? <><Users size={12} /> Shared ride request</> : 'New ride request'}</div><div className="d-offer-amt">{formatMoney(offer.estEarningsMinor)}</div><div className="r-muted d-small">Estimated earnings · simulated</div></div>
        <Countdown expiresAt={offer.expiresAt} total={offer.ttlSeconds} />
      </div>
      <div className="d-chips">
        <span><Navigation size={14} /> {formatDuration(offer.pickupEtaSeconds)}{offer.pickupDistanceM ? ` · ${formatDistance(offer.pickupDistanceM)}` : ''} to pickup</span>
        <span><Car size={14} /> {formatDuration(offer.tripSeconds)} · {formatDistance(offer.tripMeters)} trip</span>
      </div>
      <StopList pickup={offer.pickup.label} drop={offer.destination.label} />
      {err && <Notice tone="error">{err}</Notice>}
      <div className="d-offer-actions">
        <Button variant="success" size="lg" block onClick={() => respond('accept')} loading={busy === 'accept'} disabled={!!busy}>Accept</Button>
        <Button variant="ghost" block onClick={() => respond('reject')} loading={busy === 'reject'} disabled={!!busy}>Decline</Button>
      </div>
    </div>
  );
}

function ActiveTrip({ d, nextRide, next, loc, busy, act, onHandBack }: any) {
  const r = nextRide;
  if (!r) return null;
  const goingToPickup = r.status === 'ACCEPTED';
  const target = r.status === 'ONGOING' ? r.destination : r.pickup;
  const dist = loc ? haversineM(loc, target) : null;
  const heading = r.status === 'ACCEPTED' ? 'Go to pickup' : r.status === 'ARRIVING' ? `Waiting for ${r.passengerFirstName}` : r.status === 'ONGOING' ? `Drop ${r.passengerFirstName}` : 'Trip paused';
  return (
    <>
      <div className="d-step">
        <div className="r-label">{heading}</div>
        <div className="d-step-place">{next?.kind === 'DROPOFF' || r.status === 'ONGOING' ? r.destination.label : r.pickup.label}</div>
        {dist != null && <div className="r-muted d-small"><Compass size={13} /> {formatDistance(dist)} away{goingToPickup && dist < 80 ? ' · you are at the pickup' : ''}</div>}
      </div>
      <Row icon={<Avatar name={r.passengerFirstName} size={40} />} title={r.passengerFirstName} sub={`${r.seats} seat${r.seats > 1 ? 's' : ''} · ${formatMoney(r.estEarningsMinor)} est.`} />
      {r.exceptionReason && <Notice tone="warn">Operations flagged this trip: {r.exceptionReason.replaceAll('_', ' ').toLowerCase()}.</Notice>}
      {d.stops.length > 1 && (
        <div className="d-stops">
          <div className="r-label">Shared ride · next stops</div>
          {d.stops.map((s: any, i: number) => {
            const rr = d.activeRides.find((x: any) => x.id === s.rideId);
            return <div key={i} className={`d-stop ${i === 0 ? 'next' : ''}`}><i className={s.kind === 'PICKUP' ? 's-pick' : 's-drop'} />{s.kind === 'PICKUP' ? 'Pick up' : 'Drop'} {rr?.passengerFirstName}</div>;
          })}
        </div>
      )}
      <div className="r-actions">
        {r.status === 'ACCEPTED' && <Button variant="dark" size="lg" block loading={busy} onClick={() => act(() => post(`/driver/rides/${r.id}/arriving`))}>Arrived at pickup</Button>}
        {r.status === 'ARRIVING' && <Button variant="success" size="lg" block loading={busy} onClick={() => act(() => post(`/driver/rides/${r.id}/start`))}>Start ride</Button>}
        {r.status === 'ONGOING' && <Button variant="dark" size="lg" block loading={busy} onClick={() => act(() => post(`/driver/rides/${r.id}/complete`))}>End ride · collect {formatMoney(Math.round(r.estEarningsMinor / 0.8))}</Button>}
        {(r.status === 'ACCEPTED' || r.status === 'ARRIVING') && <Button variant="ghost" block onClick={() => onHandBack(r.id)}>Can't make it</Button>}
      </div>
      <p className="r-fine">Your location is simulated along the demo street grid.</p>
    </>
  );
}

function Suggestion({ rec, act }: { rec: any; act: (fn: () => Promise<unknown>) => void }) {
  return (
    <div className="d-suggest">
      <div className="d-suggest-head"><Compass size={18} /><b>Busier area nearby: {rec.toZone}</b>
        {rec.status === 'ACTIVE' && <button className="r-icon flat" style={{ width: 30, height: 30, marginLeft: 'auto' }} aria-label="Dismiss" onClick={() => act(() => post(`/drivers/me/recommendations/${rec.id}/dismiss`))}><X size={16} /></button>}</div>
      <p>More requests are expected there in the next {rec.horizonMinutes} min than drivers available. {formatDistance(rec.distanceM)} · about {formatDuration(rec.travelSeconds)}.</p>
      {rec.status === 'ACTIVE'
        ? <div className="d-suggest-actions"><Button variant="dark" onClick={() => act(() => post(`/drivers/me/recommendations/${rec.id}/accept`))}>Head there</Button><Button variant="ghost" onClick={() => act(() => post(`/drivers/me/recommendations/${rec.id}/dismiss`))}>Not now</Button></div>
        : <p className="r-muted d-small">Heading to {rec.toZone}. You'll still get requests on the way.</p>}
      <p className="r-fine">Optional suggestion from a simulated forecast. It never changes your duty status.</p>
    </div>
  );
}

function Stats({ d }: { d: any }) {
  return (
    <div className="d-stats">
      <div><span>Today</span><b>{formatMoney(d.earningsToday.estEarningsMinor)}</b></div>
      <div><span>Trips</span><b>{d.earningsToday.trips}</b></div>
      <div><span>GPS</span><b className={d.locationFresh ? '' : 'warn'}><Satellite size={14} /> {d.locationFresh ? 'Good' : 'Weak'}</b></div>
    </div>
  );
}

function Earnings({ d, onClose, onSignOut }: { d: any; onClose: () => void; onSignOut: () => void }) {
  const rides = useQuery({ queryKey: ['driver-rides'], queryFn: () => api('/rides') });
  const done = (rides.data?.items ?? []).filter((r: any) => r.status === 'COMPLETED');
  return (
    <div className="r-page">
      <div className="r-page-head"><button className="r-icon flat" onClick={onClose} aria-label="Close"><X size={20} /></button><Logo size={22} /><span className="r-muted d-small">Driver</span></div>
      <div className="r-page-body">
        <Row icon={<Avatar name={d.name} size={46} />} title={d.name} sub={<>{d.vehicle.color} {d.vehicle.makeModel} · {d.vehicle.plate}</>} right={<Rating value={d.rating} />} />
        <div className="d-earn-card">
          <span className="r-label">Today's earnings</span>
          <div className="d-offer-amt">{formatMoney(d.earningsToday.estEarningsMinor)}</div>
          <span className="r-muted d-small">{d.earningsToday.trips} trips · simulated, 80% of fares</span>
        </div>
        <div className="r-label" style={{ marginTop: 18 }}>Recent trips</div>
        {!done.length && <p className="r-fine">Completed trips will show up here.</p>}
        {done.map((r: any) => (
          <Row key={r.id} icon={<Car size={18} />} title={r.destination.label} sub={`${new Date(r.completedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · from ${r.pickup.label}`} right={<b>{formatMoney(Math.round((r.finalFareMinor ?? 0) * 0.8))}</b>} />
        ))}
        <Button variant="secondary" block onClick={onSignOut} style={{ marginTop: 24 }}><LogOut size={16} /> Sign out</Button>
      </div>
    </div>
  );
}
