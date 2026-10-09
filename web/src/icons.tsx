// Every icon on the page: device kinds, buttons, toasts, the TV remote.
import type { JSX } from 'preact';
import type { Kind } from './api';

type P = JSX.SVGAttributes<SVGSVGElement>;
const line = { fill: 'none', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;
const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

// Device kinds (drawn with the parent's stroke colour, set in CSS).
const Desktop = (p: P) => <svg viewBox="0 0 24 24" {...line} {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>;
const Laptop = (p: P) => <svg viewBox="0 0 24 24" {...line} {...p}><rect x="5" y="5" width="14" height="10" rx="1.5" /><path d="M2 19h20" /></svg>;
const Pi = (p: P) => <svg viewBox="0 0 24 24" {...line} {...p}><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></svg>;
const Phone = (p: P) => <svg viewBox="0 0 24 24" {...line} {...p}><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></svg>;
const Tv = (p: P) => <svg viewBox="0 0 24 24" {...line} {...p}><rect x="2" y="5" width="20" height="13" rx="2" /><path d="M8 22h8" /></svg>;
const Router = (p: P) => <svg viewBox="0 0 24 24" {...line} {...p}><rect x="2" y="13" width="20" height="7" rx="2" /><path d="M6 17h.01M10 17h.01M8 9a6 6 0 0 1 8 0M5 6a10 10 0 0 1 14 0" /></svg>;
const Other = (p: P) => <svg viewBox="0 0 24 24" {...line} {...p}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14M12 17h.01" /></svg>;

const KIND_ICONS: Record<string, (p: P) => JSX.Element> = { desktop: Desktop, laptop: Laptop, pi: Pi, phone: Phone, tv: Tv, router: Router, other: Other };
export const KindIcon = ({ kind }: { kind?: Kind | string }) => (KIND_ICONS[kind || 'other'] || Other)({});

// Buttons
export const Edit = () => <svg viewBox="0 0 24 24" {...stroke}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>;
export const Close = () => <svg viewBox="0 0 24 24" {...stroke}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const Plus = () => <svg viewBox="0 0 24 24" {...stroke}><path d="M12 5v14M5 12h14" /></svg>;
export const Refresh = () => <svg viewBox="0 0 24 24" {...stroke}><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></svg>;
export const Connect = () => <svg viewBox="0 0 24 24" {...stroke}><path d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>;
export const Power = () => <svg viewBox="0 0 24 24" {...stroke}><path d="M12 3v9M6.4 6.4a8 8 0 1 0 11.2 0" /></svg>;
export const Terminal = () => <svg viewBox="0 0 24 24" {...stroke}><path d="M4 17l6-5-6-5M12 19h8" /></svg>;

// Dialog icons: a device kind, or one of these.
export const DialogIcon = ({ name }: { name: string }) =>
  name === 'x' ? <Close /> : name === 'power' ? <Power /> : name === 'terminal' ? <Terminal /> : name === 'connect' ? <Connect />
    : <KindIcon kind={name} />;

// Toasts
export const ToastOk = () => <svg viewBox="0 0 24 24" {...stroke} stroke-width="2.5"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
export const ToastErr = () => <svg viewBox="0 0 24 24" {...stroke} stroke-width="2.5"><path d="M12 7v6M12 17h.01" /></svg>;
export const ToastInfo = () => <svg viewBox="0 0 24 24" {...stroke} stroke-width="2.5"><path d="M12 11v6M12 7h.01" /></svg>;

// TV remote
export const Play = () => <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z" /></svg>;
export const Pause = () => <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></svg>;
export const Stop = () => <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>;
export const Back = () => <svg viewBox="0 0 24 24" {...stroke}><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" /></svg>;
export const Fwd = () => <svg viewBox="0 0 24 24" {...stroke}><path d="M13 17l5-5-5-5M6 17l5-5-5-5" /></svg>;
export const Vol = () => <svg viewBox="0 0 24 24" {...stroke}><path d="M11 5L6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>;
export const Muted = () => <svg viewBox="0 0 24 24" {...stroke}><path d="M11 5L6 9H3v6h3l5 4z" /><path d="M22 9l-6 6M16 9l6 6" /></svg>;

/** Wi-Fi whose lit arcs follow the signal (like the battery's fill); crossed out when offline. */
export function WifiIcon({ signal, ok }: { signal?: number; ok: boolean }) {
  if (!ok) {
    return <svg viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="1.8" stroke-linecap="round">
      <path d="M4 9.5a12 12 0 0 1 16 0M7 13a7.5 7.5 0 0 1 10 0" /><circle cx="12" cy="17.5" r="1.3" fill="var(--red)" stroke="none" /><path d="M4 4l16 16" />
    </svg>;
  }
  const bars = signal == null ? 3 : signal > -60 ? 3 : signal > -70 ? 2 : 1;
  const arc = (d: string, on: boolean) => <path d={d} stroke={on ? 'currentColor' : 'var(--line)'} />;
  return <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round">
    {arc('M3.5 9.5a12.5 12.5 0 0 1 17 0', bars >= 3)}{arc('M6.5 12.8a8 8 0 0 1 11 0', bars >= 2)}{arc('M9.3 15.9a3.8 3.8 0 0 1 5.4 0', bars >= 1)}
    <circle cx="12" cy="18.8" r="1.3" fill="currentColor" />
  </svg>;
}

export function BatteryIcon({ pct, status }: { pct: number; status: string }) {
  const w = Math.max(1, Math.round(12 * pct / 100));
  const col = pct <= 15 && status === 'Discharging' ? 'var(--red)' : 'currentColor';
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
    <rect x="2.5" y="7" width="17" height="10" rx="2.5" /><path d="M21.5 10.5v3" stroke-linecap="round" />
    <rect x="5" y="9.5" width={w} height="5" rx="1" fill={col} stroke="none" />
    {status === 'Charging' && <path d="M11.5 8.5l-2 4h3l-2 3" stroke="var(--bg)" stroke-width="1.6" stroke-linecap="round" />}
  </svg>;
}
