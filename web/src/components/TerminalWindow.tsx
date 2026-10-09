// The built-in terminal: xterm.js (loaded the first time it's needed) talking to an ssh the server runs.
// Output arrives as Server-Sent Events, keystrokes go back as POSTs, in order.
import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Terminal as XTerm } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { enc, post } from '../api';
import { USER_OK } from '../format';
import { saveDevice } from '../actions';
import { Close, Terminal as TermIcon } from '../icons';
import { deviceById, terminal } from '../store';
import { AsyncButton, dialog, toast } from '../ui';

// What the window says it's doing, per mode.
const MODES: Record<string, string | null> = {
  shell: null,
  update: 'Updating the system (sudo apt update && full-upgrade)…',
  reboot: 'Restarting the device…',
  poweroff: 'Shutting the device down…',
};

let xtermLib: Promise<[typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit')]> | null = null;
/** xterm.js and its stylesheet, as a separate download the first time. */
export function loadXterm() {
  xtermLib ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')])
    .then(([x, f]) => [x, f] as [typeof x, typeof f])
    .catch(e => { xtermLib = null; throw e; });
  return xtermLib;
}

// --- Matrix-style rain behind the terminal ---
// This laptop draws everything in software, so it stays cheap: ~12 fps, one fading wipe per frame,
// about a third of the columns active.
const RAIN_CHARS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789';
const RAIN_SIZE = 14;

function useRain(canvas: RefObject<HTMLCanvasElement>) {
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = cv.getContext('2d')!;
    const font = `${RAIN_SIZE}px ${getComputedStyle(document.documentElement).getPropertyValue('--mono')}`;
    let drops: (number | null)[] = [];  // per column: row of the falling head, or null while it rests
    const step = () => {
      // Fade what's there instead of clearing, which leaves the trails.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0, 0, 0, .16)';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#34d399';
      drops.forEach((row, i) => {
        if (row == null) { if (Math.random() < .006) drops[i] = 0; return; }
        ctx.fillText(RAIN_CHARS[Math.random() * RAIN_CHARS.length | 0], i * RAIN_SIZE, row * RAIN_SIZE);
        drops[i] = row * RAIN_SIZE > cv.height ? null : row + 1;
      });
    };
    const resize = () => {
      // 1:1 pixels even on HiDPI: it's a faint background, and fewer pixels is cheaper.
      cv.width = cv.clientWidth; cv.height = cv.clientHeight;
      ctx.font = font; ctx.textBaseline = 'top';
      drops = Array.from({ length: Math.ceil(cv.width / RAIN_SIZE) }, () => Math.random() < .35 ? Math.random() * cv.height / RAIN_SIZE | 0 : null);
      for (let i = 0; i < 25; i++) step();  // open already flowing, not on an empty screen
    };
    const ro = new ResizeObserver(resize);
    ro.observe(cv);
    const timer = setInterval(() => { if (!document.hidden) step(); }, 80);
    return () => { clearInterval(timer); ro.disconnect(); };
  }, []);
}

type Fix = [string, string];  // [action, button label]

export function TerminalWindow() {
  const t = terminal.value!;
  const dev = deviceById(t.dev.id) || t.dev;
  const body = useRef<HTMLDivElement>(null);
  const rain = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<{ text: string; working: boolean; ended: boolean }>({ text: 'Connecting…', working: true, ended: false });
  const [loading, setLoading] = useState(true);
  const [fixes, setFixes] = useState<Fix[]>([]);
  const [attempt, setAttempt] = useState(0);  // bumped by Retry: a fresh session
  useRain(rain);

  useEffect(() => {
    let term: XTerm | null = null, fit: FitAddon | null = null, es: EventSource | null = null;
    let sid: string | null = null, ended = false, tail = '', pending = '', sending = false, gone = false;
    const send = (op: string, data?: string) => fetch(`/api/term/${sid}/${op}`, { method: 'POST', body: data });
    // Keystrokes must arrive in order, so send them one request at a time.
    const type = async (data: string) => {
      pending += data;
      if (sending) return;
      sending = true;
      while (pending && sid) {
        const chunk = pending; pending = '';
        try { await send('input', chunk); } catch { break; }
      }
      sending = false;
    };
    const onResize = () => fit?.fit();
    setFixes([]);
    setStatus({ text: 'Connecting…', working: true, ended: false });

    (async () => {
      let lib;
      try { lib = await loadXterm(); }
      catch { terminal.value = null; toast('Couldn\'t load the terminal', 'err'); return; }
      if (gone) return;
      setLoading(false);
      await new Promise(r => requestAnimationFrame(r));  // let the terminal's box show before measuring it
      if (gone) return;
      const [{ Terminal }, { FitAddon }] = lib;
      term = new Terminal({
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
        fontSize: 14, cursorBlink: true, scrollback: 3000, allowTransparency: true,
        theme: { background: 'rgba(0, 0, 0, 0)', foreground: '#e6edf3', cursor: '#34d399', cursorAccent: '#0b0f14',
                 selectionBackground: '#264f78', black: '#1b2430', brightBlack: '#5b6876',
                 green: '#34d399', brightGreen: '#6ee7b7', red: '#f87171', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#a78bfa' },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(body.current!);
      fit.fit();
      term.focus();
      addEventListener('resize', onResize);
      term.writeln(`\x1b[90mConnecting to ${dev.name}…\x1b[0m`);
      if (MODES[t.mode]) term.writeln(`\x1b[32m${MODES[t.mode]}\x1b[0m`);

      const r = await post<{ ok?: boolean; sid?: string }>(`/api/term/start/${enc(dev.id)}`, { mode: t.mode });
      if (gone) return;
      if (!r.ok || !r.sid) { term.writeln('\x1b[31mCouldn\'t start the connection.\x1b[0m'); setStatus({ text: 'Error', working: false, ended: true }); return; }
      sid = r.sid;
      send('resize', JSON.stringify({ cols: term.cols, rows: term.rows }));
      term.onResize(({ cols, rows }) => { if (sid) send('resize', JSON.stringify({ cols, rows })); });
      term.onData(d => { if (ended) { terminal.value = null; return; } type(d); });

      const dec = new TextDecoder();
      es = new EventSource(`/api/term/${sid}/stream`);
      es.onmessage = e => {
        if (!ended) setStatus({ text: 'Connected', working: false, ended: false });
        const data = Uint8Array.from(atob(e.data), c => c.charCodeAt(0));
        term!.write(data);
        tail = (tail + dec.decode(data, { stream: true })).slice(-400);
      };
      es.addEventListener('exit', () => {
        es!.close();
        ended = true;
        setStatus({ text: 'Disconnected', working: false, ended: true });
        // Explain what went wrong in plain words, with a button that fixes it where possible.
        const say = (msg: string, ...btns: Fix[]) => { term!.writeln('\r\n\x1b[33m' + msg + '\x1b[0m'); setFixes(btns); };
        if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(tail)) {
          say('The device has a different key than last time. Normal if you reinstalled it; otherwise, be careful.', ['newkey', 'Accept the new key'], ['retry', 'Retry']);
        } else if (/Permission denied|Too many authentication failures/.test(tail)) {
          say(`Wrong user or password (user: ${dev.ssh_user}).`, ['user', 'Change user'], ['retry', 'Retry']);
        } else if (/Connection refused|Connection reset|Connection closed by/.test(tail)) {
          say('SSH isn\'t answering yet. If you just turned it on, wait 1–2 minutes (a Pi Zero can take ~5 min on its first boot). ' +
              'If it still fails, SSH is off: turn it on in Raspberry Pi Imager or with sudo raspi-config.', ['retry', 'Retry']);
        } else if (/timed out|No route to host|Could not resolve/.test(tail)) {
          say('The device isn\'t answering. Check that it\'s on and connected to the network.', ['retry', 'Retry']);
        } else if (t.mode === 'shell') {
          setFixes([['retry', 'Reconnect']]);
        }
        term!.writeln('\r\n\x1b[90m[Connection closed · press any key to close]\x1b[0m');
      });
      // The server never resends from the middle, so don't let EventSource auto-reconnect.
      es.onerror = () => { if (es!.readyState !== EventSource.CLOSED) es!.close(); };
    })();

    return () => {
      gone = true;
      if (sid && !ended) send('close').catch(() => {});
      es?.close();
      term?.dispose();
      removeEventListener('resize', onResize);
      setLoading(true);
    };
  }, [dev.id, t.mode, attempt]);

  const fix = async (act: string) => {
    if (act === 'newkey') {
      const r = await post(`/api/sshreset/${enc(dev.id)}`);
      if (!r.ok) return toast('Couldn\'t remove the old key', 'err');
    }
    if (act === 'user') {
      const user = await dialog<string>({ title: 'SSH user', icon: 'terminal', ok: 'Connect',
        input: { value: dev.ssh_user || '', validate: v => v ? USER_OK(v) : 'Type a user name' } });
      if (!user || !await saveDevice(dev.id, { ssh_user: user })) return;
    }
    setAttempt(attempt + 1);
  };

  return (
    <div class="term-modal">
      <div class="term-win">
        <canvas class="term-rain" ref={rain} aria-hidden="true" />
        <div class="term-bar">
          <span class="term-title"><TermIcon /><b>{dev.name}</b><span class="muted-sm">{dev.ssh_user ? dev.ssh_user + '@' : ''}{dev.host}</span>
            <span class={`term-status${status.ended ? ' ended' : ''}`}>
              {status.text && <>{status.working ? <span class="spin" style="width:12px;height:12px" /> : <span class="dot" />}{status.text}</>}
            </span>
          </span>
          <span class="term-actions">{fixes.map(([act, label]) => <AsyncButton key={act} minMs={400} onClick={() => fix(act)}>{label}</AsyncButton>)}</span>
          <button class="icon-btn" title="Close the terminal" onClick={() => { terminal.value = null; }}><Close /></button>
        </div>
        <div class="term-body">
          {/* xterm owns this box; Preact never touches what's inside it */}
          <div ref={body} style={{ height: '100%', display: loading ? 'none' : 'block' }} />
          {loading && <div class="term-loading"><span class="spin" />Getting the terminal ready…</div>}
        </div>
      </div>
    </div>
  );
}
