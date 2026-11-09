// "Tela pronta" and "Recriar / Reabrir" on the server: request validation for the reload and readiness endpoints, the public shape of snapshot.screenReady (the flag
// the lab's Worker attaches to every snapshot, runtime/screen-ready.js), and the plugin templates this service adds to the bundle's own.
import { badRequest } from '../../lib/http.mjs';

export const RELOAD_MODES = ['recreate', 'reopen'];
export const READY_TIMEOUT_MS = 15000, MAX_WAIT_MS = 120000;

/** The reload mode of a request body: 'recreate' (default: Activity.recreate(), saved state and retained ViewModels kept) or 'reopen' (a fresh instance with the same Intent). */
export function reloadModeFrom(body) {
  if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) throw badRequest('reload body must be an object { mode }');
  const unknown = Object.keys(body ?? {}).filter(key => key !== 'mode'); if (unknown.length) throw badRequest(`reload: unknown keys ${unknown.join(', ')}`);
  const mode = body?.mode ?? 'recreate';
  if (!RELOAD_MODES.includes(mode)) throw badRequest(`reload: mode must be ${RELOAD_MODES.map(m => `"${m}"`).join(' or ')}`);
  return mode;
}
/** `ready` of a wait body: true waits for "Tela pronta" (alone or together with a selector); anything but a boolean is refused. */
export function readyFlagFrom(value, where = 'ready') {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw badRequest(`${where} must be a boolean`);
  return value;
}
/** ?waitReady=1&readyTimeoutMs=… of a screenshot: { waitReady, readyTimeoutMs }. */
export function readyQueryFrom(searchParams) {
  const raw = searchParams.get('waitReady'), waitReady = raw !== null && /^(1|true|yes|on)$/i.test(raw);
  const text = searchParams.get('readyTimeoutMs'); let readyTimeoutMs = READY_TIMEOUT_MS;
  if (text !== null && text !== '') { const n = Number(text); if (!Number.isFinite(n)) throw badRequest(`readyTimeoutMs: not a number: ${text}`); readyTimeoutMs = Math.min(MAX_WAIT_MS, Math.max(0, n)); }
  return { waitReady, readyTimeoutMs };
}
/** snapshot.screenReady as the API shows it (null when the snapshot has none: no Activity yet, or an older runtime). */
export function screenReadyOut(snapshot) {
  const r = snapshot?.screenReady; if (!r) return null;
  return { ready: !!r.ready, activity: r.activity ?? null, readySince: r.readySince ?? null, settledForMs: r.settledForMs ?? 0, quietMs: r.quietMs ?? null,
    waitingFor: Array.isArray(r.waitingFor) ? [...r.waitingFor] : [], fragments: Array.isArray(r.fragments) ? r.fragments.map(f => ({ className: f.className ?? null, state: f.state ?? null, hidden: !!f.hidden, ready: !!f.ready })) : [] };
}

/** Plugin templates of this service, listed after the bundle's (GET /plugin-templates). They use only the lab API. */
export const SERVICE_PLUGIN_TEMPLATES = [
  { id: 'ready-screenshot', name: 'Print na tela pronta', description: 'Um print da tela inteira cada vez que ela fica pronta (a Activity e os fragments carregados e a tela parada).', code: `// Print na tela pronta: a cada vez que a tela fica pronta ("Tela pronta": a Activity em onResume com o primeiro quadro desenhado, os fragments RESUMED,
// nada pendente por 300 ms), um print da tela inteira. Uma nova Activity, um Recriar / Reabrir ou uma navegação que assenta gera um novo print.
const LARGURA = 540;   // largura máxima do print, em px
let prints = 0;
async function fotografar(tela) {
  prints++;
  lab.ui.badge(String(prints));
  const print = await lab.screenshot({ maxWidth: LARGURA });
  lab.ui.image(print, { id: 'print', caption: (tela.activity ? tela.activity.split('.').pop() : '—') + ' · pronta #' + prints });
  lab.ui.kv({ Activity: tela.activity ?? '—', 'Pronta desde': tela.ready?.readySince ? new Date(tela.ready.readySince).toISOString() : '—', Fragments: (tela.ready?.fragments ?? []).map(f => String(f.className).split('.').pop()).join(', ') || '—' }, { id: 'tela' });
}
lab.on('ready', tela => fotografar(tela).catch(erro => lab.ui.text(erro.message, { id: 'erro' })));
` },
];
