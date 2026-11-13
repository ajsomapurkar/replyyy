import { useMemo, useRef, useState } from 'react';

export interface MapZone { id: string; name: string; polygon: { lat: number; lng: number }[]; heat?: number; badge?: string }
export interface MapDriver { id: string; lat: number; lng: number; state: string; stale?: boolean; heading?: number; label?: string }
export interface MapPin { id: string; lat: number; lng: number; kind: 'pickup' | 'dropoff' | 'me'; label?: string; tone?: string }
export interface MapRoute { id: string; from: { lat: number; lng: number }; to: { lat: number; lng: number }; tone?: string }

const B = { north: 12.9875, south: 12.9275, west: 77.5675, east: 77.6475 };
const W = 1000;
const LAT_SCALE = Math.cos((12.957 * Math.PI) / 180);
const H = Math.round((W * (B.north - B.south)) / ((B.east - B.west) * LAT_SCALE));
const px = (p: { lat: number; lng: number }) => ({ x: ((p.lng - B.west) / (B.east - B.west)) * W, y: ((B.north - p.lat) / (B.north - B.south)) * H });

const DRIVER_FILL: Record<string, string> = { AVAILABLE: 'var(--map-available)', OFFERED: 'var(--map-offered)', EN_ROUTE: 'var(--map-assigned)', ON_TRIP: 'var(--map-assigned)', OFFLINE: 'var(--map-offline)', NOT_APPROVED: 'var(--map-offline)' };

export function CityMap(props: {
  zones?: MapZone[]; drivers?: MapDriver[]; pins?: MapPin[]; routes?: MapRoute[];
  selectedId?: string | null; onSelectDriver?: (id: string) => void; onSelectZone?: (id: string) => void; onPick?: (p: { lat: number; lng: number }) => void;
  showHeat?: boolean; theme?: 'dark' | 'light'; height?: number | string; ariaLabel?: string;
}) {
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const streets = useMemo(() => {
    const lines: { d: string; major: boolean }[] = [];
    for (let i = 0, lng = 77.57; lng <= 77.645 + 1e-9; lng += 0.0025, i++) {
      const a = px({ lat: B.north, lng }), b = px({ lat: B.south, lng });
      lines.push({ d: `M${a.x},${a.y}L${b.x},${b.y}`, major: i % 5 === 0 });
    }
    for (let i = 0, lat = 12.93; lat <= 12.985 + 1e-9; lat += 0.0025, i++) {
      const a = px({ lat, lng: B.west }), b = px({ lat, lng: B.east });
      lines.push({ d: `M${a.x},${a.y}L${b.x},${b.y}`, major: i % 5 === 0 });
    }
    return lines;
  }, []);

  const clustered = useMemo(() => {
    const ds = props.drivers ?? [];
    if (view.s >= 1.4 || ds.length < 12) return { singles: ds, clusters: [] as { x: number; y: number; n: number; key: string }[] };
    const cell = 34 / view.s;
    const bins = new Map<string, MapDriver[]>();
    ds.forEach((d) => {
      const p = px(d);
      const k = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
      bins.set(k, [...(bins.get(k) ?? []), d]);
    });
    const singles: MapDriver[] = [], clusters: { x: number; y: number; n: number; key: string }[] = [];
    bins.forEach((v, k) => {
      if (v.length < 3 || v.some((d) => d.id === props.selectedId || d.state !== 'AVAILABLE')) singles.push(...v);
      else { const ps = v.map(px); clusters.push({ key: k, n: v.length, x: ps.reduce((a, p) => a + p.x, 0) / v.length, y: ps.reduce((a, p) => a + p.y, 0) / v.length }); }
    });
    return { singles, clusters };
  }, [props.drivers, view.s, props.selectedId]);

  const toWorld = (cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const sx = ((cx - r.left) / r.width) * W, sy = ((cy - r.top) / r.height) * H;
    return { x: (sx - view.x) / view.s, y: (sy - view.y) / view.s };
  };
  const zoom = (f: number, cx = W / 2, cy = H / 2) => setView((v) => {
    const s = Math.min(4, Math.max(1, v.s * f));
    const wx = (cx - v.x) / v.s, wy = (cy - v.y) / v.s;
    return clamp({ s, x: cx - wx * s, y: cy - wy * s });
  });
  const clamp = (v: { s: number; x: number; y: number }) => ({ s: v.s, x: Math.min(0, Math.max(W - W * v.s, v.x)), y: Math.min(0, Math.max(H - H * v.s, v.y)) });
  const k = 1 / view.s;

  return (
    <div className={`citymap ${props.theme === 'light' ? 'light' : ''}`} style={{ height: props.height ?? '100%' }}>
      <svg
        ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={props.ariaLabel ?? 'City map'}
        onWheel={(e) => { const r = svgRef.current!.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, ((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H); }}
        onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; }}
        onPointerMove={(e) => {
          const d = drag.current; if (!d) return;
          const r = svgRef.current!.getBoundingClientRect();
          const dx = ((e.clientX - d.x) / r.width) * W, dy = ((e.clientY - d.y) / r.height) * H;
          if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
          if (d.moved) setView((v) => clamp({ ...v, x: d.vx + dx, y: d.vy + dy }));
        }}
        onPointerUp={(e) => {
          const d = drag.current; drag.current = null;
          if (d && !d.moved && props.onPick && (e.target as Element).getAttribute('data-bg')) {
            const w = toWorld(e.clientX, e.clientY);
            props.onPick({ lat: B.north - (w.y / H) * (B.north - B.south), lng: B.west + (w.x / W) * (B.east - B.west) });
          }
        }}
      >
        <defs>
          <pattern id="dots" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".8" className="map-dot" /></pattern>
          <filter id="glow"><feGaussianBlur stdDeviation="3" /></filter>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.s})`}>
          <rect width={W} height={H} className="map-bg" data-bg="1" />
          <rect width={W} height={H} fill="url(#dots)" pointerEvents="none" />
          <path d={`M0,${H * 0.88} C${W * 0.25},${H * 0.8} ${W * 0.45},${H * 0.98} ${W * 0.7},${H * 0.9} S${W},${H * 0.86} ${W},${H * 0.84} L${W},${H} L0,${H}Z`} className="map-water" pointerEvents="none" />
          <g pointerEvents="none">{streets.map((s, i) => <path key={i} d={s.d} className={s.major ? 'map-street major' : 'map-street'} strokeWidth={(s.major ? 2.2 : 0.8) * Math.sqrt(k)} />)}</g>
          {(props.zones ?? []).map((z) => {
            const pts = z.polygon.map(px);
            const c = pts.slice(0, -1).reduce((a, p) => ({ x: a.x + p.x / (pts.length - 1), y: a.y + p.y / (pts.length - 1) }), { x: 0, y: 0 });
            const heat = props.showHeat ? Math.max(0, Math.min(1, z.heat ?? 0)) : 0;
            return (
              <g key={z.id} className="map-zone" onClick={() => props.onSelectZone?.(z.id)} style={{ cursor: props.onSelectZone ? 'pointer' : undefined }}>
                <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} className={`zone-poly ${props.selectedId === z.id ? 'sel' : ''}`} style={{ fillOpacity: props.showHeat ? 0.06 + heat * 0.42 : undefined, fill: props.showHeat ? `hsl(${38 - heat * 34} 95% 55%)` : undefined }} strokeWidth={1.4 * k} />
                <text x={c.x} y={c.y - 4 * k} className="zone-label" fontSize={13 * k} textAnchor="middle">{z.name}</text>
                {z.badge && <text x={c.x} y={c.y + 13 * k} className="zone-badge" fontSize={11 * k} textAnchor="middle">{z.badge}</text>}
              </g>
            );
          })}
          {(props.routes ?? []).map((r) => {
            const a = px(r.from), b = px(r.to);
            return <path key={r.id} d={`M${a.x},${a.y} L${b.x},${a.y} L${b.x},${b.y}`} className={`map-route ${r.tone ?? ''}`} strokeWidth={3 * k} strokeDasharray={`${6 * k} ${5 * k}`} fill="none" pointerEvents="none" />;
          })}
          {(props.pins ?? []).map((p) => {
            const q = px(p);
            return (
              <g key={p.id} transform={`translate(${q.x},${q.y}) scale(${k})`} pointerEvents="none">
                {p.kind === 'pickup' && <><rect x={-7} y={-7} width={14} height={14} rx={3} className="pin pickup" /><circle r={2.5} fill="#fff" /></>}
                {p.kind === 'dropoff' && <><path d="M-1,-18 L-1,4 M-1,-18 L11,-13 L-1,-8" className="pin-flag" /><circle r={3} className="pin dropoff" /></>}
                {p.kind === 'me' && <><circle r={14} className="pin-me-halo" /><circle r={6} className="pin me" /></>}
                {p.label && <text y={-12} textAnchor="middle" className="pin-label" fontSize={11}>{p.label}</text>}
              </g>
            );
          })}
          {clustered.clusters.map((c) => (
            <g key={c.key} transform={`translate(${c.x},${c.y}) scale(${k})`} className="cluster" onClick={() => zoom(1.8, c.x * view.s + view.x, c.y * view.s + view.y)}>
              <circle r={13} /><text textAnchor="middle" dy={4} fontSize={11}>{c.n}</text>
            </g>
          ))}
          {clustered.singles.map((d) => {
            const q = px(d), sel = props.selectedId === d.id;
            const assigned = d.state === 'EN_ROUTE' || d.state === 'ON_TRIP';
            return (
              <g key={d.id} transform={`translate(${q.x},${q.y}) scale(${k})`} className={`drv ${d.stale ? 'stale' : ''} ${sel ? 'sel' : ''}`} onClick={(e) => { e.stopPropagation(); props.onSelectDriver?.(d.id); }} style={{ cursor: props.onSelectDriver ? 'pointer' : undefined }}>
                <title>{`${d.label ?? 'Driver'} — ${d.state.toLowerCase().replace('_', ' ')}${d.stale ? ' (location stale)' : ''}`}</title>
                {sel && <circle r={15} className="drv-sel" />}
                {assigned ? (
                  <path d="M0,-9 L7,7 L0,3 L-7,7Z" transform={`rotate(${d.heading ?? 0})`} style={{ fill: DRIVER_FILL[d.state] }} className="drv-shape" />
                ) : d.state === 'OFFERED' ? (
                  <rect x={-6} y={-6} width={12} height={12} transform="rotate(45)" style={{ fill: DRIVER_FILL[d.state] }} className="drv-shape" />
                ) : (
                  <circle r={6} style={{ fill: d.stale ? 'transparent' : DRIVER_FILL[d.state] ?? 'var(--map-offline)' }} className="drv-shape" />
                )}
                {d.stale && <text y={4} textAnchor="middle" fontSize={9} className="drv-stale-mark">!</text>}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="map-zoom" role="group" aria-label="Map zoom">
        <button onClick={() => zoom(1.3)} aria-label="Zoom in">+</button>
        <button onClick={() => zoom(1 / 1.3)} aria-label="Zoom out">−</button>
        <button onClick={() => setView({ s: 1, x: 0, y: 0 })} aria-label="Reset view">⤢</button>
      </div>
    </div>
  );
}

export function MapLegend({ heat }: { heat?: boolean }) {
  return (
    <div className="map-legend" aria-label="Map legend">
      <span><i className="lg-dot" style={{ background: 'var(--map-available)' }} />Available</span>
      <span><i className="lg-diamond" style={{ background: 'var(--map-offered)' }} />Offer pending</span>
      <span><i className="lg-arrow" />Assigned / on trip</span>
      <span><i className="lg-stale">!</i>Stale GPS</span>
      <span><i className="lg-square" />Pickup</span>
      {heat && <span><i className="lg-heat" />Forecast gap (simulated)</span>}
    </div>
  );
}
