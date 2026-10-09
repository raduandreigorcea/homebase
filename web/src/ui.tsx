// Building blocks used everywhere: toasts, dialogs, buttons that show they're working, chart tooltips.
import { signal } from '@preact/signals';
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { DialogIcon, ToastErr, ToastInfo, ToastOk } from './icons';
import { dialogsOpen } from './store';

// --- Toasts ------------------------------------------------------------------

type ToastKind = 'ok' | 'err' | 'info';
const toastState = signal<{ msg: string; kind: ToastKind; progress: boolean; show: boolean; n: number }>(
  { msg: '', kind: 'ok', progress: false, show: false, n: 0 });
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(msg: string, kind: ToastKind = 'ok') {
  clearTimeout(toastTimer);
  toastState.value = { msg, kind, progress: false, show: true, n: toastState.value.n + 1 };
  toastTimer = setTimeout(() => { toastState.value = { ...toastState.value, show: false }; }, kind === 'err' ? 5000 : 3000);
}

/** A toast that stays up and updates (upload progress) until a normal toast replaces it. */
export function toastProgress(msg: string) {
  clearTimeout(toastTimer);
  toastState.value = { msg, kind: 'info', progress: true, show: true, n: toastState.value.n };
}

export function Toast() {
  const t = toastState.value;
  return (
    <div class={`toast ${t.kind}${t.show ? ' show' : ''}`} role="status">
      <span class="ti">{t.progress ? <span class="spin" style="width:14px;height:14px" /> : t.kind === 'err' ? <ToastErr /> : t.kind === 'info' ? <ToastInfo /> : <ToastOk />}</span>
      <span>{t.msg}</span>
    </div>
  );
}

// --- Dialogs -----------------------------------------------------------------
// dialog() is the in-app confirm()/prompt(): it resolves to true / the typed text / {key: value}, or null.

export interface Field {
  key: string;
  label?: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  secret?: boolean;
  validate?: (v: string) => string;
}
interface DialogSpec {
  title: string;
  text?: string;
  icon?: string;
  ok?: string;
  danger?: boolean;
  input?: Omit<Field, 'key'>;
  fields?: Field[];
  extra?: { key: string; label: string };   // a left-hand button; choosing it resolves to {_extra: key}
  body?: ComponentChildren;                 // custom content instead of text (e.g. the Prepare PC steps)
  wide?: boolean;
  noCancel?: boolean;
  id: number;  // stable, so closing a lower dialog never hands its typed text to another
  resolve: (v: unknown) => void;
}
const dialogs = signal<DialogSpec[]>([]);
let dialogSeq = 0;

export function dialog<T = unknown>(spec: Omit<DialogSpec, 'resolve' | 'id'>): Promise<T | null> {
  return new Promise(resolve => {
    const d: DialogSpec = { ...spec, id: ++dialogSeq, resolve: v => resolve(v as T | null) };
    dialogs.value = [...dialogs.value, d];
    dialogsOpen.value = dialogs.value.length;
  });
}
function closeDialog(d: DialogSpec, value: unknown) {
  dialogs.value = dialogs.value.filter(x => x !== d);
  dialogsOpen.value = dialogs.value.length;
  d.resolve(value);
}

function DialogBox({ d }: { d: DialogSpec }) {
  const list: Field[] = d.fields || (d.input ? [{ key: '_', ...d.input }] : []);
  const [values, setValues] = useState(() => Object.fromEntries(list.map(f => [f.key, f.value || ''])));
  const [error, setError] = useState('');
  const [show, setShow] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setShow(true));
    (firstRef.current || okRef.current)?.focus();
  }, []);

  const accept = () => {
    if (!list.length) return closeDialog(d, true);
    const out: Record<string, string> = {};
    for (const f of list) {
      const v = f.secret ? values[f.key] : values[f.key].trim();  // a password may start or end with a space
      const bad = f.validate?.(v);
      if (bad) { setError(bad); return; }
      out[f.key] = v;
    }
    closeDialog(d, d.fields ? out : out._);
  };
  // Only the top dialog listens to the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogs.value.at(-1) !== d) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(d, null); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); accept(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  return (
    <div class={`dlg-back${show ? ' show' : ''}`} onClick={e => { if (e.target === e.currentTarget) closeDialog(d, null); }}>
      <div class="dlg" role="dialog" aria-modal="true" style={d.wide ? 'width:min(520px,100%)' : undefined}>
        <div class={`di ${d.danger ? 'danger' : 'info'}`}><DialogIcon name={d.icon || 'other'} /></div>
        <h3>{d.title}</h3>
        {d.text && <p>{d.text}</p>}
        {d.body}
        {list.map((f, i) => (
          <label class="dlg-field" key={f.key}>
            {f.label && <span>{f.label}</span>}
            <input ref={i === 0 ? firstRef : undefined} type={f.secret ? 'password' : 'text'} spellcheck={false}
                   autocomplete={f.secret ? 'new-password' : 'off'} placeholder={f.placeholder || ''} value={values[f.key]}
                   onInput={e => setValues({ ...values, [f.key]: (e.target as HTMLInputElement).value })} />
            {f.hint && <small>{f.hint}</small>}
          </label>
        ))}
        {list.length > 0 && <div class="err-msg">{error}</div>}
        <div class="row-btns">
          {d.extra && <button class="dlg-extra" onClick={() => closeDialog(d, { _extra: d.extra!.key })}>{d.extra.label}</button>}
          {!d.noCancel && <button onClick={() => closeDialog(d, null)}>Cancel</button>}
          <button ref={okRef} class={d.danger ? 'danger' : 'primary'} onClick={accept}>{d.ok || 'OK'}</button>
        </div>
      </div>
    </div>
  );
}

export function Dialogs() {
  return <>{dialogs.value.map(d => <DialogBox key={d.id} d={d} />)}</>;
}

// --- A button that shows it's working --------------------------------------------
// While its async onClick runs: a spinner instead of the icon, no double clicks. minMs keeps the
// spinner up a little (Remote Desktop takes a few seconds to show its window).

type BtnProps = Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'onClick'> & { onClick: () => unknown; minMs?: number; disabled?: boolean };

export function AsyncButton({ onClick, minMs = 0, class: cls, children, ...rest }: BtnProps) {
  const [busy, setBusy] = useState(false);
  const run = async (e: Event) => {
    e.stopPropagation();
    if (busy) return;
    const t0 = Date.now();
    setBusy(true);
    try { await onClick(); }
    finally {
      const left = minMs - (Date.now() - t0);
      if (left > 0) await new Promise(r => setTimeout(r, left));
      setBusy(false);
    }
  };
  return <button {...rest} class={`${cls || ''}${busy ? ' busy' : ''}`} onClick={run}>{children}</button>;
}

// --- Chart tooltip -------------------------------------------------------------
// Charts call showTip while the mouse is over a point, hideTip when it leaves.

const tip = signal<{ x: number; y: number; text: string } | null>(null);
export const showTip = (e: MouseEvent, text: string) => { tip.value = { x: e.clientX, y: e.clientY, text }; };
export const hideTip = () => { tip.value = null; };

export function ChartTip() {
  const t = tip.value;
  if (!t) return null;
  return <div class="chart-tip" style={{ left: Math.min(t.x + 12, innerWidth - 120) + 'px', top: t.y - 30 + 'px' }}>{t.text}</div>;
}
