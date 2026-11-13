import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LocateFixed, Minus, Plus } from 'lucide-react';

export interface LL { lat: number; lng: number }
export interface MapCar { id: string; lat: number; lng: number; heading?: number; tone?: 'default' | 'assigned' | 'me' }
export interface MapRoute { id: string; points: LL[]; style?: 'solid' | 'muted' }
export interface MapPlace { label: string; lat: number; lng: number }
export interface Padding { top: number; right: number; bottom: number; left: number }

/* Synthetic "Relay Demo City" — fixed world projection */
const B = { north: 12.993, south: 12.922, west: 77.561, east: 77.654 };
const W = 1000;
const H = Math.round((W * (B.north - B.south)) / ((B.east - B.west) * Math.cos((12.957 * Math.PI) / 180)));
const UNIT_M = ((B.east - B.west) * 111_320 * Math.cos((12.957 * Math.PI) / 180)) / W; // metres per world unit
export const project = (p: LL) => ({ x: ((p.lng - B.west) / (B.east - B.west)) * W, y: ((B.north - p.lat) / (B.north - B.south)) * H });
export const unproject = (x: number, y: number): LL => ({ lat: B.north - (y / H) * (B.north - B.south), lng: B.west + (x / W) * (B.east - B.west) });

/** Grid route (east/west leg first, then north/south) — matches how simulated cars drive the street grid. */
export function gridPath(points: LL[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  points.forEach((p, i) => {
    if (i > 0) out.push(project({ lat: points[i - 1].lat, lng: p.lng }));
    out.push(project(p));
  });
  return out;
}

const ARTERIAL_NAMES_NS = ['Mill Rd', 'Fort Ave', 'Lantern St', 'Clocktower Rd', 'Orbit Ave', 'Data Bay Rd', 'Campus Way', 'Science Ave', 'Runway Rd'];
const ARTERIAL_NAMES_EW = ['Northgate Rd', 'Library St', 'Ring Road', 'Market St', 'Harbour Rd', 'Pier Ave'];
const PARKS: [number, number, number, number][] = [[77.574, 12.981, 77.582, 12.975], [77.6, 12.968, 77.606, 12.963], [77.628, 12.979, 77.638, 12.972], [77.583, 12.948, 77.59, 12.942], [77.632, 12.951, 77.64, 12.944]];

export function StreetMap(props: {
  cars?: MapCar[];
  pickup?: (LL & { label?: string }) | null;
  drop?: (LL & { label?: string }) | null;
  routes?: MapRoute[];
  places?: MapPlace[];
  fit?: LL[];
  fitKey?: string;
  padding?: Partial<Padding>;
  pinMode?: boolean;
  pinLabel?: string;
  onCenterChange?: (p: LL) => void;
  onPlaceClick?: (p: MapPlace) => void;
  overlay?: ReactNode;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 390, h: 700 });
  const pad: Padding = { top: 72, right: 24, bottom: 24, left: 24, ...props.padding };
  const zMax = Math.max(W / size.w, H / size.h) * 1.05;
  const zMin = 0.06;
  const [view, setView] = useState({ cx: W / 2, cy: H / 2, z: 1.2 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const anim = useRef<number>();
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 390, h: el.clientHeight || 700 }));
    ro.observe(el);
    setSize({ w: el.clientWidth || 390, h: el.clientHeight || 700 });
    return () => ro.disconnect();
  }, []);

  const clampZ = (z: number) => Math.min(zMax, Math.max(zMin, z));
  const target = () => {
    const pts = (props.fit?.length ? props.fit : [unproject(W / 2, H / 2)]).map(project);
    let minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    let minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    const minSpan = 70;
    if (maxX - minX < minSpan) { const c = (minX + maxX) / 2; minX = c - minSpan / 2; maxX = c + minSpan / 2; }
    if (maxY - minY < minSpan) { const c = (minY + maxY) / 2; minY = c - minSpan / 2; maxY = c + minSpan / 2; }
    const aw = Math.max(80, size.w - pad.left - pad.right), ah = Math.max(80, size.h - pad.top - pad.bottom);
    const z = clampZ(Math.max((maxX - minX) / aw, (maxY - minY) / ah) * 1.15);
    return { z, cx: (minX + maxX) / 2 + ((pad.right - pad.left) / 2) * z, cy: (minY + maxY) / 2 + ((pad.bottom - pad.top) / 2) * z };
  };
  const animateTo = (t: { cx: number; cy: number; z: number }, ms = 520) => {
    cancelAnimationFrame(anim.current!);
    const from = { ...viewRef.current }, t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      setView({ cx: from.cx + (t.cx - from.cx) * e, cy: from.cy + (t.cy - from.cy) * e, z: from.z * Math.pow(t.z / from.z, e) });
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };
  const first = useRef(true);
  useEffect(() => {
    const t = target();
    if (first.current) { first.current = false; setView(t); } else animateTo(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey, size.w, size.h, pad.bottom, pad.left]);

  // report the pin position (visual centre of the unobstructed area)
  const pinScreen = { x: pad.left + (size.w - pad.left - pad.right) / 2, y: pad.top + (size.h - pad.top - pad.bottom) / 2 };
  const toWorld = (sx: number, sy: number, v = view) => ({ x: v.cx + (sx - size.w / 2) * v.z, y: v.cy + (sy - size.h / 2) * v.z });
  useEffect(() => {
    if (!props.onCenterChange) return;
    const w = toWorld(pinScreen.x, pinScreen.y);
    const id = setTimeout(() => props.onCenterChange!(unproject(w.x, w.y)), 120);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, props.pinMode]);

  const zoomAt = (f: number, sx = size.w / 2, sy = size.h / 2) => {
    cancelAnimationFrame(anim.current!);
    setView((v) => {
      const z = clampZ(v.z / f);
      const w = toWorld(sx, sy, v);
      return { z, cx: w.x - (sx - size.w / 2) * z, cy: w.y - (sy - size.h / 2) * z };
    });
  };

  const { z } = view;
  const vb = `${view.cx - (size.w * z) / 2} ${view.cy - (size.h * z) / 2} ${size.w * z} ${size.h * z}`;
  const px = (n: number) => n * z; // screen pixels → world units

  const roads = useMemo(() => {
    const minor: string[] = [], arterial: { d: string; name: string; vertical: boolean; at: number }[] = [];
    let i = 0;
    for (let lng = 77.5625; lng <= 77.6525; lng += 0.00125, i++) {
      const a = project({ lat: B.north, lng }), b = project({ lat: B.south, lng });
      if (i % 8 === 0) arterial.push({ d: `M${a.x},${a.y}V${b.y}`, name: ARTERIAL_NAMES_NS[(i / 8) % ARTERIAL_NAMES_NS.length], vertical: true, at: a.x });
      else minor.push(`M${a.x},${a.y}V${b.y}`);
    }
    i = 0;
    for (let lat = 12.9225; lat <= 12.9925; lat += 0.00125, i++) {
      const a = project({ lat, lng: B.west }), b = project({ lat, lng: B.east });
      if (i % 8 === 4) arterial.push({ d: `M${a.x},${a.y}H${b.x}`, name: ARTERIAL_NAMES_EW[Math.floor(i / 8) % ARTERIAL_NAMES_EW.length], vertical: false, at: a.y });
      else minor.push(`M${a.x},${a.y}H${b.x}`);
    }
    return { minor: minor.join(''), arterial };
  }, []);
  const parks = useMemo(() => PARKS.map(([w, n, e, s]) => { const a = project({ lat: n, lng: w }), b = project({ lat: s, lng: e }); return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }; }), []);
  const river = useMemo(() => {
    const pts = [[77.555, 12.9305], [77.575, 12.932], [77.595, 12.9285], [77.615, 12.9315], [77.635, 12.929], [77.66, 12.931]].map(([lng, lat]) => project({ lat, lng }));
    return `M${pts.map((p) => `${p.x},${p.y}`).join(' L')}`;
  }, []);

  const minorW = Math.max(9 / UNIT_M, px(0.8));
  const artW = Math.max(16 / UNIT_M, px(2));
  const showMinor = z < 0.9;
  const labelEvery = 260;

  return (
    <div ref={box} className={`smap ${props.className ?? ''}`}>
      <svg
        viewBox={vb} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Map"
        onWheel={(e) => { const r = box.current!.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top); }}
        onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); cancelAnimationFrame(anim.current!); drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false }; }}
        onPointerMove={(e) => {
          const d = drag.current; if (!d) return;
          const dx = e.clientX - d.x, dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
          setView((v) => ({ ...v, cx: d.cx - dx * v.z, cy: d.cy - dy * v.z }));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
      >
        <rect x={-3000} y={-3000} width={7000} height={7000} className="m-land" />
        {parks.map((p, i) => <rect key={i} {...p} rx={4} className="m-park" />)}
        <path d={river} className="m-water" strokeWidth={34} fill="none" strokeLinecap="round" />
        {showMinor && <path d={roads.minor} className="m-road-case" strokeWidth={minorW + px(1.2)} />}
        {showMinor && <path d={roads.minor} className="m-road" strokeWidth={minorW} />}
        {roads.arterial.map((r, i) => <path key={`c${i}`} d={r.d} className={r.name === 'Ring Road' ? 'm-hwy-case' : 'm-art-case'} strokeWidth={artW + px(1.6)} />)}
        {roads.arterial.map((r, i) => <path key={`a${i}`} d={r.d} className={r.name === 'Ring Road' ? 'm-hwy' : 'm-art'} strokeWidth={artW} />)}
        {z < 1.1 && roads.arterial.map((r, i) => {
          const items = [];
          for (let t = 120; t < (r.vertical ? H : W); t += labelEvery * Math.max(0.6, z)) {
            const x = r.vertical ? r.at : t, y = r.vertical ? t : r.at;
            items.push(<text key={t} x={x} y={y} dy={px(3.5)} fontSize={px(10.5)} textAnchor="middle" className="m-label" transform={r.vertical ? `rotate(-90 ${x} ${y})` : undefined}>{r.name}</text>);
          }
          return <g key={`l${i}`}>{items}</g>;
        })}
        {z < 0.55 && (props.places ?? []).filter((p) => p.label !== props.pickup?.label && p.label !== props.drop?.label).map((p) => {
          const q = project(p);
          return (
            <g key={p.label} className="m-poi" onClick={() => props.onPlaceClick?.(p)}>
              <circle cx={q.x} cy={q.y} r={px(3.5)} />
              <text x={q.x + px(7)} y={q.y + px(3.5)} fontSize={px(11)}>{p.label}</text>
            </g>
          );
        })}
        {(props.routes ?? []).map((r) => {
          const d = gridPath(r.points).map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join('');
          return (
            <g key={r.id}>
              <path d={d} className="m-route-case" strokeWidth={px(r.style === 'muted' ? 7 : 9)} />
              <path d={d} className={`m-route ${r.style ?? 'solid'}`} strokeWidth={px(r.style === 'muted' ? 3.5 : 5)} strokeDasharray={r.style === 'muted' ? `${px(1)} ${px(7)}` : undefined} />
            </g>
          );
        })}
        {(props.cars ?? []).map((c) => {
          const q = project(c);
          return (
            <g key={c.id} transform={`translate(${q.x} ${q.y}) rotate(${c.heading ?? 0}) scale(${z})`} className={`m-car ${c.tone ?? 'default'}`}>
              <ellipse cx={0.6} cy={1.2} rx={8} ry={12.5} className="car-shadow" />
              <rect x={-6.5} y={-11} width={13} height={22} rx={4.5} className="car-body" />
              <rect x={-4.8} y={-6.6} width={9.6} height={4.4} rx={1.6} className="car-glass" />
              <rect x={-4.8} y={4} width={9.6} height={3.2} rx={1.4} className="car-glass" />
            </g>
          );
        })}
        {props.pickup && (() => {
          const q = project(props.pickup);
          return (
            <g transform={`translate(${q.x} ${q.y}) scale(${z})`} className="m-pick">
              <circle r={14} className="halo" /><circle r={7.5} className="dot" />
              {props.pickup.label && <PinLabel text={props.pickup.label} />}
            </g>
          );
        })()}
        {props.drop && (() => {
          const q = project(props.drop);
          return (
            <g transform={`translate(${q.x} ${q.y}) scale(${z})`} className="m-drop">
              <path d="M0,0 C-2,-6 -9,-10 -9,-17 a9,9 0 1 1 18,0 C9,-10 2,-6 0,0Z" className="pin" /><circle cy={-17} r={3.4} fill="#fff" />
              {props.drop.label && <PinLabel text={props.drop.label} y={-38} />}
            </g>
          );
        })()}
      </svg>
      {props.pinMode && (
        <div className="m-center-pin" style={{ left: pinScreen.x, top: pinScreen.y }}>
          {props.pinLabel && <span className="m-center-label">{props.pinLabel}</span>}
          <svg width="30" height="42" viewBox="-15 -40 30 42"><path d="M0,0 C-2,-8 -12,-14 -12,-25 a12,12 0 1 1 24,0 C12,-14 2,-8 0,0Z" fill="#1c1c1c" /><circle cy={-25} r={4.5} fill="#ffd400" /></svg>
        </div>
      )}
      <div className="m-ctrl" style={{ bottom: pad.bottom + 12, right: pad.right > 40 ? 16 : pad.right + 4 }}>
        <button className="m-zoom" onClick={() => zoomAt(1.4)} aria-label="Zoom in"><Plus size={18} /></button>
        <button className="m-zoom" onClick={() => zoomAt(1 / 1.4)} aria-label="Zoom out"><Minus size={18} /></button>
        <button onClick={() => animateTo(target())} aria-label="Recenter"><LocateFixed size={18} /></button>
      </div>
      {props.overlay}
    </div>
  );
}

function PinLabel({ text, y = -26 }: { text: string; y?: number }) {
  const w = Math.min(170, text.length * 6.6 + 20);
  return (
    <g transform={`translate(0 ${y})`} className="m-pinlabel">
      <rect x={-w / 2} y={-13} width={w} height={22} rx={11} />
      <text y={2} textAnchor="middle" fontSize={11.5}>{text.length > 24 ? text.slice(0, 23) + '…' : text}</text>
    </g>
  );
}
