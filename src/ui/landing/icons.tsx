// Small inline icons for the landing page (no icon font: it would be one more thing to load).
const base = { width: 1, height: 1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const Spark = ({ size = 16 }: { size?: number }) => (
  <svg {...base} width={size} height={size} viewBox="0 0 24 24"><path d="M12 2.5v19M3.8 7.2l16.4 9.6M3.8 16.8l16.4-9.6" /></svg>
);
export const ArrowUpRight = ({ size = 14 }: { size?: number }) => (
  <svg {...base} width={size} height={size} viewBox="0 0 16 16"><path d="M4 12 12 4M5.5 4H12v6.5" /></svg>
);
export const ArrowDown = ({ size = 14 }: { size?: number }) => (
  <svg {...base} width={size} height={size} viewBox="0 0 16 16"><path d="M8 2.5v11M3.5 9 8 13.5 12.5 9" /></svg>
);
export const Sun = () => (
  <svg {...base} width={16} height={16} viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></svg>
);
export const Moon = () => (
  <svg {...base} width={16} height={16} viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" /></svg>
);
export const Mark = () => (
  <svg width="30" height="30" viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M20 3.5c3.8 8.2 6.4 10.7 16.5 16.5C26.4 23.8 23.8 26.3 20 36.5 16.2 26.3 13.6 23.8 3.5 20 13.6 16.2 16.2 13.7 20 3.5Z" stroke="currentColor" strokeWidth="1.25" /><circle cx="20" cy="20" r="4.5" fill="currentColor" /></svg>
);
