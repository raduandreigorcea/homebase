// A device's big screen (click a card): who it is up top, live numbers and charts on the left,
// what you can do on the right.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Device, Stats } from '../api';
import { deviceActions, doAction, editDevice, sendFiles } from '../actions';
import { BigLatChart, MiniSpark } from '../charts';
import { ago, bytes, color, dur, evTime } from '../format';
import { Close, Edit, KindIcon } from '../icons';
import { detailId, deviceById, powerOf, speeds, state } from '../store';
import { POWER_TXT, TvBlock } from './DeviceCard';
import { DeviceSpeed } from './SpeedTest';

function Tile({ label, value, unit, children }: { label: string; value: string | number; unit: string; children?: ComponentChildren }) {
  return <div class="dv-tile"><span>{label}</span><b>{value}{value !== '–' && <small>{unit}</small>}</b>{children}</div>;
}

function Kv({ label, value, pct, warn = 70, crit = 90 }: { label: string; value: string; pct?: number; warn?: number; crit?: number }) {
  return <div class="dv-kv"><span>{label}</span><b>{value}</b>
    {pct != null && <div class="bar"><i style={{ width: Math.min(100, pct) + '%', background: color(pct, warn, crit) }} /></div>}</div>;
}

function Live({ d, x }: { d: Device; x: Stats | null }) {
  const s = state.value!;
  const st = s.status[d.id];
  const online = st?.online, checked = st != null && st.online != null;
  const h = s.history;
  const lat = (h['lat:' + d.id] || []).filter((v): v is number => v != null);
  const ram = x ? 100 * (1 - x.mem_free / x.mem_total) : 0;
  const agent = x && !s.sshstats[d.id];
  const strip = (t: string) => t.startsWith(d.name + ': ') ? t.slice(d.name.length + 2) : t.startsWith(d.name + ' ') ? t.slice(d.name.length + 1) : t;
  return (
    <div class="dv-main">
      {x && <div class="dv-tiles">
        <Tile label="CPU" value={x.cpu == null ? '…' : Math.round(x.cpu)} unit="%"><MiniSpark data={h['cpu:' + d.id]} col={color(x.cpu ?? 0)} top={100} label="CPU" unit="%" /></Tile>
        {x.temp != null && <Tile label="Temp" value={Math.round(x.temp)} unit="°"><MiniSpark data={h['temp:' + d.id]} col={color(x.temp, 65, 80)} top={60} label="Temp" unit="°" base={25} /></Tile>}
        {x.gpu != null && <Tile label="GPU" value={Math.round(x.gpu)} unit="%"><MiniSpark data={h['gpu:' + d.id]} col={color(x.gpu)} top={100} label="GPU" unit="%" /></Tile>}
        <Tile label="RAM" value={Math.round(ram)} unit="%"><MiniSpark data={h['ram:' + d.id]} col={color(ram, 75, 90)} top={100} label="RAM" unit="%" /></Tile>
      </div>}
      {!checked ? <p class="dv-note">Checking…</p> : !online && <p class="dv-note">The device is off or not on the network.</p>}
      {d.probe_port && <div class="dv-sec">
        <h4>Response time <span>{online && st.latency != null && <><b>{Math.round(st.latency)} ms now</b> · </>}
          {lat.length ? `min ${Math.round(Math.min(...lat))} · avg ${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)} · last 3 min` : 'last 3 min'}</span></h4>
        <div class="dv-chart"><BigLatChart data={h['lat:' + d.id] || []} /></div>
      </div>}
      {x && <div class="dv-sec">
        <h4>System <span>{agent ? 'sent by the PC every 5 s' : 'read over SSH every 30 s'}</span></h4>
        <div class="dv-sys">
          {!!x.disk_total && <Kv label={d.windows ? 'Disk C:' : 'Disk'} value={`${bytes(x.disk_free)} free of ${bytes(x.disk_total)}`} pct={100 * (x.disk_total - (x.disk_free || 0)) / x.disk_total} warn={85} crit={95} />}
          <Kv label="Memory" value={`${bytes(x.mem_total - x.mem_free)} of ${bytes(x.mem_total)}`} pct={ram} warn={75} />
          {x.boot && <Kv label="System up for" value={dur(s.now - x.boot)} />}
          {x.kernel && <Kv label="Kernel" value={x.kernel} />}
          {agent && x.os && <Kv label="System" value={x.os.replace(/^Microsoft /, '')} />}
          {agent && x.top_name && <Kv label="Busiest app" value={`${x.top_name} · ${Math.round(x.top_cpu || 0)}%`} />}
          {agent && x.net_down != null && <Kv label="Network" value={`↓ ${bytes(x.net_down, true)} · ↑ ${bytes(x.net_up, true)}`} />}
        </div>
      </div>}
      {!!d.recent?.length && <div class="dv-sec">
        <h4>What happened <span>this device only</span></h4>
        <div class="dv-log">{d.recent.map((e, i) => <div key={i} class={e.kind}><time>{evTime(e.t)}</time><i /><span>{strip(e.text)}</span></div>)}</div>
      </div>}
    </div>
  );
}

function Side({ d }: { d: Device }) {
  const s = state.value!;
  const st = s.status[d.id];
  const online = powerOf(d) ? false : st?.online;  // restarting / shutting down: commands are off
  const [drop, setDrop] = useState(false);
  if (d.dlna) {
    const tv = s.tv[d.id];
    return <div class="dv-side"><div class="dv-sec"><h4>Playback</h4>
      {tv && online ? <TvBlock d={d} tv={tv} /> : <p class="dv-note">{online ? 'The TV isn\'t answering commands yet (DLNA).' : 'The TV is off.'}</p>}</div></div>;
  }
  // Waking only makes sense when it's off (same as on the card).
  const acts = deviceActions(d).filter(([a]) => !['send', 'speed'].includes(a) && !(a === 'wake' && (online || powerOf(d))));
  const sp = speeds.value[d.id];
  return (
    <div class="dv-side">
      {acts.length > 0 && <div class="dv-sec"><h4>Commands</h4><div class="dv-cmds">
        {acts.map(([a, label, cmd]) =>
          <button key={a} class={`dv-cmd${a === 'poweroff' ? ' danger-item' : ''}`} disabled={!(online || ['wake', 'key'].includes(a))}
                  onClick={() => doAction(a, d)}>
            <span class="p">$</span><code>{cmd} <em>{d.name}</em></code><span>{label.replace('…', '').toLowerCase()}</span>
          </button>)}
      </div></div>}
      {(d.key || d.windows) && <div class="dv-sec"><h4>Files</h4>
        <div class={`dv-drop${drop ? ' drop' : ''}`} role="button" tabIndex={0}
             onClick={() => doAction('send', d)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doAction('send', d); } }}
             onDragOver={e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDrop(true); } }}
             onDragLeave={e => { if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) setDrop(false); }}
             onDrop={e => { e.preventDefault(); e.stopPropagation(); setDrop(false); if (e.dataTransfer?.files.length) sendFiles(d, [...e.dataTransfer.files]); }}>
          <b>Drop files here</b>
          <small>{d.key ? `or click · they land in ${d.windows ? 'Downloads' : `${d.ssh_user || ''}'s home folder`}`
            : 'or click · find them on the PC in Remote Desktop › This PC › the folder shared by the laptop'}</small>
        </div>
      </div>}
      {d.key && <div class="dv-sec"><h4>Speed to it <span>{sp?.t ? ago(sp.t) : ''}</span></h4>
        <DeviceSpeed d={d} online={!!online} />
      </div>}
      {d.ssh && !d.key ? <p class="dv-note">Type the SSH password in ✎ to get stats, files and a speed test here.</p>
        : !d.ssh && d.kind !== 'tv' && !d.windows && <p class="dv-note">Set an SSH user and password in ✎ to control it from here.</p>}
    </div>
  );
}

export function DeviceScreen() {
  const d = deviceById(detailId.value);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeBtn.current?.focus(); }, [d?.id]);  // once per opening, not on every refresh
  if (!d || !state.value) return null;
  const s = state.value;
  const pending = powerOf(d);
  const st = s.status[d.id];
  const online = pending ? null : st?.online, checked = !pending && st != null && st.online != null;
  const x = online ? s.sshstats[d.id] || s.stats[d.id] || null : null;
  const sub = [d.os && <span class="os-tag">{d.os.replace(' (DLNA)', '')}</span>, x?.model && x.model.replace(/ Rev [\d.]+$/, ''),
               d.host, d.ssh_user && d.kind !== 'tv' && `${d.ssh_user}@`].filter(Boolean);
  const close = () => { detailId.value = null; };
  return (
    <div class="dev-modal" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div class="dev-win" role="dialog" aria-modal="true" aria-labelledby="dv-name">
        <div class="dv-head">
          <div class="dev-icon"><KindIcon kind={d.kind} /></div>
          <div class="dv-who">
            <h3><span id="dv-name">{d.name}</span>
              <span class={`pill ${pending ? 'pending' : !checked ? '' : online ? 'on' : 'off'}`}><span class="dot" />
                {pending ? POWER_TXT[pending] : !checked ? 'Checking…' : online ? <>On{st.since && <small> · for {dur(s.now - st.since)}</small>}</> : 'Off'}</span></h3>
            <p>{sub.map((part, i) => <span key={i}>{i > 0 && ' · '}{part}</span>)}</p>
          </div>
          <span class="dv-tools">
            <button class="icon-btn" title="Settings" onClick={() => editDevice(d)}><Edit /></button>
            <button class="icon-btn" title="Close" onClick={close} ref={closeBtn}><Close /></button>
          </span>
        </div>
        <div class="dv-body" key={d.id}>
          <Live d={d} x={x} />
          <Side d={d} />
        </div>
        <div class="dv-foot"><span><kbd>Esc</kbd> close</span><span><kbd>/</kbd> commands</span><span>updates every 2 s</span></div>
      </div>
    </div>
  );
}
