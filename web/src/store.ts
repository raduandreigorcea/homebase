// The page's shared state. Signals: any component reading one redraws when it changes, nothing else does.
import { computed, signal } from '@preact/signals';
import { getJSON, type Device, type State } from './api';

export const state = signal<State | null>(null);
export const lastOk = signal(0);  // when the server last answered
export const offline = signal(false);  // it hasn't answered for a while

// Which windows are open. One device screen at a time; the terminal and internet speed test sit on top of it.
export const detailId = signal<string | null>(null);
export const paletteOpen = signal(false);
export const netSpeedOpen = signal(false);
export const historyOpen = signal(false);  // the internet's history window
/** A device whose screen should start a speed test as it opens (asked from the palette or a card). */
export const speedStart = signal<string | null>(null);
export const terminal = signal<{ dev: Device; mode: string } | null>(null);
export const dialogsOpen = signal(0);

/** A restart / shutdown asked for: set the moment you confirm, until the server knows about it. */
export const localPower = signal<Record<string, 'reboot' | 'poweroff'>>({});
export const powerOf = (d: Device) => localPower.value[d.id] || d.power || null;

/** The last speed test to each device, shown in its screen (not on the card: it isn't live). */
export const speeds = signal<Record<string, { down: string; up: string; t: number }>>({});

export const devices = computed(() => state.value?.devices || []);
export const deviceById = (id: string | null) => devices.value.find(d => d.id === id);

/** Anything open that a page reload would interrupt. */
export const busyWithSomething = () =>
  !!(detailId.value || paletteOpen.value || netSpeedOpen.value || historyOpen.value || terminal.value || dialogsOpen.value);

let pageVersion: number | null = null;

export async function poll() {
  try {
    const s = await getJSON<State>('/api/state');
    // Homebase was updated: reload, unless something is open.
    pageVersion ??= s.ui;
    if (s.ui && s.ui !== pageVersion && !busyWithSomething()) location.reload();
    state.value = s;
    lastOk.value = Date.now();
    offline.value = false;
  } catch {
    offline.value = Date.now() - lastOk.value > 6000;  // shown as "no connection to the server"
  }
}
