// The whole page: top bar, device cards, what's on the network, this laptop, and the windows
// that open on top (device screen, internet speed test, terminal, palette, dialogs).
import { useEffect } from 'preact/hooks';
import { DeviceCard } from './components/DeviceCard';
import { DeviceScreen } from './components/DeviceScreen';
import { InternetHistory } from './components/InternetHistory';
import { Discovered } from './components/Discovered';
import { Palette } from './components/Palette';
import { SpeedTest } from './components/SpeedTest';
import { loadXterm, TerminalWindow } from './components/TerminalWindow';
import { Events, Header, LaptopCard } from './components/Top';
import { detailId, dialogsOpen, historyOpen, netSpeedOpen, paletteOpen, poll, state, terminal } from './store';
import { ChartTip, Dialogs, Toast } from './ui';

function Devices() {
  const s = state.value;
  if (!s) return <div class="devices" />;
  if (!s.devices.length) {
    return <div class="devices"><section class="card welcome"><h3>Welcome to Homebase</h3>
      <p>Your devices show up here. Pick them from <b>Found on the network</b> below and press <b>Add</b>.</p></section></div>;
  }
  // On devices first, then the ones still being checked, then the off ones; otherwise the list order stays.
  const rank = (id: string) => ({ true: 0, false: 2 } as Record<string, number>)[String(s.status[id]?.online)] ?? 1;
  const sorted = s.devices.map((d, i) => [d, i] as const).sort((a, b) => rank(a[0].id) - rank(b[0].id) || a[1] - b[1]).map(([d]) => d);
  return <div class="devices">{sorted.map(d => <DeviceCard key={d.id} d={d} st={s.status[d.id]} />)}</div>;
}

function usePolling() {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => { clearInterval(timer); poll(); timer = setInterval(poll, 2000); };
    const onVisibility = () => (document.hidden ? clearInterval(timer) : start());
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
}

function useKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogsOpen.value || paletteOpen.value) return;  // they handle their own keys
      // The terminal needs every key (Esc included) for the shell.
      if (terminal.value) return;
      if (e.key === 'Escape') {
        if (netSpeedOpen.value) netSpeedOpen.value = false;
        else if (historyOpen.value) historyOpen.value = false;
        else if (detailId.value) detailId.value = null;
        return;
      }
      const typing = (e.target as Element).closest?.('input, textarea, [contenteditable]');
      if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        if (state.value) paletteOpen.value = true;
      }
    };
    // The browser would otherwise open a file dropped anywhere on the page.
    const noDrop = (e: DragEvent) => e.preventDefault();
    document.addEventListener('keydown', onKey);
    addEventListener('dragover', noDrop);
    addEventListener('drop', noDrop);
    return () => { document.removeEventListener('keydown', onKey); removeEventListener('dragover', noDrop); removeEventListener('drop', noDrop); };
  }, []);
}

export function App() {
  usePolling();
  useKeys();
  const s = state.value;
  // Load the terminal in the background once there's something to SSH into, so the first click is instant.
  const hasSsh = !!s?.devices.some(d => d.ssh);
  useEffect(() => { if (hasSsh) { const t = setTimeout(() => loadXterm().catch(() => {}), 3000); return () => clearTimeout(t); } }, [hasSsh]);
  return (
    <>
      <Header />
      <main>
        <div class="stack">
          <Devices />
          {s && <Discovered />}
        </div>
        <div class="stack">
          <LaptopCard />
          <Events />
        </div>
      </main>
      <footer>Updates every 2 seconds · runs locally on this computer · press / for commands</footer>
      {detailId.value && <DeviceScreen />}
      {historyOpen.value && <InternetHistory />}
      {netSpeedOpen.value && <SpeedTest />}
      {terminal.value && <TerminalWindow />}
      {paletteOpen.value && <Palette />}
      <Dialogs />
      <Toast />
      <ChartTip />
    </>
  );
}
