// Internet speed tests with a gauge, like speedtest.net, against Cloudflare: this laptop's in its own
// window, and a device's (run on the device itself, over SSH) inside its screen. The server measures;
// this polls it four times a second while it runs.
import { useEffect, useRef, useState } from 'preact/hooks';
import { SpeedGauge } from './SpeedGauge';
import { enc, getJSON, post, type Device, type SpeedRun } from '../api';
import { hhmm, mbs } from '../format';
import { Close } from '../icons';
import { netSpeedOpen, speeds, speedStart } from '../store';

const running = (r: SpeedRun) => ['ping', 'download', 'upload'].includes(r.phase);

/** One test's progress, polled from the server. Picks up a run already going (or finished) when it mounts. */
function useSpeedRun(device: Device | null, autostart: boolean) {
  const [run, setRun] = useState<SpeedRun>({ phase: 'idle' });
  const timer = useRef<ReturnType<typeof setInterval>>();

  const poll = async () => {
    let r: SpeedRun;
    try { r = await getJSON<SpeedRun>(device ? '/api/devspeed' : '/api/netspeed'); } catch { return; }
    // The device test is shared: a result for another device doesn't belong here.
    if (device && r.dev && r.dev !== device.id) r = { phase: 'idle' };
    setRun(r);
    if (device && r.phase === 'done') speeds.value = { ...speeds.value, [device.id]: { down: mbs(r.down), up: mbs(r.up), t: (r.finished || 0) * 1000 } };
    if (!running(r)) { clearInterval(timer.current); timer.current = undefined; }
  };
  const watch = () => { timer.current ??= setInterval(poll, 250); };
  const start = async () => {
    const j = await post(device ? `/api/speed/${enc(device.id)}` : '/api/netspeed');
    if (!j.ok) return setRun({ phase: 'error', error: device ? `${device.name} isn't reachable over SSH right now` : 'The server isn\'t responding' });
    setRun({ phase: 'ping', dev: device?.id, live: 0 });
    watch();
  };
  useEffect(() => {
    if (autostart) start(); else poll().then(() => watch());
    return () => clearInterval(timer.current);
  }, []);
  return { run, start, busy: running(run) };
}

const bigOf = (run: SpeedRun) => run.phase === 'ping' ? '…' : running(run) ? mbs(run.live) : run.phase === 'done' ? mbs(run.down) : '–';
const PHASE_LABEL: Record<string, string> = { ping: 'Measuring ping…', download: 'Download · MB/s', upload: 'Upload · MB/s', done: 'Download · MB/s' };
const cell = (on: string, name: string, v: string, unit: string) => <div class={on}><span>{name}</span><b>{v}<small>{unit}</small></b></div>;

/** The "Internet speed" box in a device's screen. Starts on its own when asked from the palette or a card. */
export function DeviceSpeed({ d, online }: { d: Device; online: boolean }) {
  const auto = speedStart.value === d.id;
  useEffect(() => { if (auto) speedStart.value = null; }, []);
  const { run, start, busy } = useSpeedRun(d, auto && online);
  const label = run.phase === 'error' ? run.error
    : run.phase === 'done' ? `Ping ${Math.round(run.ping ?? 0)} ms${run.server ? ' · Cloudflare ' + run.server : ''}`
    : PHASE_LABEL[run.phase] || `The internet as ${d.name} gets it`;
  const val = (v: number | null | undefined, live: boolean) => v != null ? mbs(v) : live ? mbs(run.live) : '–';
  return (
    <div class="dv-speed">
      <SpeedGauge run={run} big={bigOf(run)} />
      <div class="st-now">{label}</div>
      <div class="st-res">
        {cell(run.phase === 'download' ? 'on' : '', '↓ Down', val(run.down, run.phase === 'download'), 'MB/s')}
        {cell(run.phase === 'upload' ? 'on up' : '', '↑ Up', val(run.up, run.phase === 'upload'), 'MB/s')}
        <button class="primary" disabled={busy || !online} onClick={start}>{busy ? '…' : run.phase === 'done' || run.phase === 'error' ? 'Again' : 'Measure'}</button>
      </div>
    </div>
  );
}

/** The internet speed test, in its own window. Waits for Start. */
export function SpeedTest() {
  const { run, start, busy } = useSpeedRun(null, false);
  const label = run.phase === 'error' ? run.error : PHASE_LABEL[run.phase] || 'Press Start to measure your internet';
  const when = run.phase === 'done' && run.finished ? `Measured ${hhmm(new Date(run.finished * 1000))}. ` : '';
  const close = () => { netSpeedOpen.value = false; };

  return (
    <div class="dev-modal st-modal" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div class="dev-win st-win" role="dialog" aria-modal="true" aria-labelledby="st-title">
        <div class="dv-head">
          <div class="dv-who">
            <h3 id="st-title">Internet speed</h3>
            <p>Measured against Cloudflare's speed test servers{run.server ? ' in ' + run.server : ''}</p>
          </div>
          <span class="dv-tools"><button class="icon-btn" title="Close" onClick={close}><Close /></button></span>
        </div>
        <div class="st-body">
          <SpeedGauge run={run} big={bigOf(run)} />
          <div class="st-now">{label}</div>
          <div class="st-res">
            {cell(run.phase === 'ping' ? 'on' : '', 'Ping', run.ping != null ? String(Math.round(run.ping)) : '–', 'ms')}
            {cell('', 'Jitter', run.jitter != null ? String(Math.round(run.jitter)) : '–', 'ms')}
            {cell(run.phase === 'download' ? 'on' : '', '↓ Download', run.down != null ? mbs(run.down) : run.phase === 'download' ? mbs(run.live) : '–', 'MB/s')}
            {cell(run.phase === 'upload' ? 'on up' : '', '↑ Upload', run.up != null ? mbs(run.up) : run.phase === 'upload' ? mbs(run.live) : '–', 'MB/s')}
          </div>
          <button class="primary" disabled={busy} onClick={start}>{busy ? 'Measuring…' : run.phase === 'done' || run.phase === 'error' ? 'Run again' : 'Start'}</button>
          <div class="st-foot">{when || 'Uses about as much data as a speedtest.net run.'}</div>
        </div>
      </div>
    </div>
  );
}
