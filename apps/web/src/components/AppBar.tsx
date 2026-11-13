import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getSession, live, queryClient, setSession } from '../lib/api';
import { Wordmark } from './Brand';
import { ConnectionIndicator } from './ui';

export function useSignOut() {
  const nav = useNavigate();
  return () => { live.close(); setSession(null); queryClient.clear(); nav('/login'); };
}
export function AppBar({ subtitle }: { subtitle: string }) {
  const s = getSession();
  const out = useSignOut();
  return (
    <header className="appbar">
      <Wordmark /><span className="appbar-sub">{subtitle}</span>
      <div className="grow" />
      <ConnectionIndicator />
      <span className="appbar-user">{s?.user.displayName}</span>
      <button className="icon-btn" onClick={out} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>
    </header>
  );
}
