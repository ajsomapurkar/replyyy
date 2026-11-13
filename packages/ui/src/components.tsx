import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatMoney, type FareBreakdown } from '@relay/contracts';
import { ChevronRight, Loader2, Star, X } from 'lucide-react';
import { api, live, post, queryClient, setSession, useConnection } from './api';

export function Logo({ size = 26, inverse }: { size?: number; inverse?: boolean }) {
  return (
    <span className={`r-logo ${inverse ? 'inverse' : ''}`} style={{ fontSize: size }}>
      <span className="r-logo-mark" aria-hidden>
        <svg viewBox="0 0 24 24" width={size * 0.9} height={size * 0.9}><path d="M5 18 L12 5 L19 18" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      relay
    </span>
  );
}

/** Bottom sheet on phones, floating side panel ≥ 820px. */
export function Sheet({ children, className, header }: { children: ReactNode; className?: string; header?: ReactNode }) {
  return (
    <section className={`r-sheet ${className ?? ''}`}>
      <div className="r-grabber" aria-hidden />
      {header}
      <div className="r-sheet-body">{children}</div>
    </section>
  );
}

export function Button({ children, variant = 'primary', size = 'md', block, loading, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'dark' | 'success' | 'secondary' | 'ghost' | 'danger'; size?: 'md' | 'lg'; block?: boolean; loading?: boolean }) {
  return (
    <button {...rest} className={`r-btn ${variant} ${size} ${block ? 'block' : ''} ${rest.className ?? ''}`} disabled={rest.disabled || loading}>
      {loading ? <Loader2 size={18} className="r-spin" /> : children}
    </button>
  );
}

export function Avatar({ name, size = 44 }: { name: string; size?: number }) {
  const initials = name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return <span className="r-avatar" style={{ width: size, height: size, fontSize: size * 0.36 }}>{initials}</span>;
}
export function Rating({ value }: { value: number }) {
  return <span className="r-rating"><Star size={12} fill="currentColor" /> {value.toFixed(1)}</span>;
}
export function Plate({ text }: { text: string }) {
  return <span className="r-plate">{text}</span>;
}

export function Row({ icon, title, sub, right, onClick, active }: { icon?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; active?: boolean }) {
  const C: any = onClick ? 'button' : 'div';
  return (
    <C className={`r-row ${onClick ? 'tap' : ''} ${active ? 'active' : ''}`} onClick={onClick}>
      {icon && <span className="r-row-icon">{icon}</span>}
      <span className="r-row-main"><span className="r-row-title">{title}</span>{sub && <span className="r-row-sub">{sub}</span>}</span>
      {right ?? (onClick ? <ChevronRight size={18} className="r-muted" /> : null)}
    </C>
  );
}

export function StopList({ pickup, drop, compact }: { pickup: string; drop: string; compact?: boolean }) {
  return (
    <div className={`r-stops ${compact ? 'compact' : ''}`}>
      <div className="r-stop"><i className="s-pick" /><span>{pickup}</span></div>
      <div className="r-stop-line" aria-hidden />
      <div className="r-stop"><i className="s-drop" /><span>{drop}</span></div>
    </div>
  );
}

export function FareRows({ fare }: { fare: FareBreakdown }) {
  return (
    <div className="r-fare">
      {fare.lines.map((l, i) => (
        <div key={i} className="r-fare-line"><span>{l.label}</span><span>{l.amountMinor < 0 ? '−' : ''}{formatMoney(Math.abs(l.amountMinor), fare.currency)}</span></div>
      ))}
      <div className="r-fare-total"><span>Total</span><span>{formatMoney(fare.totalMinor, fare.currency)}</span></div>
      <p className="r-fine">Simulated demo pricing. The price you see when booking is the price you pay.</p>
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  return <div className={`r-notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function ConnectionDot() {
  const s = useConnection();
  if (s === 'live') return null;
  return <div className="r-conn">{s === 'offline' ? 'You are offline' : 'Reconnecting…'}</div>;
}

export function Countdown({ expiresAt, total }: { expiresAt: string; total: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, []);
  const left = Math.max(0, (new Date(expiresAt).getTime() - now) / 1000);
  const r = 22, c = 2 * Math.PI * r;
  return (
    <span className="r-countdown" aria-label={`${Math.ceil(left)} seconds left`}>
      <svg width="54" height="54" viewBox="0 0 54 54"><circle cx="27" cy="27" r={r} className="track" /><circle cx="27" cy="27" r={r} className="bar" strokeDasharray={c} strokeDashoffset={c * (1 - left / total)} /></svg>
      <b>{Math.ceil(left)}</b>
    </span>
  );
}

/** Bottom-sheet style confirm (native <dialog>, keyboard + focus handled by the browser). */
export function ConfirmSheet({ open, title, body, confirm, cancel = 'Go back', danger, onConfirm, onClose }: { open: boolean; title: string; body?: string; confirm: string; cancel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current!; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  return (
    <dialog ref={ref} className="r-dialog" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <button className="r-icon r-dialog-x" onClick={onClose} aria-label="Close"><X size={18} /></button>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      <div className="r-dialog-actions">
        <Button variant={danger ? 'danger' : 'dark'} block size="lg" onClick={onConfirm}>{confirm}</Button>
        <Button variant="ghost" block onClick={onClose}>{cancel}</Button>
      </div>
    </dialog>
  );
}

/** Demo account picker, filtered to one role. */
export function DemoLogin({ role, title, subtitle, onDone }: { role: 'PASSENGER' | 'DRIVER'; title: string; subtitle: string; onDone: () => void }) {
  const q = useQuery({ queryKey: ['demo-accounts'], queryFn: () => api('/auth/demo-accounts') });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async (id: string) => {
    setBusy(id); setErr(null);
    try { const s = await post('/auth/demo-session', { userId: id }); live.close(); queryClient.clear(); setSession(s); onDone(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  };
  const accounts = (q.data?.accounts ?? []).filter((a: any) => a.role === role);
  return (
    <div className="r-login">
      <div className="r-login-top"><Logo size={30} /><h1>{title}</h1><p>{subtitle}</p></div>
      <div className="r-login-card">
        <div className="r-label">Continue as</div>
        {q.isLoading && <div className="r-skel" style={{ height: 64 }} />}
        {q.error && <Notice tone="error">Can't reach the Relay server. Is the API running on port 4000?</Notice>}
        {accounts.map((a: any) => (
          <Row key={a.id} onClick={() => go(a.id)} icon={<Avatar name={a.name} size={40} />} title={a.name} sub={a.vehicle ?? a.email}
            right={busy === a.id ? <Loader2 size={18} className="r-spin" /> : undefined} />
        ))}
        {err && <Notice tone="error">{err}</Notice>}
        <p className="r-fine">Demo sign-in · synthetic city and people · no real payments.</p>
      </div>
    </div>
  );
}

export function useSignOut(onOut: () => void) {
  return () => { live.close(); setSession(null); queryClient.clear(); onOut(); };
}

export function useMedia(q: string) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, [q]);
  return m;
}

export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000, r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
