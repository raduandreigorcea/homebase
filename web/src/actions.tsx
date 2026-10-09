// What the buttons, the device screen and the / palette do. One place, so they all behave the same.
import { enc, post, type Device } from './api';
import { USER_OK } from './format';
import { detailId, localPower, poll, powerOf, speedTarget, state, terminal } from './store';
import { dialog, toast, toastProgress, type Field } from './ui';

const NO_SERVER = 'Error: the server isn\'t responding';
/** The server always says ok true/false; an empty answer means it couldn't be reached. */
const answered = (j: object) => 'ok' in j;

/** [action, label, command] per device; the command is what you type in the palette. */
export function deviceActions(d: Device): [string, string, string][] {
  const out: [string, string, string][] = [];
  if (d.kind === 'tv') return out;  // TVs are driven over DLNA, never SSH
  if (d.ssh) out.push(['terminal', 'Open terminal', 'ssh']);
  if (d.windows && d.nla == null) out.push(['prepare', 'Prepare PC', 'prepare']);
  else if (d.windows && d.nla !== -1) out.push(['connect', 'Remote Desktop', 'rdp']);
  // Prepared before SSH was part of it (or SSH failed): running the command again adds it.
  if (d.windows && d.nla != null && !d.key) out.push(['prepare', 'Prepare again (adds SSH)', 'prepare']);
  if (d.has_wake) out.push(['wake', 'Wake it up', 'wake']);
  if (d.ssh && !d.key) out.push(['key', 'Password-free access…', 'key']);
  // Without SSH, a Windows PC still gets files: they go to the laptop folder Remote Desktop shares with it.
  if (!d.key && d.windows) out.push(['send', 'Send files…', 'send']);
  if (d.key) {
    out.push(['send', 'Send files…', 'send'], ['speed', 'Speed test', 'speed']);
    if (!d.windows) out.push(['update', 'Update the system', 'update']);
    out.push(['reboot', 'Restart', 'reboot'], ['poweroff', 'Shut down', 'poweroff']);
  }
  return out;
}

/** Which of a device's actions make sense right now (an off device can only be woken or edited). */
export function actionFits(d: Device, act: string): boolean {
  if (powerOf(d)) return false;  // a restart / shutdown in progress blocks everything else
  const on = state.value?.status[d.id]?.online;
  return on === false ? act === 'wake' : on === true ? act !== 'wake' : true;
}

export async function doAction(act: string, d: Device | undefined) {
  if (!d) return;
  switch (act) {
    case 'terminal': return openTerminal(d);
    case 'edit': case 'key': return editDevice(d);  // the password goes in the device's settings
    case 'prepare': return preparePc(d);
    case 'update': return openTerminal(d, 'update');
    case 'reboot': case 'poweroff': return power(d, act);
    case 'speed': speedTarget.value = d; return;
    case 'send': return pickFiles(d);
    case 'connect': return connect(d);
    case 'wake': return wake(d);
    case 'remove': return removeDevice(d);
  }
}

export async function connect(d: Device) {
  toast('Opening Remote Desktop… this can take a few seconds', 'info');
  const j = await post(`/api/connect/${enc(d.id)}`);
  if (!j.ok) toast(j.error || 'Couldn\'t open Remote Desktop', 'err');
}

export async function wake(d: Device) {
  const j = await post(`/api/wake/${enc(d.id)}`);
  toast(j.ok ? 'Wake-up signal sent. It can take a minute.' : NO_SERVER, j.ok ? 'info' : 'err');
}

export async function removeDevice(d: Device) {
  const go = await dialog({ title: `Remove "${d.name}"?`, icon: 'x', ok: 'Remove', danger: true,
                            text: 'It disappears from the panel. Add it again later and its settings come back.' });
  if (!go) return;
  const j = await post(`/api/remove/${enc(d.id)}`);
  if (j.ok) { if (detailId.value === d.id) detailId.value = null; toast('Removed from the panel', 'ok'); }
  else toast(NO_SERVER, 'err');
  await poll();
}

/** Restart / shut down in the background (no terminal). The card shows it at once; the server keeps
 *  showing it until the device is back (or off). Only if sudo wants a password does the terminal open. */
async function power(d: Device, act: 'reboot' | 'poweroff') {
  const reboot = act === 'reboot';
  const go = await dialog({
    title: `${reboot ? 'Restart' : 'Shut down'} ${d.name}?`, icon: 'power', danger: !reboot, ok: reboot ? 'Restart' : 'Shut down',
    text: reboot ? 'It\'s back on the network in 1–2 minutes.' : 'To turn it back on, someone has to press its power button (or unplug it and plug it back in).',
  });
  if (!go) return;
  localPower.value = { ...localPower.value, [d.id]: act };
  const j = await post<{ ok?: boolean; password?: boolean }>(`/api/power/${enc(d.id)}`, { action: act });
  const { [d.id]: _gone, ...rest } = localPower.value;
  localPower.value = rest;
  if (j.ok) { toast(reboot ? `${d.name} is restarting. It's back in 1–2 minutes.` : `${d.name} is shutting down.`, 'ok'); poll(); }
  else if (j.password) { toast(`${d.name} wants a password for this; type it in the terminal.`, 'info'); openTerminal(d, act); }
  else toast(`Couldn't ${reboot ? 'restart' : 'shut down'} ${d.name}`, 'err');
}

export async function saveDevice(id: string, changes: Record<string, string>): Promise<boolean> {
  const j = await post(`/api/edit/${enc(id)}`, changes);
  if (!j.ok) { toast(answered(j) ? j.error || 'Couldn\'t save' : NO_SERVER, 'err'); return false; }
  await poll();
  return true;
}

/** Nothing is assumed about the login: the first time, ask which user to sign in as. */
export async function openTerminal(d: Device, mode = 'shell') {
  if (!d.ssh_user) {
    const user = await dialog<string>({
      title: `Which user do you sign in to ${d.name} as?`, icon: 'terminal', ok: 'Connect',
      text: 'The one picked when the system was installed (in Raspberry Pi Imager: "username"). It\'s remembered; change it with ✎.',
      input: { placeholder: 'e.g. pi, admin, ubuntu', validate: v => v ? USER_OK(v) : 'Type a user name' },
    });
    if (!user || !await saveDevice(d.id, { ssh_user: user })) return;
    d = state.value?.devices.find(x => x.id === d.id) || { ...d, ssh_user: user };
  }
  terminal.value = { dev: d, mode };
}

/** One place to change what's specific to each device: name, user and password. */
export async function editDevice(d: Device) {
  const fields: Field[] = [{ key: 'name', label: 'Name', value: d.name, validate: v => v ? '' : 'Type a name' }];
  if (d.kind !== 'tv') {
    fields.push({
      key: 'ssh_user', label: d.windows ? 'Windows user' : 'SSH user', value: d.ssh_user || '',
      placeholder: d.windows ? 'what whoami shows after \\' : 'e.g. pi, admin, ubuntu',
      hint: d.windows
        ? 'For Remote Desktop and SSH. If Windows asks for something else when signing in (like your Microsoft account email), type it there and it\'s remembered.'
        : 'The one picked when the system was installed (in Raspberry Pi Imager: "username").',
      validate: v => v ? USER_OK(v) : '',
    });
    fields.push({
      key: 'ssh_password', label: 'SSH password', secret: true,
      placeholder: d.key ? 'already set up' : 'the device\'s password',
      hint: d.key ? 'Password-free access works. Type the password only to set it up again; "Remove key" turns it off.'
        : d.windows ? 'Only if SSH is on the PC: once, for direct file sending, speed tests and restarts. It isn\'t saved. Remote Desktop asks for its own password.'
        : 'Used once, to set up password-free access. It isn\'t saved anywhere.',
    });
  }
  const v = await dialog<Record<string, string>>({
    title: 'Device settings', icon: d.kind, ok: 'Save', fields,
    extra: d.key ? { key: 'keyremove', label: 'Remove key' } : undefined,
  });
  if (!v) return;
  if (v._extra === 'keyremove') return removeKey(d);
  const { ssh_password: password, ...changes } = v;
  if (!await saveDevice(d.id, changes)) return;
  if (!password) return toast('Saved', 'ok');
  if (!changes.ssh_user) return toast('Saved. For password-free access, fill in the SSH user too.', 'err');
  const name = changes.name || d.name;
  toastProgress(`Setting up password-free access on ${name}…`);
  const j = await post(`/api/keysetup/${enc(d.id)}`, { password });
  toast(j.ok ? `Done! ${name} now works without a password` : j.error || NO_SERVER, j.ok ? 'ok' : 'err');
  poll();
}

async function removeKey(d: Device) {
  const go = await dialog({
    title: `Remove password-free access from ${d.name}?`, icon: 'x', danger: true, ok: 'Remove',
    text: 'Homebase deletes its key from the device. Stats, files and the speed test stop working ' +
          'until you type the password in settings again. The terminal still works, with a password.',
  });
  if (!go) return;
  toastProgress(`Removing the key from ${d.name}…`);
  const j = await post(`/api/keyremove/${enc(d.id)}`);
  toast(j.ok ? `Password-free access removed from ${d.name}` : j.error || NO_SERVER, j.ok ? 'ok' : 'err');
  poll();
}

/** "Prepare PC": one command, pasted once on a Windows PC, sets up stats, Remote Desktop and SSH. */
export async function preparePc(d: Device) {
  const j = await post<{ ok?: boolean; command?: string }>(`/api/agent/${enc(d.id)}`);
  if (!j.ok || !j.command) return toast('Couldn\'t make the command', 'err');
  const command = j.command;
  const copy = async (e: Event) => {
    try { await navigator.clipboard.writeText(command); }
    catch {
      const code = (e.currentTarget as HTMLElement).previousElementSibling!;
      const range = document.createRange(); range.selectNodeContents(code);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range); document.execCommand('copy');
    }
    toast('Command copied', 'ok');
  };
  await dialog({
    title: 'Prepare this PC', icon: 'connect', ok: 'Done', noCancel: true, wide: true,
    text: 'Once per Windows PC. After that you see it live here and connect to it in one click.',
    body: <>
      <ol>
        <li>On the PC, press <b>Win + X</b> and pick <b>Terminal (Admin)</b> (or <b>Windows PowerShell (Admin)</b>), then <b>Yes</b>.</li>
        <li>Paste the command below and press <b>Enter</b>. It shows its progress and takes 1–2 minutes.</li>
      </ol>
      <div class="cmd"><code>{command}</code><button title="Copy" onClick={copy}>Copy</button></div>
      <p style="margin-top:12px;font-size:12px">The command works for 15 minutes. It turns on stats, Remote Desktop and SSH; when you connect, you sign in on the usual Windows screen with your PIN or password.</p>
    </>,
  });
}

export async function tvSend(id: string, op: string, value?: number | boolean) {
  const j = await post(`/api/tv/${enc(id)}`, { op, value });
  if (!j.ok) toast(!answered(j) ? NO_SERVER : op === 'volume' || op === 'mute'
    ? 'The TV didn\'t change the volume. It only accepts it while playing over DLNA.' : 'The TV didn\'t respond', 'err');
  poll();
}

// --- Sending files: "send <device>", the device screen, or dropping files on a card ---

function pickFiles(d: Device) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => { if (input.files?.length) sendFiles(d, [...input.files]); };
  input.click();
}

/** Resolves to the server's answer: {ok, via: "ssh" | "shared", folder}. */
function uploadOne(d: Device, file: File, label: string): Promise<{ ok?: boolean; via?: string; folder?: string }> {
  return new Promise(resolve => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/send/${enc(d.id)}?name=${enc(file.name)}`);
    x.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const pct = Math.round(100 * e.loaded / e.total);
      toastProgress(pct < 100 ? `${label}: ${pct}%` : `${label}: copying to ${d.name}…`);
    };
    x.onload = () => { try { resolve(JSON.parse(x.responseText)); } catch { resolve({}); } };
    x.onerror = () => resolve({});
    x.send(file);
  });
}

export async function sendFiles(d: Device, files: File[]) {
  if (!d.key && !d.windows) return toast(`First type the SSH password in ${d.name}'s settings (✎)`, 'err');
  let ok = 0, res: { via?: string; folder?: string } = {};
  for (const [i, f] of files.entries()) {
    const label = files.length > 1 ? `${f.name} (${i + 1}/${files.length})` : f.name;
    toastProgress(`${label}: 0%`);
    const r = await uploadOne(d, f, label);
    if (r.ok) { ok++; res = r; }
  }
  const what = ok > 1 ? `${ok} files` : files[0].name;
  if (ok < files.length) toast(`Sent ${ok} of ${files.length}. Check that ${d.name} is on.`, 'err');
  // Without SSH they wait in the laptop folder that Remote Desktop shows on the PC.
  else if (res.via === 'shared') toast(`${what}: on the PC, in Remote Desktop › This PC › the shared folder (${res.folder?.split('/').pop()})`, 'ok');
  else toast(`${what}${ok > 1 ? ' are' : ' is'} on ${d.name}, in ${d.windows ? 'Downloads' : `${d.ssh_user || 'the user'}'s home folder`}`, 'ok');
}
