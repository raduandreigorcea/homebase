// What the Homebase service sends (GET /api/state) and the calls the page makes to it.

export type Kind = 'desktop' | 'laptop' | 'pi' | 'tv' | 'phone' | 'router' | 'other';

export interface HbEvent {
  t: number;
  kind: string;   // on | off | new | info
  text: string;
  dev?: string;
}

export interface Device {
  id: string;
  name: string;
  kind: Kind;
  host: string;
  mac?: string;
  os?: string;
  probe_port?: number;
  ssh?: boolean;
  ssh_user?: string;
  key?: boolean;          // Homebase's SSH key works on it
  dlna?: object;          // a TV driven over DLNA
  windows: boolean;
  has_wake: boolean;
  nla?: number;           // Windows, once prepared: 0 = signs in on the Windows screen, -1 = no Remote Desktop
  rdp?: boolean | null;   // Windows: does Remote Desktop answer
  power?: 'reboot' | 'poweroff' | null;  // a restart / shutdown asked for and not done yet
  recent?: HbEvent[];     // this device's latest events
}

export interface Status {
  online: boolean | null;  // null: still being checked
  latency: number | null;
  since?: number;
}

/** Stats read over SSH (Linux) or sent by the agent (Windows); the fields both have, and the rest. */
export interface Stats {
  t: number;
  cpu: number | null;
  mem_total: number;
  mem_free: number;
  disk_total?: number;
  disk_free?: number;
  temp?: number;
  gpu?: number | null;
  boot?: number;
  kernel?: string;
  model?: string;
  os?: string;
  top_name?: string;
  top_cpu?: number;
  net_down?: number;
  net_up?: number;
}

export interface Tv {
  volume: number;
  mute: boolean;
  state: string;  // PLAYING, PAUSED_PLAYBACK, STOPPED, NO_MEDIA_PRESENT
  title: string | null;
  pos: number | null;
  dur: number | null;
}

export interface Found {
  ip: string;
  mac: string;
  kind: Kind;
  name?: string;
  hostname?: string;
  label?: string;
  vendor?: string;
}

export interface Laptop {
  cpu: number;
  mem: { total: number; used: number; pct: number };
  net: { signal?: number; ssid?: string };
  temps: { cpu?: number };
  battery: { pct: number; status: string } | null;
  ip?: string | null;
}

/** The internet over a day / week / month (GET /api/nethistory?range=...). A point without avg wasn't measured. */
export interface NetPoint { t: number; avg?: number; max?: number; loss?: number }
export interface Outage { start: number; end: number; ongoing?: boolean }
export interface NetHistory {
  range: 'day' | 'week' | 'month';
  step: number;
  points: NetPoint[];
  outages: Outage[];
  measured: number;
  uptime: number | null;
  avg: number | null;
  worst: number | null;
}

export interface Internet {
  online: boolean;
  latency: number | null;
  since?: number;
  down_since?: number;
  ssid?: string;
}

export interface State {
  now: number;
  ui: number;
  netbook: Laptop;
  devices: Device[];
  status: Record<string, Status>;
  stats: Record<string, Stats>;
  sshstats: Record<string, Stats>;
  tv: Record<string, Tv>;
  discovered: Found[];
  last_scan: number;
  internet: Internet | null;
  events: HbEvent[];
  history: Record<string, (number | null)[]>;
}

/** A speed test's progress: the internet one (/api/netspeed) or to a device (/api/devspeed). */
export interface SpeedRun {
  phase: 'idle' | 'ping' | 'download' | 'upload' | 'done' | 'error';
  live?: number;
  progress?: number;
  ping?: number;
  jitter?: number;
  down?: number | null;
  up?: number | null;
  server?: string;
  dev?: string;
  finished?: number;
  error?: string;
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  return r.json();
}

/** POST, with an optional JSON body. Resolves to the answer, or {} when the server can't be reached. */
export async function post<T = { ok?: boolean; error?: string }>(url: string, body?: unknown): Promise<T> {
  try {
    const r = await fetch(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    return await r.json();
  } catch {
    return {} as T;
  }
}

export const enc = encodeURIComponent;
