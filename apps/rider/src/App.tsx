import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ACTIVE_STATUSES, formatDistance, formatDuration, formatMoney, type LatLng } from '@relay/contracts';
import { ArrowLeft, Car, ChevronDown, ChevronUp, Clock, History, LogOut, MapPin, Menu, Navigation, Search, ShieldCheck, Users, X } from 'lucide-react';
import {
  api, Avatar, Button, ConfirmSheet, ConnectionDot, DemoLogin, FareRows, getSession, haversineM, Logo, MapShell, newKey, Notice, Plate, post,
  queryClient, Rating, Row, StopList, useLive, useSignOut,
} from '@relay/ui';

type Place = { label: string; lat: number; lng: number };
type Stage = { name: 'home' } | { name: 'search'; focus: 'pickup' | 'drop' } | { name: 'pin'; field: 'pickup' | 'drop' } | { name: 'options' };

export function App() {
  const [authed, setAuthed] = useState(!!getSession());
  if (!authed) return <DemoLogin role="PASSENGER" title="Ride anywhere in the city" subtitle="Fast pickups, fixed fares, live tracking." onDone={() => setAuthed(true)} />;
  return <Rider onSignOut={() => setAuthed(false)} />;
}

const hello = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const clock = (inSeconds: number) => new Date(Date.now() + inSeconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function Rider({ onSignOut }: { onSignOut: () => void }) {
  const rides = useQuery({ queryKey: ['my-rides'], queryFn: () => api('/rides'), refetchInterval: 15_000 });
  const places = useQuery({ queryKey: ['places'], queryFn: () => api('/places'), staleTime: Infinity });
  const [menu, setMenu] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const lastActive = useRef<string | null>(null);
  useLive((e) => {
    if (e.type === 'driver.location_updated') queryClient.setQueryData(['driver-pos'], (e.payload as any).drivers[0]);
    else { queryClient.invalidateQueries({ queryKey: ['my-rides'] }); queryClient.invalidateQueries({ queryKey: ['ride'] }); }
  });
  const items = rides.data?.items ?? [];
  const active = items.find((r: any) => ACTIVE_STATUSES.includes(r.status) || (r.status === 'NO_DRIVER' && Date.now() - new Date(r.requestedAt).getTime() < 10 * 60_000));
  useEffect(() => {
    if (active) lastActive.current = active.id;
    else if (lastActive.current) {
      const done = items.find((r: any) => r.id === lastActive.current);
      if (done?.status === 'COMPLETED') setReceipt(done.id);
      lastActive.current = null;
    }
  }, [active?.id, items]);
  const signOut = useSignOut(onSignOut);

  if (rides.isLoading || places.isLoading) return <div className="r-app"><div className="r-splash"><Logo size={34} /></div></div>;
  if (menu) return <Account items={items} onClose={() => setMenu(false)} onSignOut={signOut} />;
  if (receipt) return <Receipt ride={items.find((r: any) => r.id === receipt)} onDone={() => setReceipt(null)} />;
  if (active) return <Trip rideId={active.id} onMenu={() => setMenu(true)} />;
  return <Booking places={places.data} onMenu={() => setMenu(true)} />;
}

/* ------------------------------------------------------------------ booking */

function Booking({ places, onMenu }: { places: any; onMenu: () => void }) {
  const list: Place[] = places.places;
  const hub = list.find((p) => p.label === places.hub)!;
  const [stage, setStage] = useState<Stage>({ name: 'home' });
  const [pickup, setPickup] = useState<Place>(hub);
  const [drop, setDrop] = useState<Place | null>(null);
  const [pinAt, setPinAt] = useState<LatLng | null>(null);
  const nearby = useQuery({ queryKey: ['nearby', pickup.lat, pickup.lng], queryFn: () => api(`/drivers/nearby?lat=${pickup.lat}&lng=${pickup.lng}&radiusM=2500`), refetchInterval: 5000 });
  const cars = (nearby.data?.drivers ?? []).map((d: any, i: number) => ({ id: `n${i}`, ...d, heading: (i * 67) % 360 }));
  const nearestLabel = (p: LatLng | null) => {
    if (!p) return 'Move the map to set location';
    const n = [...list].sort((a, b) => haversineM(a, p) - haversineM(b, p))[0];
    return haversineM(n, p) < 250 ? `Near ${n.label}` : `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
  };

  if (stage.name === 'search') {
    return <SearchPanel list={list} pickup={pickup} drop={drop} focus={stage.focus} onBack={() => setStage(drop ? { name: 'options' } : { name: 'home' })}
      onPin={(field) => setStage({ name: 'pin', field })}
      onDone={(p, d) => { setPickup(p); setDrop(d); setStage({ name: 'options' }); }} />;
  }
  if (stage.name === 'pin') {
    const start = stage.field === 'pickup' ? pickup : drop ?? pickup;
    return (
      <MapShell
        map={{ pinMode: true, pinLabel: stage.field === 'pickup' ? 'Pickup here' : 'Drop here', fit: [start], fitKey: `pin-${stage.field}`, onCenterChange: setPinAt, places: list, cars }}
        top={<button className="r-icon" onClick={() => setStage({ name: 'search', focus: stage.field })} aria-label="Back"><ArrowLeft size={20} /></button>}
        sheet={
          <>
            <h2>Set {stage.field === 'pickup' ? 'pickup' : 'drop'} location</h2>
            <p className="r-sub">Drag the map to move the pin.</p>
            <Row icon={<MapPin size={18} />} title={nearestLabel(pinAt)} sub="Pinned location" />
            <Button block size="lg" disabled={!pinAt} onClick={() => {
              const p = { label: nearestLabel(pinAt).replace(/^Near /, ''), ...pinAt! };
              if (stage.field === 'pickup') setPickup(p); else setDrop(p);
              setStage(stage.field === 'pickup' && !drop ? { name: 'search', focus: 'drop' } : { name: 'options' });
            }}>Confirm location</Button>
          </>
        }
      />
    );
  }
  if (stage.name === 'options' && drop) {
    return <Options pickup={pickup} drop={drop} cars={cars} places={list} onBack={() => setStage({ name: 'home' })} onEdit={(f) => setStage({ name: 'search', focus: f })} />;
  }
  const suggestions = list.filter((p) => p.label !== pickup.label).slice(0, 5);
  return (
    <MapShell
      map={{ pickup: { ...pickup }, cars, fit: [pickup], fitKey: `home-${pickup.label}`, places: list }}
      top={<>
        <button className="r-icon" onClick={onMenu} aria-label="Menu"><Menu size={20} /></button>
        <button className="r-loc-chip" onClick={() => setStage({ name: 'search', focus: 'pickup' })}><span className="r-dot-g" /> <span className="r-ellipsis">{pickup.label}</span> <ChevronDown size={16} /></button>
      </>}
      sheet={
        <>
          <div className="r-hello">{hello()}, {getSession()?.user.displayName.split(' ')[0]}</div>
          <button className="r-search" onClick={() => setStage({ name: 'search', focus: 'drop' })}><Search size={20} /> Where are you going?</button>
          <div className="r-near">{nearby.data ? (nearby.data.count ? <><Car size={15} /> {nearby.data.count} cars nearby</> : 'No cars nearby right now') : ' '}</div>
          <div className="r-label">Suggestions</div>
          {suggestions.map((p) => (
            <Row key={p.label} icon={<Clock size={17} />} title={p.label} sub={formatDistance(haversineM(pickup, p) * 1.25) + ' away'} onClick={() => { setDrop(p); setStage({ name: 'options' }); }} />
          ))}
        </>
      }
    />
  );
}

function SearchPanel({ list, pickup, drop, focus, onBack, onDone, onPin }: { list: Place[]; pickup: Place; drop: Place | null; focus: 'pickup' | 'drop'; onBack: () => void; onDone: (p: Place, d: Place) => void; onPin: (f: 'pickup' | 'drop') => void }) {
  const [field, setField] = useState(focus);
  const [p, setP] = useState(pickup);
  const [d, setD] = useState<Place | null>(drop);
  const [q, setQ] = useState('');
  const results = list.filter((x) => x.label.toLowerCase().includes(q.toLowerCase()));
  const choose = (x: Place) => {
    if (field === 'pickup') { setP(x); setQ(''); if (d) onDone(x, d); else setField('drop'); }
    else { setD(x); onDone(p, x); }
  };
  const [useLoc, setLocMsg] = useState<string | null>(null);
  const myLocation = () => {
    if (!navigator.geolocation) return setLocMsg('Location is unavailable in this browser.');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (!list.some((x) => haversineM(x, ll) < 6000)) setLocMsg('You are outside the Relay demo city — choose a place or set it on the map.');
        else choose({ label: 'Current location', ...ll });
      },
      () => setLocMsg('Location permission denied — choose a place or set it on the map.'),
      { timeout: 6000 },
    );
  };
  return (
    <div className="r-search-page">
      <div className="r-search-head">
        <button className="r-icon flat" onClick={onBack} aria-label="Back"><ArrowLeft size={20} /></button>
        <div className="r-fields">
          <label className={`r-field ${field === 'pickup' ? 'on' : ''}`}><span className="r-dot-g" />
            <input value={field === 'pickup' ? q : p.label} placeholder="Pickup location" onFocus={() => { setField('pickup'); setQ(''); }} onChange={(e) => setQ(e.target.value)} autoFocus={focus === 'pickup'} aria-label="Pickup" /></label>
          <label className={`r-field ${field === 'drop' ? 'on' : ''}`}><span className="r-dot-r" />
            <input value={field === 'drop' ? q : d?.label ?? ''} placeholder="Where to?" onFocus={() => { setField('drop'); setQ(''); }} onChange={(e) => setQ(e.target.value)} autoFocus={focus === 'drop'} aria-label="Destination" /></label>
        </div>
      </div>
      <div className="r-search-list">
        {field === 'pickup' && <Row icon={<Navigation size={17} />} title="Use current location" onClick={myLocation} />}
        <Row icon={<MapPin size={17} />} title="Select on map" onClick={() => onPin(field)} />
        {useLoc && <Notice tone="warn">{useLoc}</Notice>}
        <div className="r-label" style={{ marginTop: 14 }}>{q ? 'Results' : 'Popular places'}</div>
        {results.map((x) => <Row key={x.label} icon={<MapPin size={17} />} title={x.label} sub={formatDistance(haversineM(p, x) * 1.25) + ' from pickup'} onClick={() => choose(x)} />)}
        {!results.length && <p className="r-fine">No matching place in the demo city. Try "Market" or "Tower", or select on map.</p>}
      </div>
    </div>
  );
}

function Options({ pickup, drop, cars, places, onBack, onEdit }: { pickup: Place; drop: Place; cars: any[]; places: Place[]; onBack: () => void; onEdit: (f: 'pickup' | 'drop') => void }) {
  const [mode, setMode] = useState<'solo' | 'pool'>('solo');
  const [seats, setSeats] = useState(1);
  const [showFare, setShowFare] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(newKey);
  const quote = useQuery({
    queryKey: ['quote', pickup.lat, pickup.lng, drop.lat, drop.lng, seats],
    queryFn: () => post('/rides/quote', { pickup: { lat: pickup.lat, lng: pickup.lng }, destination: { lat: drop.lat, lng: drop.lng }, seats }),
    refetchInterval: 20_000, retry: false,
  });
  const q = quote.data;
  const shareOk = q?.pool.available;
  const chosen = mode === 'pool' && shareOk ? q.pool : q?.solo;
  const book = async () => {
    setBusy(true); setErr(null);
    try {
      await post('/rides', { pickup: { lat: pickup.lat, lng: pickup.lng }, pickupLabel: pickup.label, destination: { lat: drop.lat, lng: drop.lng }, destinationLabel: drop.label, seats, poolOptIn: mode === 'pool' }, key);
      await queryClient.invalidateQueries({ queryKey: ['my-rides'] });
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <MapShell
      map={{ pickup: { ...pickup, label: pickup.label }, drop: { ...drop, label: drop.label }, routes: [{ id: 'r', points: [pickup, drop] }], cars, fit: [pickup, drop], fitKey: `opt-${pickup.label}-${drop.label}`, places }}
      top={<button className="r-icon" onClick={onBack} aria-label="Back"><ArrowLeft size={20} /></button>}
      sheet={
        <>
          <button className="r-trip-edit" onClick={() => onEdit('drop')} aria-label="Edit trip"><StopList pickup={pickup.label} drop={drop.label} compact /></button>
          <div className="r-divider" />
          {quote.isLoading && <><div className="r-skel" style={{ height: 66, marginBottom: 8 }} /><div className="r-skel" style={{ height: 66 }} /></>}
          {quote.error && <Notice tone="error">{(quote.error as Error).message}</Notice>}
          {q && (
            <>
              <Row active={mode === 'solo'} onClick={() => setMode('solo')} icon={<Car size={22} />} title="Relay Cab"
                sub={`${q.solo.pickupEstimateS ? `${Math.max(1, Math.round(q.solo.pickupEstimateS / 60))} min away · ` : ''}Drop ${clock((q.solo.pickupEstimateS ?? 240) + q.solo.tripDurationS)}`}
                right={<b className="r-price">{formatMoney(q.solo.fare.totalMinor)}</b>} />
              <Row active={mode === 'pool'} onClick={shareOk ? () => setMode('pool') : undefined} icon={<Users size={22} />}
                title={<>Relay Share {shareOk && <span className="r-save">Save {formatMoney(q.solo.fare.totalMinor - q.pool.fare.totalMinor)}</span>}</>}
                sub={shareOk ? `${Math.max(1, Math.round(q.pool.pickupEstimateS / 60))} min away · ${q.pool.coRiders} co-rider · +${Math.max(0, Math.round(q.pool.extraS / 60))} min` : 'No shared ride on your route right now'}
                right={shareOk ? <b className="r-price">{formatMoney(q.pool.fare.totalMinor)}</b> : <span className="r-muted">—</span>} />
              {q.poolRejections?.length > 0 && (
                <button className="r-link" onClick={() => setShowWhy(!showWhy)}>Why some shared rides aren't available {showWhy ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
              )}
              {showWhy && <ul className="r-why">{q.poolRejections.map((r: any) => <li key={r.rideId}>{r.message}</li>)}</ul>}
              {mode === 'pool' && shareOk && (
                <div className="r-seats">Seats <span>{[1, 2].map((n) => <button key={n} className={seats === n ? 'on' : ''} onClick={() => setSeats(n)} aria-pressed={seats === n}>{n}</button>)}</span></div>
              )}
              <button className="r-link" onClick={() => setShowFare(!showFare)}>Fare details {showFare ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
              {showFare && chosen && <FareRows fare={chosen.fare} />}
              {q.surgeMultiplier > 1 && <Notice tone="warn">High demand in {q.pickupZone?.name}. Fares include a simulated ×{q.surgeMultiplier.toFixed(2)} adjustment.</Notice>}
              {q.nearbyDrivers === 0 && <Notice tone="warn">No cars are online near you. You can still book — we'll tell you if no one is available.</Notice>}
              {err && <Notice tone="error">{err}</Notice>}
              <div className="r-book">
                <Button block size="lg" onClick={book} loading={busy}>Book {mode === 'pool' && shareOk ? 'Relay Share' : 'Relay Cab'} · {formatMoney(chosen.fare.totalMinor)}</Button>
                <p className="r-fine center"><ShieldCheck size={12} /> {q.cancellationPolicy.split('.')[0]}.</p>
              </div>
            </>
          )}
        </>
      }
    />
  );
}

/* --------------------------------------------------------------------- trip */

function Trip({ rideId, onMenu }: { rideId: string; onMenu: () => void }) {
  const ride = useQuery({ queryKey: ['ride', rideId], queryFn: () => api(`/rides/${rideId}`), refetchInterval: 8000 });
  const livePos = useQuery<any>({ queryKey: ['driver-pos'], queryFn: () => null, enabled: false });
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const r = ride.data;
  const pos = useMemo(() => (r?.driver && livePos.data?.driverId === r.driver.id ? livePos.data : r?.driverLocation), [r, livePos.data]);
  if (!r) return <div className="r-app"><div className="r-splash"><Logo size={34} /></div></div>;
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); queryClient.invalidateQueries(); } catch (e: any) { setErr(e.message); } };
  const searching = ['REQUESTED', 'DISPATCHING', 'REASSIGNING'].includes(r.status);
  const toPickup = ['ACCEPTED', 'ARRIVING', 'EXCEPTION'].includes(r.status) && !r.startedAt;
  const remainingToPickup = pos ? Math.max(1, Math.round((haversineM(pos, r.pickup) * 1.25) / 300)) : null; // ~18 km/h city estimate
  const cars = pos ? [{ id: r.driver.id, lat: pos.lat, lng: pos.lng, heading: pos.heading, tone: 'assigned' as const }] : [];
  const fit = searching ? [r.pickup] : toPickup && pos ? [pos, r.pickup] : [r.pickup, r.destination];
  const routes = toPickup && pos ? [{ id: 'a', points: [pos, r.pickup] }] : [{ id: 't', points: [r.pickup, r.destination], style: searching ? ('muted' as const) : ('solid' as const) }];
  const title: Record<string, string> = {
    REQUESTED: 'Finding your ride', DISPATCHING: 'Finding your ride', REASSIGNING: 'Finding another driver', ACCEPTED: 'Driver is on the way', ARRIVING: 'Your driver has arrived',
    ONGOING: 'On the way', EXCEPTION: 'Checking on your driver', NO_DRIVER: 'No drivers available',
  };
  return (
    <MapShell
      map={{ pickup: { ...r.pickup, label: searching ? undefined : 'Pickup' }, drop: r.destination, cars, routes, fit, fitKey: `${r.status}-${toPickup && pos ? 'd' : ''}` }}
      top={<button className="r-icon" onClick={onMenu} aria-label="Menu"><Menu size={20} /></button>}
      sheet={
        <>
          <ConnectionDot />
          <div className="r-trip-head">
            <div>
              <h2>{title[r.status] ?? 'Your trip'}</h2>
              <p className="r-sub">
                {searching && (r.status === 'REASSIGNING' ? 'The previous driver couldn\'t take it — matching you with the next closest.' : 'Matching you with the closest available driver.')}
                {r.status === 'ACCEPTED' && `Arriving in about ${remainingToPickup ?? Math.round((r.pickupEtaSeconds ?? 240) / 60)} min`}
                {r.status === 'ARRIVING' && 'Meet your driver at the pickup point.'}
                {r.status === 'ONGOING' && `Estimated drop at ${clock(r.estTripSeconds)}`}
                {r.status === 'NO_DRIVER' && 'Everyone nearby is busy. Try again in a moment.'}
                {r.status === 'EXCEPTION' && "We've lost contact with your driver's location. Our team is on it."}
              </p>
            </div>
            {r.status === 'ACCEPTED' && <div className="r-eta"><b>{remainingToPickup ?? '—'}</b><span>min</span></div>}
          </div>
          {searching && <div className="r-progress"><i /></div>}
          {r.exceptionReason === 'DELAYED_ARRIVAL' && <Notice tone="warn">Your driver is running late. We're keeping an eye on it.</Notice>}
          {r.driver && (
            <div className="r-driver">
              <Avatar name={r.driver.name} size={52} />
              <div className="r-driver-main">
                <b>{r.driver.name}</b>
                <span className="r-muted">{r.driver.vehicle.color} {r.driver.vehicle.makeModel}</span>
                <Rating value={r.driver.rating} />
              </div>
              <Plate text={r.driver.vehicle.plate} />
            </div>
          )}
          {r.coRiders > 0 && <Notice>Shared ride · {r.coRiders} co-rider. Your fare stays {formatMoney(r.quotedFareMinor)}.</Notice>}
          <div className="r-divider" />
          <StopList pickup={r.pickup.label} drop={r.destination.label} />
          <div className="r-trip-meta"><span>{formatDistance(r.estTripMeters)} · {formatDuration(r.estTripSeconds)}</span><b>{formatMoney(r.quotedFareMinor)}</b></div>
          {err && <Notice tone="error">{err}</Notice>}
          {r.status === 'NO_DRIVER' ? (
            <div className="r-actions"><Button block size="lg" onClick={() => act(() => post(`/rides/${rideId}/retry`))}>Try again</Button><Button variant="ghost" block onClick={() => act(() => post(`/rides/${rideId}/cancel`, { reason: 'No driver' }))}>Cancel</Button></div>
          ) : r.allowedActions.includes('CANCELLED') ? (
            <div className="r-actions"><Button variant="secondary" block onClick={() => setConfirm(true)}>Cancel ride</Button></div>
          ) : null}
          <ConfirmSheet open={confirm} title="Cancel this ride?" body={r.acceptedAt ? 'Free within 2 minutes of the driver accepting. After that a ₹50 demo fee applies.' : 'Cancelling now is free.'}
            confirm="Yes, cancel" cancel="Keep my ride" danger onClose={() => setConfirm(false)} onConfirm={() => { setConfirm(false); act(() => post(`/rides/${rideId}/cancel`, { reason: 'Changed plans' })); }} />
        </>
      }
    />
  );
}

function Receipt({ ride, onDone }: { ride: any; onDone: () => void }) {
  if (!ride) { onDone(); return null; }
  return (
    <div className="r-page">
      <div className="r-receipt">
        <div className="r-check">✓</div>
        <h1>You've arrived</h1>
        <p className="r-sub">{new Date(ride.completedAt ?? ride.requestedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
        <div className="r-amount">{formatMoney(ride.finalFareMinor ?? ride.quotedFareMinor)}</div>
        {ride.driver && <Row icon={<Avatar name={ride.driver.name} size={40} />} title={ride.driver.name} sub={`${ride.driver.vehicle.makeModel} · ${ride.driver.vehicle.plate}`} />}
        <div className="r-divider" />
        <StopList pickup={ride.pickup.label} drop={ride.destination.label} />
        <div className="r-divider" />
        <FareRows fare={ride.fareBreakdown} />
        <Button block size="lg" onClick={onDone} style={{ marginTop: 22 }}>Done</Button>
      </div>
    </div>
  );
}

function Account({ items, onClose, onSignOut }: { items: any[]; onClose: () => void; onSignOut: () => void }) {
  const s = getSession();
  const past = items.filter((r) => !ACTIVE_STATUSES.includes(r.status));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="r-page">
      <div className="r-page-head"><button className="r-icon flat" onClick={onClose} aria-label="Close"><X size={20} /></button><Logo size={22} /></div>
      <div className="r-page-body">
        <Row icon={<Avatar name={s!.user.displayName} size={44} />} title={s!.user.displayName} sub="Demo rider account" />
        <div className="r-label" style={{ marginTop: 18 }}><History size={12} /> Your rides</div>
        {!past.length && <p className="r-fine">No trips yet. Your completed and cancelled rides will appear here.</p>}
        {past.map((r) => (
          <div key={r.id}>
            <Row onClick={() => setOpen(open === r.id ? null : r.id)} icon={<Car size={18} />} title={r.destination.label}
              sub={`${new Date(r.requestedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${r.status === 'COMPLETED' ? 'Completed' : r.status === 'NO_DRIVER' ? 'No driver' : 'Cancelled'}`}
              right={<b>{r.finalFareMinor != null ? formatMoney(r.finalFareMinor) : '—'}</b>} />
            {open === r.id && <div className="r-hist"><StopList pickup={r.pickup.label} drop={r.destination.label} compact /><FareRows fare={r.fareBreakdown} /></div>}
          </div>
        ))}
        <Button variant="secondary" block onClick={onSignOut} style={{ marginTop: 24 }}><LogOut size={16} /> Sign out</Button>
      </div>
    </div>
  );
}
