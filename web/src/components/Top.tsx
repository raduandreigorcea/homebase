// The top bar (name, internet line, clock), the laptop's own card and "What happened".
import { useEffect, useState } from 'preact/hooks';
import type { HbEvent } from '../api';
import { Gauge, NetChart } from '../charts';
import { bytes, color, dur, hhmm } from '../format';
import { BatteryIcon, WifiIcon } from '../icons';
import { historyOpen, offline, state } from '../store';

export function Header() {
  const s = state.value;
  const n = s?.internet;
  const data = s?.history.net_lat || [];
  const title = !s ? '' : n == null ? 'Internet: checking' : n.online
    ? `Internet${n.ssid ? ' · ' + n.ssid : ''}${n.since ? ' · stable for ' + dur(s.now - n.since) : ''} · last ${Math.round(data.length * 4 / 60)} min`
    : 'The internet is down';
  return (
    <header>
      <div class="brand">
        <svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#121820" stroke="#232d39" /><path d="M8 17l8-7 8 7v7H8z" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linejoin="round" /></svg>
        <div><h1>Homebase</h1><p title="This laptop's address on your network">{s?.netbook?.ip || '\u00a0'}</p></div>
      </div>
      <div class="net" title={title}>{s && <NetChart data={data} ok={n?.online !== false} />}</div>
      <Clock />
    </header>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 10000); return () => clearInterval(t); }, []);
  return (
    <div class="clock">
      <div class="t">{hhmm(now)}</div>
      <div class="d">{now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
    </div>
  );
}

/** This laptop: CPU, memory and temperature gauges, battery, and the internet line (opens the speed test). */
export function LaptopCard() {
  const s = state.value;
  const nb = s?.netbook;
  const n = s?.internet;
  // "2.1 / 3.6 GB": short enough for one line under the gauge in a monospace font.
  const mu = nb ? bytes(nb.mem.used) : '', mt = nb ? bytes(nb.mem.total) : '';
  const memSub = mu.split(' ')[1] === mt.split(' ')[1] ? `${mu.split(' ')[0]} / ${mt}` : `${mu} / ${mt}`;
  const t = nb?.temps.cpu;
  const b = nb?.battery;
  return (
    <section class="card">
      <h2>Terminal <span>{offline.value && <span class="stale">no connection to the server</span>}</span></h2>
      <div class="gauges">
        <div class="gauge">{nb && <Gauge pct={nb.cpu} text={Math.round(nb.cpu) + '%'} col={color(nb.cpu)} />}<div class="lbl">CPU</div><div class="sub" /></div>
        <div class="gauge">{nb && <Gauge pct={nb.mem.pct} text={Math.round(nb.mem.pct) + '%'} col={color(nb.mem.pct, 75, 90)} />}<div class="lbl">Memory</div><div class="sub">{nb && memSub}</div></div>
        <div class="gauge">{nb && <Gauge pct={t ? (t - 30) / 70 * 100 : 0} text={t ? Math.round(t) + '°' : '–'} col={t ? color(t, 70, 85) : 'var(--dim)'} />}<div class="lbl">Temperature</div><div class="sub" /></div>
      </div>
      <div class="bat">
        <span class="bat-info">
          {b && <><BatteryIcon pct={b.pct} status={b.status} /><span>Battery <b>{b.pct}%</b></span></>}
        </span>
        <span class={`bat-net${n && !n.online ? ' off' : ''}`} title="Internet history and speed test" role="button" tabIndex={0}
              onClick={() => { historyOpen.value = true; }}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); historyOpen.value = true; } }}>
          {s && <WifiIcon signal={nb?.net.signal} ok={n == null || n.online} />}
          <span>Internet <b>{s?.lan === false ? 'no network' : n == null ? '…' : !n.online ? `down for ${dur(s!.now - (n.down_since || s!.now))}` : n.latency != null ? Math.round(n.latency) + ' ms' : 'connected'}</b></span>
        </span>
      </div>
    </section>
  );
}

export function Events() {
  const list: HbEvent[] = (state.value?.events || []).slice(0, 6);
  if (!list.length) return <section class="card"><h2>What happened</h2><div class="dev-sub">Nothing yet. Devices turning on and off, internet outages and new devices show up here.</div></section>;
  const today = new Date().toDateString(), yest = new Date(Date.now() - 864e5).toDateString();
  let day: string | null = null;
  const rows = [];
  for (const [i, e] of list.entries()) {
    const d = new Date(e.t * 1000), ds = d.toDateString();
    if (ds !== day) {
      day = ds;
      rows.push(<div class="ev-day" key={'d' + i}>{ds === today ? 'Today' : ds === yest ? 'Yesterday' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}</div>);
    }
    rows.push(<div class={`ev ${e.kind}`} key={i}><time>{hhmm(d)}</time><i /><span>{e.text}</span></div>);
  }
  return <section class="card"><h2>What happened</h2><div>{rows}</div></section>;
}
