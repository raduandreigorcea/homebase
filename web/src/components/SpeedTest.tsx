// Speed test with a gauge, like speedtest.net: the internet one (against Cloudflare) or to a device
// (over SSH). The server measures; this polls it four times a second while it runs.
import { useEffect, useRef, useState } from 'preact/hooks';
import { enc, getJSON, post, type Device, type SpeedRun } from '../api';
import { hhmm, mbps } from '../format';
import { Close } from '../icons';
import { speeds, speedTarget } from '../store';

// Gauge scale: speeds people actually have, spread evenly (0 · 5 · 10 · 50 · 100 · 250 · 500 · 1000 Mbit/s).
const TICKS = [0, 5, 10, 50, 100, 250, 500, 1000];
const SWEEP = 240;  // degrees, from -120 (0) to +120 (1000)

function angle(v = 0): number {
  v = Math.max(0, Math.min(1000, v));
  const i = Math.max(0, TICKS.findIndex(t => t >= v) - 1);
  const a = TICKS[i], b = TICKS[i + 1] ?? 1000;
  return -SWEEP / 2 + (i + (b > a ? (v - a) / (b - a) : 0)) * SWEEP / (TICKS.length - 1);
}
function point(deg: number, r: number): [number, number] {
  const rad = (deg - 90) * Math.PI / 180;
  return [190 + r * Math.cos(rad), 190 + r * Math.sin(rad)];
}
function arc(from: number, to: number, r: number): string {
  const [x1, y1] = point(from, r), [x2, y2] = point(to, r);
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/** Eases toward the target angle every frame, so the needle and the coloured arc move together and smoothly
 *  between the four-times-a-second readings. */
function useGlide(target: number): number {
  const [shown, setShown] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { cur.current = target; setShown(target); return; }
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      cur.current += (target - cur.current) * (1 - Math.exp(-(now - last) / 160));
      last = now;
      if (Math.abs(target - cur.current) < 0.1) cur.current = target;
      setShown(cur.current);
      if (cur.current !== target) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

/** Centre at (190, 190); the arc's open bottom holds the big number. */
function Dial({ run, big }: { run: SpeedRun; big: string }) {
  const value = run.phase === 'download' || run.phase === 'upload' ? run.live : run.phase === 'done' ? run.down ?? 0 : 0;
  const col = run.phase === 'upload' ? 'var(--violet)' : 'var(--blue)';
  const deg = useGlide(angle(value));
  const [nx, ny] = point(0, 112);
  return (
    <svg class="st-gauge" viewBox="0 0 380 285" aria-hidden="true">
      <path d={arc(-120, 120, 160)} fill="none" stroke="var(--panel-2)" stroke-width="18" stroke-linecap="round" />
      {deg > -119.5 && <path d={arc(-120, deg, 160)} fill="none" stroke={col} stroke-width="18" stroke-linecap="round" />}
      {TICKS.map((t, i) => {
        const [x, y] = point(-SWEEP / 2 + i * SWEEP / (TICKS.length - 1), 130);
        return <text key={t} x={x.toFixed(1)} y={(y + 4).toFixed(1)} text-anchor="middle" fill="var(--dim)" font-size="12">{t}</text>;
      })}
      <line x1="190" y1="190" x2={nx} y2={ny} transform={`rotate(${deg.toFixed(2)} 190 190)`} stroke="var(--text)" stroke-width="3" stroke-linecap="round" />
      <circle cx="190" cy="190" r="7" fill="var(--text)" />
      <text x="190" y="266" text-anchor="middle" fill="var(--text)" font-size="40" font-weight="700" style={{ fontVariantNumeric: 'tabular-nums' }}>{big}</text>
    </svg>
  );
}

const running = (r: SpeedRun) => ['ping', 'download', 'upload'].includes(r.phase);

export function SpeedTest() {
  const target = speedTarget.value!;
  const device: Device | null = target === 'internet' ? null : target;
  const [run, setRun] = useState<SpeedRun>({ phase: 'idle' });
  const timer = useRef<ReturnType<typeof setInterval>>();

  const poll = async () => {
    let r: SpeedRun;
    try { r = await getJSON<SpeedRun>(device ? '/api/devspeed' : '/api/netspeed'); } catch { return; }
    // The device test is shared: a result for another device doesn't belong here.
    if (device && r.dev && r.dev !== device.id) r = { phase: 'idle' };
    setRun(r);
    if (device && r.phase === 'done') speeds.value = { ...speeds.value, [device.id]: { down: mbps(r.down), up: mbps(r.up), t: (r.finished || 0) * 1000 } };
    if (!running(r)) { clearInterval(timer.current); timer.current = undefined; }
  };
  const watch = () => { timer.current ??= setInterval(poll, 250); };
  const start = async () => {
    const j = await post(device ? `/api/speed/${enc(device.id)}` : '/api/netspeed');
    if (!j.ok) return setRun({ phase: 'error', error: device ? `${device.name} isn't reachable over SSH right now` : 'The server isn\'t responding' });
    setRun({ phase: device ? 'download' : 'ping', dev: device?.id, live: 0 });
    watch();
  };

  // The device screen's Measure button starts right away; the internet test waits for Start.
  useEffect(() => {
    if (device) start(); else poll().then(() => watch());
    return () => clearInterval(timer.current);
  }, []);

  const busy = running(run);
  const big = run.phase === 'ping' ? '…' : busy ? mbps(run.live) : run.phase === 'done' ? mbps(run.down) : '–';
  const label = ({ ping: 'Measuring ping…', download: 'Download · Mbit/s', upload: 'Upload · Mbit/s', done: 'Download · Mbit/s', error: run.error } as Record<string, string | undefined>)[run.phase]
    || (device ? `Press Start to measure the speed to ${device.name}` : 'Press Start to measure your internet');
  const cell = (on: string, name: string, v: string, unit: string) => <div class={on}><span>{name}</span><b>{v}<small>{unit}</small></b></div>;
  const when = run.phase === 'done' && run.finished ? `Measured ${hhmm(new Date(run.finished * 1000))}. ` : '';
  const close = () => { speedTarget.value = null; };

  return (
    <div class="dev-modal st-modal" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div class="dev-win st-win" role="dialog" aria-modal="true" aria-labelledby="st-title">
        <div class="dv-head">
          <div class="dv-who">
            <h3 id="st-title">{device ? `Speed to ${device.name}` : 'Internet speed'}</h3>
            <p>{device ? 'Between this laptop and it, over your home network' : `Measured against Cloudflare's speed test servers${run.server ? ' in ' + run.server : ''}`}</p>
          </div>
          <span class="dv-tools"><button class="icon-btn" title="Close" onClick={close}><Close /></button></span>
        </div>
        <div class="st-body">
          <Dial run={run} big={big} />
          <div class="st-now">{label}</div>
          <div class="st-res">
            {cell(run.phase === 'ping' ? 'on' : '', device ? 'Response' : 'Ping', run.ping != null ? String(Math.round(run.ping)) : '–', 'ms')}
            {!device && cell('', 'Jitter', run.jitter != null ? String(Math.round(run.jitter)) : '–', 'ms')}
            {cell(run.phase === 'download' ? 'on' : '', '↓ Download', run.down != null ? mbps(run.down) : run.phase === 'download' ? mbps(run.live) : '–', 'Mbit/s')}
            {cell(run.phase === 'upload' ? 'on up' : '', '↑ Upload', run.up != null ? mbps(run.up) : run.phase === 'upload' ? mbps(run.live) : '–', 'Mbit/s')}
          </div>
          <button class="primary" disabled={busy} onClick={start}>{busy ? 'Measuring…' : run.phase === 'done' || run.phase === 'error' ? 'Run again' : 'Start'}</button>
          <div class="st-foot">{device ? when + 'Data goes over SSH, so a slow device (like a Pi Zero) can be the limit rather than your Wi-Fi.'
            : when || 'Uses about as much data as a speedtest.net run.'}</div>
        </div>
      </div>
    </div>
  );
}
