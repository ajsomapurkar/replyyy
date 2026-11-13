import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import { getSession, setSession, queryClient } from './lib/api';
import { Login } from './pages/Login';
import { OpsApp } from './pages/Ops';

function Home() {
  const s = getSession();
  if (!s) return <Navigate to="/login" replace />;
  if (s.user.role === 'PASSENGER' || s.user.role === 'DRIVER') { setSession(null); return <Navigate to="/login" replace />; }
  return <Navigate to="/ops" replace />;
}
function Guard({ roles, children }: { roles: string[]; children: React.ReactNode }) {
  const s = getSession();
  if (!s) return <Navigate to="/login" replace />;
  if (!roles.includes(s.user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/ops/*" element={<Guard roles={['OPERATOR', 'ADMIN']}><OpsApp /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
