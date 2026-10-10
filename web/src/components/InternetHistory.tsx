// The internet's history: uptime, outages and response time over the last day, week or month.
// Opened by clicking the internet chart in the top bar; the server keeps the data on disk.
import { useEffect, useRef, useState } from 'preact/hooks';
import { getJSON, type NetHistory } from '../api';
import { HistoryChart } from '../charts';
import { dur, hhmm } from '../format';
import { Close } from '../icons';
import { historyOpen, netSpeedOpen, state } from '../store';

const RANGES = [['day', '24 hours'], ['week', '7 days'], ['month', '30 days']] as const;
type Range = typeof RANGES[number][0];

/** "45 s", "3m", "1h 20m". */
const howLong = (s: number) => s < 60 ? `${Math.max(1, Math.round(s))} s` : dur(s);

function when(t: number): string {
  const d = new Date(t * 1000), today = new Date().toDateString();
  return d.toDateString() === today ? `Today ${hhmm(d)}` : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${hhmm(d)}`;
}

function Tile({ label, value, unit, sub, warn }: { label: string; value: string; unit?: string; sub?: string; warn?: boolean }) {
  return (
    <div class="dv-tile">
      <span>{label}</span>
      <b style={warn ? { color: 'var(--red)' } : undefined}>{value}{unit && <small>{unit}</small>}</b>
      <div class="hist-sub">{sub || ' '}</div>
    </div>
  );
}

export function InternetHistory() {
  const [range, setRange] = useState<Range>('day');
  const [h, setH] = useState<NetHistory | null>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeBtn.current?.focus(); }, []);
  useEffect(() => {
    let alive = true;
    const load = () => getJSON<NetHistory>(`/api/nethistory?range=${range}`).then(r => { if (alive) setH(r); }).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [range]);

  const close = () => { historyOpen.value = false; };
  const span = RANGES.find(r => r[0] === range)![1];
  const shown = h?.range === range ? h : null;  // don't show the old range's numbers under the new tab
  const longest = shown?.outages.reduce((m, o) => Math.max(m, o.end - o.start), 0) || 0;
  const ssid = state.value?.internet?.ssid;

  return (
    <div class="dev-modal" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div class="dev-win hist-win" role="dialog" aria-modal="true" aria-labelledby="hist-title">
        <div class="dv-head">
          <div class="dv-who">
            <h3 id="hist-title">Internet history</h3>
            <p>{ssid ? `${ssid} · ` : ''}checked every few seconds while this laptop is on</p>
          </div>
          <span class="dv-tools">
            <button onClick={() => { netSpeedOpen.value = true; }}>Speed test</button>
            <button class="icon-btn" title="Close" onClick={close} ref={closeBtn}><Close /></button>
          </span>
        </div>
        <div class="hist-body">
          <div class="hist-tabs" role="tablist">
            {RANGES.map(([k, label]) =>
              <button key={k} role="tab" aria-selected={range === k} class={range === k ? 'on' : ''} onClick={() => setRange(k)}>{label}</button>)}
          </div>
          <div class="dv-tiles">
            <Tile label="Uptime" value={shown?.uptime != null ? String(shown.uptime) : '–'} unit="%"
                  sub={shown ? (shown.measured ? `measured ${dur(shown.measured)} of ${span}` : 'nothing measured yet') : ''} />
            <Tile label="Outages" value={shown ? String(shown.outages.length) : '–'} warn={!!shown?.outages.some(o => o.ongoing)}
                  sub={longest ? `longest ${howLong(longest)}` : ''} />
            <Tile label="Average response" value={shown?.avg != null ? String(Math.round(shown.avg)) : '–'} unit="ms" />
            <Tile label="Worst response" value={shown?.worst != null ? String(Math.round(shown.worst)) : '–'} unit="ms" />
          </div>
          <div class="dv-chart">
            {shown ? <HistoryChart points={shown.points} outages={shown.outages} step={shown.step} range={range} />
              : <div class="hist-chart" />}
          </div>
          <div class="dv-sec">
            <h4>Outages <span>{span}</span></h4>
            {!shown ? null : shown.outages.length === 0
              ? <p class="dv-note">No outages in this period.</p>
              : <div class="hist-outs">
                  {shown.outages.slice(0, 30).map(o =>
                    <div key={o.start} class={o.ongoing ? 'now' : ''}>
                      <time>{when(o.start)}</time><i /><span>{o.ongoing ? `down for ${howLong(o.end - o.start)} (still down)` : `down for ${howLong(o.end - o.start)}`}</span>
                    </div>)}
                </div>}
          </div>
        </div>
        <div class="dv-foot"><span><kbd>Esc</kbd> close</span><span>gaps: this laptop was off or asleep</span><span>red: internet down</span></div>
      </div>
    </div>
  );
}
