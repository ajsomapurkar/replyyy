import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { Car, Gauge, ShieldCheck, User } from 'lucide-react';
import { api, live, post, setSession, queryClient } from '../lib/api';
import { Wordmark } from '../components/Brand';
import { ErrorState, Skeleton } from '../components/ui';

const ROLE_META: Record<string, { title: string; desc: string; icon: any; path: string }> = {
  PASSENGER: { title: 'Passenger', desc: 'Book and track a trip', icon: User, path: '/ride' },
  DRIVER: { title: 'Driver', desc: 'Go online, take offers, run trips', icon: Car, path: '/drive' },
  OPERATOR: { title: 'Operations', desc: 'Control Tower: dispatch, zones, analytics', icon: Gauge, path: '/ops' },
  ADMIN: { title: 'Admin', desc: 'Control Tower + demo reset', icon: ShieldCheck, path: '/ops' },
};

export function Login() {
  const nav = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const q = useQuery({ queryKey: ['demo-accounts'], queryFn: () => api('/auth/demo-accounts') });
  const signIn = async (a: any) => {
    setBusy(a.id); setErr(null);
    try {
      const s = await post('/auth/demo-session', { userId: a.id });
      live.close(); queryClient.clear(); setSession(s);
      nav(ROLE_META[a.role].path);
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const groups = ['OPERATOR', 'ADMIN'];
  const host = location.hostname;
  return (
    <div className="login">
      <div className="login-hero">
        <Wordmark />
        <h1>Explainable dispatch,<br />reliable recovery.</h1>
        <p>Relay matches every ride to an eligible driver by estimated pickup time and transparent criteria — and recovers gracefully when the first plan fails.</p>
        <ul className="login-points">
          <li><b>Every assignment explained</b> — ranked candidates, score components, and a sentence an operator can read.</li>
          <li><b>Correct before clever</b> — atomic acceptance; no driver is ever double-assigned.</li>
          <li><b>Zone intelligence</b> — forecast vs actual demand, supply gaps, advisory repositioning.</li>
        </ul>
        <div className="sim-note">Demo environment · synthetic city, people and demand · all prices and forecasts are simulated.</div>
      </div>
      <div className="login-panel">
        <h2>Relay Console</h2>
        <p className="muted">Operations sign-in (demo — no identity verification).</p>
        {err ? <ErrorState error={err} /> : null}
        {q.isLoading && <div className="stack">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={58} />)}</div>}
        {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}
        {q.data && groups.map((g) => {
          const accts = q.data.accounts.filter((a: any) => a.role === g);
          if (!accts.length) return null;
          const M = ROLE_META[g];
          return (
            <div key={g} className="role-group">
              <div className="role-head"><M.icon size={15} /> {M.title} <span className="muted">· {M.desc}</span></div>
              {accts.map((a: any) => (
                <button key={a.id} className="acct" onClick={() => signIn(a)} disabled={!!busy}>
                  <span className="avatar">{a.name.split(' ').map((p: string) => p[0]).join('').slice(0, 2)}</span>
                  <span className="acct-main"><b>{a.name}</b><span className="muted">{a.vehicle ?? a.email}</span></span>
                  <span className="acct-go">{busy === a.id ? 'Signing in…' : 'Continue →'}</span>
                </button>
              ))}
            </div>
          );
        })}
        <div className="apps-links">
          <a href={import.meta.env.DEV ? `http://${host}:5174` : "/rider/"}><b>Rider app →</b><span className="muted">Book and track rides</span></a>
          <a href={import.meta.env.DEV ? `http://${host}:5175` : "/driver/"}><b>Driver app →</b><span className="muted">Go on duty, take trips</span></a>
        </div>
      </div>
    </div>
  );
}
