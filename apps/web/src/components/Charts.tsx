import { useState } from 'react';

export function BarChart({ data, unit, height = 150, tone = 'accent', format }: { data: { label: string; value: number }[]; unit?: string; height?: number; tone?: string; format?: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length || data.every((d) => !d.value)) return <div className="chart-empty">No data in this range</div>;
  const max = Math.max(...data.map((d) => d.value), 1);
  const W = 100 / data.length;
  const f = format ?? ((v: number) => String(Math.round(v)));
  return (
    <div className="chart" style={{ height }}>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" role="img" aria-label={data.map((d) => `${d.label}: ${f(d.value)}${unit ?? ''}`).join(', ')}>
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1="0" x2="100" y1={(height - 18) * g} y2={(height - 18) * g} className="grid" />)}
        {data.map((d, i) => {
          const h = ((height - 22) * d.value) / max;
          return <rect key={i} x={i * W + W * 0.16} width={W * 0.68} y={height - 18 - h} height={Math.max(h, 0.5)} rx="0.6" className={`bar ${tone} ${hover === i ? 'hi' : ''}`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />;
        })}
      </svg>
      <div className="chart-x">{data.map((d, i) => <span key={i} style={{ width: `${W}%` }}>{d.label}</span>)}</div>
      {hover !== null && <div className="chart-tip" style={{ left: `${(hover + 0.5) * W}%` }}>{data[hover].label}: <b>{f(data[hover].value)}{unit}</b></div>}
    </div>
  );
}

export function ForecastChart({ series, height = 190 }: { series: { t: string; actual: number | null; forecast: number | null; low: number | null; high: number | null; partial?: boolean }[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!series.length) return <div className="chart-empty">No forecast data</div>;
  const W = 600, H = height, pad = 22;
  const max = Math.max(4, ...series.map((s) => Math.max(s.actual ?? 0, s.high ?? 0)));
  const x = (i: number) => pad + (i / Math.max(1, series.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = (k: 'actual' | 'forecast') => series.map((s, i) => (s[k] == null ? null : `${x(i)},${y(s[k]!)}`)).filter(Boolean).join(' ');
  const band = series.map((s, i) => (s.high == null ? null : `${x(i)},${y(s.high)}`)).filter(Boolean).concat(series.map((s, i) => (s.low == null ? null : `${x(i)},${y(s.low)}`)).filter(Boolean).reverse()).join(' ');
  const nowIdx = series.findIndex((s) => s.partial);
  const fmt = (t: string) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="chart fc" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Forecast versus actual demand, last 24 hours and next hour" onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGElement).getBoundingClientRect(); const i = Math.round((((e.clientX - r.left) / r.width) * W - pad) / ((W - pad * 2) / (series.length - 1))); setHover(Math.max(0, Math.min(series.length - 1, i))); }}>
        {[0.25, 0.5, 0.75, 1].map((g) => <g key={g}><line x1={pad} x2={W - pad} y1={y(max * g)} y2={y(max * g)} className="grid" /><text x={2} y={y(max * g) + 3} className="axis">{Math.round(max * g)}</text></g>)}
        {band && <polygon points={band} className="fc-band" />}
        <polyline points={line('forecast')} className="fc-line forecast" />
        <polyline points={line('actual')} className="fc-line actual" />
        {nowIdx >= 0 && <g><line x1={x(nowIdx)} x2={x(nowIdx)} y1={pad / 2} y2={H - pad} className="fc-now" /><text x={x(nowIdx) + 4} y={pad} className="axis">now</text></g>}
        {[0, Math.floor(series.length / 2), series.length - 1].map((i) => <text key={i} x={x(i)} y={H - 5} textAnchor="middle" className="axis">{fmt(series[i].t)}</text>)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad / 2} y2={H - pad} className="fc-hover" />}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          {fmt(series[hover].t)} · actual <b>{series[hover].actual ?? '—'}</b>{series[hover].partial ? ' (partial)' : ''} · forecast <b>{series[hover].forecast != null ? Number(series[hover].forecast).toFixed(1) : '—'}</b>
          {series[hover].low != null && <> ({Number(series[hover].low).toFixed(0)}–{Number(series[hover].high).toFixed(0)})</>}
        </div>
      )}
      <div className="fc-legend"><span><i className="sw actual" />Actual (simulated)</span><span><i className="sw forecast" />Forecast</span><span><i className="sw band" />≈80% range</span></div>
    </div>
  );
}
