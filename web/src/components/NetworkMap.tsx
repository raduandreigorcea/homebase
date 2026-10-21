// The network as a picture: a square per device around the router, a line to each, and dots running along the
// lines at the speed the device really sends and receives (green towards the device, amber towards the router).
// Real numbers for this laptop, for Linux devices with SSH and for PCs with the agent; a device Homebase can't
// measure (a TV, a phone) only shows a faint dot now and then, so you can see it's alive.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Device, Kind } from '../api';
import { bytes } from '../format';
import { Close, KindIcon } from '../icons';
import { detailId, networkOpen, state } from '../store';

interface Node { color: string; id: string; name: string; kind: Kind; online: boolean | null; down: number | null; up: number | null; dev?: Device }
interface Dot { line: number; at: number; toNode: boolean; faint: boolean }

const SPEED = 0.45;       // fraction of a line per second
const MAX_DOTS = 260;
const FRAME = 1000 / 30;
const PULSE = 0.5;        // seconds a pulse lasts


// Each device gets its own colour, handed out in list order so it stays the same from one visit to the next.
const COLORS = ['#60a5fa', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#f87171', '#a3e635', '#e879f9'];

/** Dots per second for a speed in bytes/s: nothing under 1 KB/s, then roughly one more per doubling. */
const dotsPerSec = (bps: number | null) => !bps || bps < 1024 ? 0 : Math.min(18, 1.2 * Math.log2(bps / 1024) + 1);

function nodesOf(): Node[] {
  const s = state.value;
  if (!s) return [];
  const nb = s.netbook;
  const out: Node[] = [{ color: COLORS[0], id: 'laptop', name: 'This terminal', kind: 'laptop', online: s.lan !== false, down: nb.net.down ?? null, up: nb.net.up ?? null }];
  for (const [i, d] of s.devices.entries()) {
    const st = s.stats[d.id] ?? s.sshstats[d.id];
    out.push({ color: COLORS[(i + 1) % COLORS.length], id: d.id, name: d.name, kind: d.kind, online: s.status[d.id]?.online ?? null, dev: d,
               down: st?.net_down ?? null, up: st?.net_up ?? null });
  }
  return out;
}

/** Where a node's square sits, in pixels: evenly around a circle, the first one on top. */
function place(i: number, n: number, w: number, h: number) {
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n, r = Math.min(w, h) * 0.34;
  return { x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a) };
}

export function NetworkMap() {
  const nodes = nodesOf();
  const net = state.value?.internet;
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef(nodes);
  live.current = nodes;
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const cv = canvas.current!, ctx = cv.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    const col = (v: string) => css.getPropertyValue(v).trim();
    const colors = { line: col('--line'), router: col('--green') };
    let w = 0, h = 0, dpr = 1;
    const resize = () => {
      const r = stage.current!.getBoundingClientRect();
      dpr = devicePixelRatio || 1;
      w = r.width; h = r.height;
      setSize({ w, h });
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(stage.current!);

    const dots: Dot[] = [];
    const owed: number[][] = [];     // per line: [down, up, faint] dots not yet sent
    const shown: number[][] = [];    // per line: the speeds drawn now, easing towards the real ones
    const pulses: { key: number; x: number; y: number; r: number; c: string; age: number; faint: boolean }[] = [];  // key: the square; -1 is the router
    let last = 0, raf = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || now - last < FRAME) return;
      const dt = Math.min(0.2, (now - last) / 1000);
      last = now;
      const list = live.current;
      const n = list.length;
      const cx = w / 2, cy = h / 2;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // A faint ring through the squares, so the circle reads even with few devices.
      ctx.strokeStyle = colors.line; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.setLineDash([2, 7]);
      ctx.beginPath(); ctx.arc(cx, cy, Math.min(w, h) * 0.34, 0, 7); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 1.5;
      list.forEach((nd, i) => {
        const p = place(i, n, w, h);
        const on = nd.online !== false;
        ctx.strokeStyle = on ? nd.color : colors.line;
        ctx.globalAlpha = on ? 0.35 : 1;
        ctx.setLineDash(on ? [] : [4, 6]);
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.globalAlpha = 1;

        const o = (owed[i] ||= [0, 0, 0]), sh = (shown[i] ||= [0, 0]);
        if (!on) { sh[0] = sh[1] = 0; return; }
        sh[0] += ((nd.down ?? 0) - sh[0]) * Math.min(1, dt * 2);
        sh[1] += ((nd.up ?? 0) - sh[1]) * Math.min(1, dt * 2);
        o[0] += dotsPerSec(sh[0]) * dt;
        o[1] += dotsPerSec(sh[1]) * dt;
        // Nothing measured, or nearly idle: a faint dot now and then, so a live device doesn't look dead.
        if (dotsPerSec(sh[0]) + dotsPerSec(sh[1]) === 0) o[2] += dt / 3;
        if (dots.length < MAX_DOTS) {
          for (; o[0] >= 1; o[0]--) dots.push({ line: i, at: Math.random() * 0.08, toNode: true, faint: false });
          for (; o[1] >= 1; o[1]--) dots.push({ line: i, at: Math.random() * 0.08, toNode: false, faint: false });
          for (; o[2] >= 1; o[2]--) dots.push({ line: i, at: 0, toNode: Math.random() < 0.5, faint: true });
        }
        o[0] %= 1; o[1] %= 1; o[2] %= 1;
      });
      ctx.setLineDash([]);

      for (let k = dots.length - 1; k >= 0; k--) {
        const d = dots[k];
        d.at += SPEED * dt;
        if (d.at >= 1 || d.line >= n) {
          // It arrived: a small pulse on the square that received it. Pulses overlap freely.
          if (d.line < n && pulses.length < 120) {
            const p = place(d.line, n, w, h);
            pulses.push(d.toNode ? { key: d.line, x: p.x, y: p.y, r: 40, c: list[d.line].color, age: 0, faint: d.faint }
                                 : { key: -1, x: cx, y: cy, r: 44, c: colors.router, age: 0, faint: d.faint });
          }
          dots.splice(k, 1); continue;
        }
        const p = place(d.line, n, w, h), c = d.toNode ? colors.router : list[d.line].color;   // the sender's colour
        const t = d.toNode ? d.at : 1 - d.at;   // 0 = the router, 1 = the device
        const x = cx + (p.x - cx) * t, y = cy + (p.y - cy) * t;
        ctx.fillStyle = c;
        ctx.globalAlpha = 0.2;
        ctx.beginPath(); ctx.arc(x, y, d.faint ? 4 : 7, 0, 7); ctx.fill();   // glow
        ctx.globalAlpha = d.faint ? 0.5 : 1;
        ctx.beginPath(); ctx.arc(x, y, d.faint ? 2 : 3.5, 0, 7); ctx.fill();
      }
      for (let k = pulses.length - 1; k >= 0; k--) {
        const p = pulses[k];
        p.age += dt;
        if (p.age >= PULSE || p.key >= n) { pulses.splice(k, 1); continue; }
        const f = p.age / PULSE;
        ctx.strokeStyle = p.c; ctx.lineWidth = 2;
        ctx.globalAlpha = (p.faint ? 0.3 : 0.7) * (1 - f);
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 20 * (1 - (1 - f) ** 2), 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.lineWidth = 1.5;
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  const close = () => { networkOpen.value = false; };
  const open = (nd: Node) => { if (nd.dev) { networkOpen.value = false; detailId.value = nd.dev.id; } };
  const rate = (v: number | null) => v == null ? '–' : bytes(v, true);

  return (
    <div class="dev-modal" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div class="dev-win net-win" role="dialog" aria-modal="true" aria-labelledby="net-title">
        <div class="dv-head">
          <div class="dv-who">
            <h3 id="net-title">Network</h3>
            <p>{nodes.length} devices · live traffic, as it is right now</p>
          </div>
          <span class="dv-tools"><button class="icon-btn" title="Close" onClick={close}><Close /></button></span>
        </div>
        <div class="net-stage" ref={stage}>
          <canvas ref={canvas} />
          <div class={`net-node hub${net && !net.online ? ' down' : ''}`} style={{ left: '50%', top: '50%' }}>
            <div class="net-box"><KindIcon kind="router" /></div>
            <div class="net-label">
              <b>Router</b>
              <small>{net == null ? '…' : !net.online ? 'internet down' : net.latency != null ? Math.round(net.latency) + ' ms' : 'online'}</small>
            </div>
          </div>
          {nodes.map((nd, i) => {
            const p = place(i, nodes.length, size.w, size.h);
            const off = nd.online === false;
            return (
              <div key={nd.id} class={`net-node${off ? ' off' : ''}${nd.dev ? ' click' : ''}`}
                   style={{ left: p.x + 'px', top: p.y + 'px', '--c': nd.color }} onClick={() => open(nd)}>
                <div class="net-box"><KindIcon kind={nd.kind} /></div>
                <div class="net-label">
                  <b>{nd.name}</b>
                  <small>{off ? 'off' : <><span>↓ {rate(nd.down)}</span> <span>↑ {rate(nd.up)}</span></>}</small>
                </div>
              </div>
            );
          })}
        </div>
        <div class="dv-foot"><span><kbd>Esc</kbd> close</span><span><i class="net-key router" /> green: from the router</span><span>device colour: from the device</span><span>faint dot: alive, not measured</span></div>
      </div>
    </div>
  );
}
