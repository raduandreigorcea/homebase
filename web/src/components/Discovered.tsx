// "Found on the network": devices Homebase sees but you haven't added, with an inline Add form.
import { useEffect, useRef, useState } from 'preact/hooks';
import { post, type Found, type Kind } from '../api';
import { prettyName } from '../format';
import { KindIcon, Plus, Refresh } from '../icons';
import { poll, state } from '../store';
import { AsyncButton, toast } from '../ui';

const KINDS: [Kind, string][] = [['desktop', 'Desktop'], ['laptop', 'Laptop'], ['pi', 'Raspberry Pi'], ['tv', 'TV / media'], ['other', 'Other']];

function Row({ x, open, onOpen, onClose }: { x: Found; open: boolean; onOpen: () => void; onClose: () => void }) {
  const nice = prettyName(x.name || x.hostname);
  const title = nice || x.label || x.vendor || 'Unknown device';
  const guess = nice || (x.kind === 'pi' ? 'Raspberry Pi' : x.kind === 'tv' ? 'TV' : '');
  const [name, setName] = useState(guess);
  const [kind, setKind] = useState<Kind>(KINDS.some(([k]) => k === x.kind) ? x.kind : 'other');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { input.current?.focus(); input.current?.select(); } }, [open]);

  const add = async () => {
    const n = name.trim();
    if (!n) return toast('Type a name', 'err');
    // Adding a TV looks it up on the network first, so this can take a few seconds.
    const j = await post('/api/add', { ip: x.ip, mac: x.mac, name: n, kind });
    toast(j.ok ? `"${n}" added` : 'ok' in j ? 'Couldn\'t add it' : 'Error: the server isn\'t responding', j.ok ? 'ok' : 'err');
    if (j.ok) onClose();
    await poll();
  };

  return (
    <div class={`disc${open ? ' open' : ''}`} title={x.mac}>
      <div class="disc-row">
        <div class="dev-icon sm"><KindIcon kind={x.kind} /></div>
        <div class="disc-info"><b>{title}</b><div class="dev-sub">{x.label && nice && <><span class="os-tag">{x.label}</span> · </>}{x.ip}</div></div>
        {!open && <button class="disc-add" onClick={onOpen}><Plus /> Add</button>}
      </div>
      {open && (
        <div class="disc-form">
          <input type="text" placeholder="Name (e.g. Living room PC)" maxLength={40} value={name} ref={input}
                 onInput={e => setName((e.target as HTMLInputElement).value)}
                 onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } if (e.key === 'Escape') onClose(); }} />
          <div class="kinds">{KINDS.map(([k, l]) => <button type="button" key={k} class={`kind${k === kind ? ' sel' : ''}`} onClick={() => setKind(k)}>{l}</button>)}</div>
          <div class="disc-btns">
            <button onClick={onClose}>Cancel</button>
            <AsyncButton class="primary" onClick={add}><Plus /> Add to panel</AsyncButton>
          </div>
        </div>
      )}
    </div>
  );
}

export function Discovered() {
  const s = state.value!;
  const [openMac, setOpenMac] = useState<string | null>(null);
  const [showUnknown, setShowUnknown] = useState(false);
  const minutes = s.last_scan ? Math.max(0, Math.round((s.now - s.last_scan) / 60)) : null;
  const when = minutes == null ? 'searching…' : minutes < 1 ? 'just now' : `${minutes} min ago`;
  const list = (s.discovered || []).filter(x => x.kind !== 'router');
  // Things we could put a name or an OS on come first; the anonymous rest waits behind a toggle.
  const known = list.filter(x => x.name || x.hostname || x.label);
  const unknown = list.filter(x => !(x.name || x.hostname || x.label));
  const showAll = showUnknown || unknown.some(x => x.mac === openMac);
  const rows = [...known, ...(showAll ? unknown : [])];

  const scan = async () => {
    // A sweep takes ~4 s; keep the refresh icon spinning until the new results are in.
    const j = await post('/api/scan');
    if (!('ok' in j)) return toast('Error: the server isn\'t responding', 'err');
    await new Promise(r => setTimeout(r, 4500));
    await poll();
  };

  return (
    <section class="card">
      <h2>Found on the network <span class="disc-head"><span class="muted-sm">last search: {when}</span>
        <AsyncButton class="icon-btn" title="Search again" onClick={scan}><Refresh /></AsyncButton></span></h2>
      {rows.length > 0 && <div class="disc-list">{rows.map(x =>
        <Row key={x.mac} x={x} open={openMac === x.mac} onOpen={() => setOpenMac(x.mac)} onClose={() => setOpenMac(null)} />)}</div>}
      {unknown.length > 0 && <button class="disc-more" onClick={() => setShowUnknown(!showAll)}>
        {showAll ? 'Hide unknown devices' : `Show ${unknown.length} more unknown ${unknown.length === 1 ? 'device' : 'devices'}`}</button>}
      {!list.length && <div class="dev-sub">Nothing new on the network. Turn on a new device (a Raspberry Pi, say) and it shows up here within 30 seconds.</div>}
    </section>
  );
}
