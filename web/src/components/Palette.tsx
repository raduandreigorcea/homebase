// Command palette: press / (or Ctrl+K). Empty, it lists each command once; picking one types it in
// and then lists the devices it works on.
import { useEffect, useRef, useState } from 'preact/hooks';
import { post } from '../api';
import { actionFits, deviceActions, doAction } from '../actions';
import { norm } from '../format';
import { paletteOpen, netSpeedOpen, state } from '../store';
import { toast } from '../ui';

interface Cmd { text: string; desc: string; run?: () => void; fill?: string }

function commands(): Cmd[] {
  const out: Cmd[] = [
    { text: 'scan', desc: 'Look for new devices', run: () => { post('/api/scan').then(() => toast('Searching the network…', 'info')); } },
    { text: 'speedtest', desc: 'Test your internet speed', run: () => { netSpeedOpen.value = true; } },
  ];
  for (const d of state.value?.devices || []) {
    // Only what makes sense right now (an off device can only be woken or edited).
    for (const [act, label, cmd] of deviceActions(d)) {
      if (actionFits(d, act)) out.push({ text: `${cmd} ${d.name}`, desc: label.replace('…', ''), run: () => doAction(act, d) });
    }
    out.push({ text: `edit ${d.name}`, desc: 'Settings', run: () => doAction('edit', d) });
  }
  return out;
}

export function Palette() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const query = norm(q.trim());
  const all = commands();
  let items: Cmd[];
  if (!query) {
    const verbs = new Map<string, Cmd>();
    for (const c of all) {
      const verb = c.text.split(' ')[0];
      if (!verbs.has(verb)) verbs.set(verb, c.text === verb ? c : { text: verb, desc: c.desc, fill: verb + ' ' });
    }
    items = [...verbs.values()];
  } else {
    const words = query.split(/\s+/);
    items = all.filter(c => words.every(w => norm(c.text).includes(w)))
               .sort((a, b) => +norm(b.text).startsWith(query) - +norm(a.text).startsWith(query))
               .slice(0, 12);
  }
  const at = Math.min(sel, Math.max(0, items.length - 1));
  const close = () => { paletteOpen.value = false; };
  const fill = (text: string) => { setQ(text); setSel(0); input.current?.focus(); };
  const run = (c?: Cmd) => {
    if (!c) return;
    if (c.fill) return fill(c.fill);
    close();
    c.run?.();
  };

  return (
    <div class="pal-back" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div class="pal" role="dialog" aria-modal="true" aria-label="Commands">
        <label class="pal-in"><span class="pal-p">homebase:~$</span>
          <input ref={input} value={q} autocomplete="off" spellcheck={false} placeholder="ssh, wake, send, speed…"
                 onInput={e => { setQ((e.target as HTMLInputElement).value); setSel(0); }}
                 onKeyDown={e => {
                   const n = Math.max(1, items.length);
                   if (e.key === 'ArrowDown') { e.preventDefault(); setSel((at + 1) % n); }
                   else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((at - 1 + n) % n); }
                   else if (e.key === 'Tab') { e.preventDefault(); const c = items[at]; if (c) fill(c.fill || c.text); }
                   else if (e.key === 'Enter') { e.preventDefault(); run(items[at]); }
                   else if (e.key === 'Escape') { e.preventDefault(); close(); }
                 }} />
        </label>
        <div class="pal-list" role="listbox">
          {items.length ? items.map((c, i) =>
            <div key={c.text} class={`pal-item${i === at ? ' sel' : ''}`} role="option" aria-selected={i === at} onClick={() => run(c)}>
              <b>{c.text}</b><span>{c.desc}</span></div>)
            : <div class="pal-empty">No command. Try: ssh, wake, send, speed, scan</div>}
        </div>
        <div class="pal-help">Tab completes · ↑↓ picks · Enter runs · Esc closes</div>
      </div>
    </div>
  );
}
