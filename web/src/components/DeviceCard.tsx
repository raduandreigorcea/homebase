// A device's card: who it is, whether it's on, its live numbers, and its main button.
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { Device, Stats, Status, Tv } from '../api';
import { connect, openTerminal, preparePc, removeDevice, editDevice, sendFiles, tvSend, wake } from '../actions';
import { Spark } from '../charts';
import { bytes, clock, color, dur } from '../format';
import { Back, Close, Connect, Edit, Fwd, KindIcon, Muted, Pause, Play, Power, Stop, Terminal, Vol } from '../icons';
import { detailId, noNetwork, powerOf, state } from '../store';
import { AsyncButton, toast } from '../ui';

export const POWER_TXT = { reboot: 'Restarting…', poweroff: 'Shutting down…' } as const;

// --- The terminal-style loading bar: a block bouncing along a track, ▱▱▰▰▰▱▱▱▱ ---
// One timer drives every bar on the page, and only while at least one is showing.
const tick = signal(0);
let bars = 0, timer: ReturnType<typeof setInterval> | undefined;
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function TBar() {
  useEffect(() => {
    if (still) return;
    if (bars++ === 0) timer = setInterval(() => { tick.value++; }, 110);
    return () => { if (--bars === 0) clearInterval(timer); };
  }, []);
  const W = 9, SEG = 3, span = W - SEG, pos = Math.abs((tick.value % (2 * span)) - span);
  return <b class="tbar"><i>{'▱'.repeat(span - pos)}</i>{'▰'.repeat(SEG)}<i>{'▱'.repeat(pos)}</i></b>;
}

/** One compact row of stats (over SSH on Linux, from the agent on Windows); details in the tooltip. */
export function StatsRow({ x }: { x: Stats }) {
  const memUsed = x.mem_total - x.mem_free, diskUsed = (x.disk_total || 0) - (x.disk_free || 0);
  const mini = (label: string, pct: number | null | undefined, shown: string | null, title: string, warn: number, crit: number) => {
    if (pct == null && shown == null) return null;
    const p = Math.max(0, Math.min(100, pct ?? 0));
    return <div class="mini" title={title}><div><span>{label}</span><b>{shown ?? Math.round(p) + '%'}</b></div>
      <i><i style={{ width: p + '%', background: color(p, warn, crit) }} /></i></div>;
  };
  return (
    <div class="minis">
      {mini('CPU', x.cpu, x.cpu == null ? '…' : null, 'CPU', 70, 90)}
      {mini('RAM', 100 * memUsed / x.mem_total, null, `Memory: ${bytes(memUsed)} of ${bytes(x.mem_total)}`, 75, 90)}
      {x.temp != null && mini('Temp', x.temp, `${Math.round(x.temp)}°`, 'CPU temperature', 65, 80)}
      {x.gpu != null && mini('GPU', x.gpu, null, 'Graphics card', 70, 90)}
      {!!x.disk_total && mini('Disk', 100 * diskUsed / x.disk_total, null, `Disk: ${bytes(x.disk_free)} free of ${bytes(x.disk_total)}`, 85, 95)}
    </div>
  );
}

/** A TV's remote: what's playing, play/pause/seek/stop and volume (only for what it plays over DLNA). */
export function TvBlock({ d, tv }: { d: Device; tv: Tv }) {
  const playing = tv.state === 'PLAYING', paused = tv.state === 'PAUSED_PLAYBACK', loaded = playing || paused;
  const label = playing ? 'Playing' : paused ? 'Paused' : tv.state === 'STOPPED' ? 'Stopped' : 'Nothing playing';
  const pct = loaded && tv.dur ? Math.min(100, 100 * (tv.pos || 0) / tv.dur) : 0;
  // While the slider is held it shows your value, not the TV's; it's sent when you let go.
  const [dragVol, setDragVol] = useState<number | null>(null);
  const vol = dragVol ?? tv.volume;
  const send = (op: string, value?: number | boolean) => tvSend(d.id, op, value);
  return (
    <div class="tv" onClick={e => e.stopPropagation()}>
      <div class="tv-now">
        <span class={`tv-state${playing ? ' on' : ''}`}>{label}</span>
        <b>{loaded ? tv.title || 'Untitled' : <span class="muted-sm">Controls work only for what you send to the TV over DLNA, not for YouTube or the TV's other apps</span>}</b>
      </div>
      {loaded && !!tv.dur && <div class="tv-prog"><span>{clock(tv.pos)}</span><div class="bar"><i style={{ width: pct + '%' }} /></div><span>{clock(tv.dur)}</span></div>}
      <div class="tv-ctl">
        <AsyncButton class="tv-btn" title="Back 10 seconds" disabled={!loaded} minMs={300} onClick={() => send('seek', Math.max(0, (tv.pos || 0) - 10))}><Back /></AsyncButton>
        <AsyncButton class="tv-btn big" title={playing ? 'Pause' : 'Play'} disabled={!loaded && tv.state !== 'STOPPED'} minMs={300} onClick={() => send(playing ? 'pause' : 'play')}>{playing ? <Pause /> : <Play />}</AsyncButton>
        <AsyncButton class="tv-btn" title="Forward 10 seconds" disabled={!loaded} minMs={300} onClick={() => send('seek', (tv.pos || 0) + 10)}><Fwd /></AsyncButton>
        <AsyncButton class="tv-btn" title="Stop" disabled={!loaded} minMs={300} onClick={() => send('stop')}><Stop /></AsyncButton>
      </div>
      <div class="tv-vol">
        <AsyncButton class={`tv-btn${tv.mute ? ' is-muted' : ''}`} title={tv.mute ? 'Unmute' : 'Mute'} disabled={!loaded} minMs={300} onClick={() => send('mute', !tv.mute)}>{tv.mute ? <Muted /> : <Vol />}</AsyncButton>
        <input type="range" class="tv-range" min={0} max={100} value={vol} style={{ '--p': vol + '%' }} disabled={!loaded}
               title={loaded ? undefined : 'The TV only lets the volume change while playing over DLNA'}
               onInput={e => setDragVol(+(e.target as HTMLInputElement).value)}
               onChange={async e => { await send('volume', +(e.target as HTMLInputElement).value); setDragVol(null); }} />
        <b class="tv-vol-n">{tv.mute ? 'mute' : vol}</b>
      </div>
    </div>
  );
}

export function DeviceCard({ d, st }: { d: Device; st?: Status }) {
  const s = state.value!;
  const stats = s.stats[d.id] || s.sshstats[d.id];
  const tv = s.tv[d.id];
  const pending = powerOf(d);
  // While it restarts the card looks like it's being checked (loading bars, buttons off).
  const online = pending ? null : st?.online;
  const checked = !pending && st != null && st.online != null;
  // The agent knows the real boot time; without it we only know when we first saw it on.
  const since = s.stats[d.id]?.boot ? dur(s.now - s.stats[d.id].boot!) : online && st?.since ? dur(s.now - st.since) : '–';
  // The TV only takes commands for what it plays over DLNA, so the controls only show up then.
  const tvActive = tv && ['PLAYING', 'PAUSED_PLAYBACK'].includes(tv.state);
  const [drop, setDrop] = useState(false);
  const lat = s.history['lat:' + d.id] || [];

  const main = d.dlna
    ? tv && !tvActive && <button class="primary" onClick={e => { e.stopPropagation(); toast('Connecting to the TV is coming soon', 'info'); }}><Connect /> Connect</button>
    // A Windows PC counts as prepared once its agent has reported (it then knows how Remote Desktop signs in).
    : d.windows && d.nla == null
    ? <AsyncButton class="primary" disabled={!online} onClick={() => preparePc(d)}><Connect /> Prepare PC</AsyncButton>
    // Prepared and not Windows Home (-1): greyed out only when it surely won't work.
    : d.windows && d.nla !== -1
    ? <AsyncButton class="primary" disabled={!online || d.rdp === false} minMs={4000} onClick={() => connect(d)}><Connect /> Connect</AsyncButton>
    : d.ssh
    ? <button class="primary" disabled={!online} onClick={e => { e.stopPropagation(); openTerminal(d); }}><Terminal /> Open terminal</button>
    : null;
  // Waking only makes sense when it's off.
  const wakeBtn = d.has_wake && !pending && st?.online === false && <AsyncButton minMs={600} onClick={() => wake(d)}><Power /> Wake it up</AsyncButton>;

  return (
    <section class={`card device${checked && !online ? ' is-off' : ''}${drop ? ' drop' : ''}`}
             onClick={e => { if (!(e.target as Element).closest('button, input, a')) detailId.value = d.id; }}
             onDragOver={e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDrop(true); } }}
             onDragLeave={e => { if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) setDrop(false); }}
             onDrop={e => { e.preventDefault(); setDrop(false); if (e.dataTransfer?.files.length) sendFiles(d, [...e.dataTransfer.files]); }}>
      <div class="dev-head">
        <div class="dev-icon"><KindIcon kind={d.kind} /></div>
        <div class="dev-title">
          <div class="dev-name" title={d.name}>{d.name}</div>
          <div class="dev-sub">{d.os && <><span class="os-tag">{d.os.replace(' (DLNA)', '')}</span> · </>}{d.host}</div>
          <span class={`pill ${pending ? 'pending' : !checked ? '' : online ? 'on' : 'off'}`}><span class="dot" />
            {pending ? POWER_TXT[pending] : !checked ? (noNetwork.value ? 'No network' : 'Checking…') : online ? 'On' : 'Off'}</span>
        </div>
        <div class="dev-tools">
          <button class="icon-btn" title="Settings" onClick={e => { e.stopPropagation(); editDevice(d); }}><Edit /></button>
          <button class="icon-btn" title="Remove from the panel" onClick={e => { e.stopPropagation(); removeDevice(d); }}><Close /></button>
        </div>
      </div>
      {/* One fixed wrapper for everything that comes and goes as the device turns on and off, so it can't
          end up after the buttons (Preact can misplace fragments that appear and vanish next to each other). */}
      <div class="dev-body">
      {online ? (
        <div class="facts">
          {st!.latency != null && <div><span>Response</span><b>{Math.round(st!.latency)} ms</b></div>}
          <div><span>On for</span><b>{since}</b></div>
          {tv && <div><span>Volume</span><b>{tv.mute ? 'mute' : tv.volume}</b></div>}
        </div>
      ) : !checked && <>
        <div class="facts">
          <div><span>Response</span>{noNetwork.value ? <b>–</b> : <TBar />}</div>
          <div><span>On for</span>{noNetwork.value ? <b>–</b> : <TBar />}</div>
        </div>
        {d.probe_port && !d.dlna && <svg class="spark" />}
      </>}
      {tvActive ? <TvBlock d={d} tv={tv} />
        : online && <>{stats && <StatsRow x={stats} />}{d.probe_port && !tv && <Spark data={lat} />}</>}
      </div>
      {(main || wakeBtn) && <div class="actions">{main}{wakeBtn}</div>}
    </section>
  );
}
