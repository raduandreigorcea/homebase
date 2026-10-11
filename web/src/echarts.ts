// Apache ECharts, trimmed to what the page uses and loaded only when a window that needs it opens (the
// speed test and the internet history), so it costs nothing at start-up.
let loading: Promise<typeof import('./echarts-bundle')> | null = null;

export const loadCharts = () => (loading ??= import('./echarts-bundle'));

/** The page's colours, read from the stylesheet so the charts follow it. */
export function palette() {
  const s = getComputedStyle(document.documentElement), v = (n: string, d: string) => s.getPropertyValue(n).trim() || d;
  return { blue: v('--blue', '#60a5fa'), violet: v('--violet', '#a78bfa'), red: v('--red', '#f87171'), text: v('--text', '#e6edf3'),
           dim: v('--dim', '#6b7885'), muted: v('--muted', '#9aa7b4'), track: v('--panel-2', '#161e28'), line: '#1b2430',
           panel: v('--panel', '#10161e'), mono: v('--mono', 'monospace') };
}
