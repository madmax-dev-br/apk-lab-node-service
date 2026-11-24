// What a server plugin may do with the session: the `actions` of the site's plugin host (plugin-host.js ACTION_METHODS) that make sense without a page. Each one goes through
// the session's own operations (its queue, its limits, its snapshots), so a plugin does nothing the API does not already do for the caller who sent it, plus lab.invoke (a method
// of the app, run by the app's own bytecode on the VM's main thread: runtime/app-invoke.js). The actions that draw on the page (modal, tab, frame, highlight, overlay, track) have
// no place here: the host keeps refusing them by name ("unsupported"). Plugins themselves stay behind RUNNER_ALLOW_PLUGINS.
import { HttpError } from '../../lib/http.mjs';

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const fnv = text => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); };

/** The stable id of a plugin's mock (the site's rule): its own id, or one per method + URL, so two endpoints of one host never replace each other. */
export function pluginMockId(plugin, spec) {
  const method = String(spec.method ?? 'ANY');
  const key = spec.id !== undefined && spec.id !== null && String(spec.id) ? String(spec.id).replace(/[^\w-]+/g, '-').slice(0, 24) : `${method.toLowerCase()}-${fnv(`${method.toUpperCase()} ${spec.url ?? ''}`)}`;
  return `p${String(plugin.id).replace(/[^\w-]+/g, '').slice(-10)}-${key}`.slice(0, 40);
}

/**
 * session: services/runner/session.mjs; client: the VM client these actions belong to (a session that loaded its APK again has another one: an action left over from before fails).
 * host(): the plugin host (its query() reads scroll state and layout bounds like the page's own calls).
 */
export function createPluginActions({ session, client, host }) {
  const { bundle } = session;
  const current = () => { if (session.client !== client || session.state === 'closed') throw fail('stopped', 'The session loaded the APK again or closed.'); };
  const running = () => { current(); if (session.state !== 'running' || !session.snapshot) throw fail('no-apk', 'No app is running: launch it first (POST /sessions/:id/launch or config.launch).'); };
  /** One operation of the session's queue; the checks run when its turn comes (a plugin of config.plugins starts before the app is launched). */
  const operation = (name, fn) => session.op(name, async () => {
    try { running(); return { value: await fn() }; }
    catch (error) { if (error instanceof HttpError || ['no-apk', 'stopped'].includes(error?.code)) return { error }; throw error; }   // a refusal is the plugin's, not a VM failure of the session
  }).then(out => { if (out.error) throw out.error; return out.value; });

  let mocking = Promise.resolve();   // the list is read, changed and applied by one call at a time
  const mockTurn = fn => { const run = mocking.then(fn, fn); mocking = run.catch(() => {}); return run; };
  const applyMocks = async list => {
    current();
    const previous = session.config.endpointMocks ?? [];
    session.config.endpointMocks = list;
    try { return await client.setEndpointMocks(list); } catch (error) { if (session.config.endpointMocks === list) session.config.endpointMocks = previous; throw error; }
  };

  const scroll = typeof bundle.createLabScroll === 'function' ? bundle.createLabScroll({
    query: args => host().query('scrollState', args), elements: () => host().query('layoutBounds', { names: false }), views: () => bundle.flattenViews(session.snapshot),
    scrollBy: (target, dx, dy) => target.kind === 'compose' ? session.raw('compose-action', { ownerViewId: target.ownerViewId, nodeId: target.nodeId, action: 'ScrollBy', args: [dx, dy] }) : session.raw('scrollby', { id: target.id, dx, dy }),
    scrollToIndex: (target, index) => session.raw('compose-action', { ownerViewId: target.ownerViewId, nodeId: target.nodeId, action: 'ScrollToIndex', args: [index] }),
  }) : null;

  const actions = {
    async invoke(plugin, args) {
      const { invocation } = await operation('plugin-invoke', async () => {
        const reply = await client.invokeMethod({ handle: args.handle, className: args.className, method: args.method, signature: args.signature, args: Array.isArray(args.args) ? args.args : [] });
        if (reply.snapshot) session.setSnapshot(reply.snapshot);
        return { invocation: reply.invocation ?? {} };
      });
      if (invocation.error) throw fail(invocation.error.code ?? 'failed', invocation.error.message);
      if (invocation.exception) throw fail('exception', `${args.method} threw ${invocation.exception.type}${invocation.exception.message ? `: ${invocation.exception.message}` : ''}`, { exception: invocation.exception });
      return invocation;
    },
    async reload(plugin, args) {
      const mode = args.mode === 'reopen' ? 'reopen' : 'recreate';
      const snapshot = await operation('plugin-reload', async () => { const next = await client.reloadActivity({ mode }); session.setSnapshot(next); return next; });
      return { mode, activity: snapshot?.activityName ?? null };
    },
    mock: (plugin, spec) => mockTurn(async () => {
      const id = pluginMockId(plugin, spec), { errors, mock } = bundle.validateMock({ ...spec, id, name: spec.name ?? `plugin ${plugin.name}`, enabled: spec.enabled !== false });
      if (errors.length) throw fail('bad-args', errors.map(error => error.message).join(' '));
      const list = [...(session.config.endpointMocks ?? [])], at = list.findIndex(item => item.id === id);
      if (at >= 0) list[at] = mock; else { if (list.length >= bundle.MAX_MOCKS) throw fail('bad-args', `At most ${bundle.MAX_MOCKS} mocks.`); list.push(mock); }
      await applyMocks(list);
      return { id };
    }),
    unmock: (plugin, { id }) => mockTurn(async () => {
      const list = session.config.endpointMocks ?? [], next = list.filter(item => item.id !== String(id));
      if (next.length === list.length) return { removed: false };
      await applyMocks(next);
      return { removed: true };
    }),
    mocks() {
      const hits = new Map((session.snapshot?.endpointMocks ?? []).map(item => [item.id, item.hits]));
      return (session.config.endpointMocks ?? []).map(mock => ({ id: mock.id, name: mock.name, enabled: mock.enabled, method: mock.method, url: mock.url, status: mock.status, hits: hits.get(mock.id) ?? 0 }));
    },
  };
  if (scroll) Object.assign(actions, { async scrollTo(plugin, args) { running(); return scroll.scrollTo(args); }, async scrollInfo(plugin, args) { running(); return scroll.info(args); } });
  return actions;
}
