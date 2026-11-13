export function RelayMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--mark-bg)" />
      <path d="M9 22 L16 9 L23 22" stroke="var(--accent)" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="22" r="2.2" fill="var(--accent)" />
    </svg>
  );
}
export function Wordmark() {
  return <span className="wordmark"><RelayMark /> <span>Relay</span></span>;
}
