// Small formatting helpers shared by the whole page.

export function bytes(n: number | null | undefined, perSec = false): string {
  if (n == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n < 10 && i ? n.toFixed(1) : Math.round(n)) + ' ' + u[i] + (perSec ? '/s' : '');
}

/** "3d 4h", "2h 15m", "7m" */
export function dur(s: number): string {
  s = Math.floor(s);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Green, amber or red for a load, by its warning and critical levels. */
export function color(pct: number, warn = 70, crit = 90): string {
  return pct >= crit ? 'var(--red)' : pct >= warn ? 'var(--amber)' : 'var(--green)';
}

/** "1:02:03" or "2:03" for media positions. */
export function clock(sec: number | null | undefined): string {
  if (sec == null) return '–:––';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s2 = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s2}` : `${m}:${s2}`;
}

export function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export const hhmm = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** Today: "14:05"; earlier: "8 Oct". */
export function evTime(t: number): string {
  const d = new Date(t * 1000);
  return new Date().toDateString() === d.toDateString() ? hhmm(d) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Windows reports names in capitals ("OFFICE", "DESKTOP-4F2K"); make the plain ones readable. */
export function prettyName(n?: string): string {
  if (!n) return '';
  return /^[A-Z][A-Z]+$/.test(n) ? n[0] + n.slice(1).toLowerCase() : n;
}

/** Lowercase without accents, for matching typed text. */
export const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Mbit/s as people read it: "233", "64.5", "–". */
export const mbps = (v: number | null | undefined) => v == null ? '–' : v >= 100 ? String(Math.round(v)) : v.toFixed(1);

export const USER_OK = (v: string) =>
  !v || /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(v) ? '' : 'A user name can only have letters, digits and - _ .';
