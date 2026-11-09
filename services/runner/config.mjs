// Session configuration: the "Controles" of the site as one JSON object, validated with the bundle's own sanitizers (device settings, host map rules, endpoint mocks,
// method specs, permissions) plus the runner operator's network policy. Unknown keys are rejected so a typo never silently does nothing.
import { badRequest, HttpError } from '../../lib/http.mjs';

export const CONFIG_KEYS = ['device', 'network', 'permissions', 'methodOverrides', 'ignoredActivities', 'endpointMocks', 'eventSeconds', 'missingApis', 'strictCrash', 'memoryMiB', 'appData', 'raster', 'logcat', 'plugins', 'launch'];
const DEVICE_KEYS = ['screen', 'orientation', 'connectivity', 'navigation', 'fontScale', 'animatorScale', 'statusBarHeightDp', 'darkTheme', 'hour24', 'locale', 'timeZone', 'battery'];
const NETWORK_KEYS = ['allowedHosts', 'hostMap', 'offline', 'proxyUrl'];
const PERMISSION_KEYS = ['states', 'location', 'dialogs'];
export const RESTART_KEYS = ['missingApis', 'strictCrash', 'memoryMiB', 'appData', 'raster'];   // take effect at the next load (POST /sessions/:id/restart)
export const DIALOG_MODES = ['dismiss', 'manual', 'allow', 'once', 'deny'];
const MISSING_APIS = { strict: 'off', off: 'off', void: 'void', primitives: 'primitives', all: 'all' };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function only(value, keys, where) {
  if (!isObject(value)) throw badRequest(`${where} must be an object`);
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  if (unknown.length) throw badRequest(`${where}: unknown keys ${unknown.join(', ')} (allowed: ${keys.join(', ')})`);
}
const list = (value, where, max) => { if (value === undefined) return undefined; if (!Array.isArray(value)) throw badRequest(`${where} must be an array`); if (value.length > max) throw badRequest(`${where}: at most ${max} entries`); return value; };

/** Host pattern matching for the operator policy: "*" | "host" | "*.suffix" | "host:port". */
export function hostPermitted(host, patterns) {
  const name = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return patterns.some(pattern => {
    const p = pattern.toLowerCase(); if (p === '*') return true;
    const [pHost, pPort] = p.split(/:(?=\d+$)/), [hHost, hPort] = name.split(/:(?=\d+$)/);
    if (pPort && pPort !== hPort) return false;
    if (pHost.startsWith('*.')) return hHost.endsWith(pHost.slice(1)) && hHost.length > pHost.length - 1;
    return hHost === pHost;
  });
}
const hostOfTarget = text => { const raw = String(text ?? '').trim(); try { return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`).host; } catch { return raw; } };

/**
 * Validates a (full or partial) config. `modules`: the bundle's sanitizers. `policy`: { allowedHosts (operator patterns), pluginsAllowed, maxPlugins, maxPluginCodeBytes }.
 * Returns the normalized config (only the keys present in `input`).
 */
export function validateConfig(input, { modules, policy }, { partial = false } = {}) {
  if (input === undefined || input === null) return {};
  only(input, CONFIG_KEYS, 'config');
  const out = {};
  if (input.device !== undefined) {
    only(input.device, DEVICE_KEYS, 'config.device');
    const clean = modules.sanitizeSettings(input.device);
    out.device = Object.fromEntries(DEVICE_KEYS.filter(key => input.device[key] !== undefined).map(key => [key, clean[key]]));
    for (const key of ['screen', 'orientation', 'connectivity', 'navigation']) if (input.device[key] !== undefined && clean[key] !== input.device[key]) throw badRequest(`config.device.${key}: unsupported value ${JSON.stringify(input.device[key])}`);
  }
  if (input.network !== undefined) {
    only(input.network, NETWORK_KEYS, 'config.network');
    const network = {};
    if (input.network.allowedHosts !== undefined) {
      const hosts = modules.sanitizeHosts(list(input.network.allowedHosts, 'config.network.allowedHosts', 64));
      if (hosts.length !== input.network.allowedHosts.length) throw badRequest('config.network.allowedHosts: malformed entry (use "host", "*.suffix", "host:port", an IP literal or "*")');
      const refused = hosts.filter(host => host === '*' ? !policy.allowedHosts.includes('*') : !hostPermitted(host.startsWith('*.') ? `x${host.slice(1)}` : host, policy.allowedHosts));
      if (refused.length) throw new HttpError(403, 'network-policy', `The runner's network policy (RUNNER_ALLOWED_HOSTS) does not allow: ${refused.join(', ')}`);
      network.allowedHosts = hosts;
    }
    if (input.network.hostMap !== undefined) {
      const rules = modules.sanitizeHostMap(list(input.network.hostMap, 'config.network.hostMap', 50));
      for (const [index, rule] of rules.entries()) {
        const parsed = modules.parseRule(rule); if (parsed.error) throw badRequest(`config.network.hostMap[${index}]: ${parsed.error}`);
        if (rule.enabled !== false && !hostPermitted(hostOfTarget(rule.to), policy.allowedHosts)) throw new HttpError(403, 'network-policy', `config.network.hostMap[${index}]: target ${rule.to} is not allowed by the runner's network policy (RUNNER_ALLOWED_HOSTS)`);
      }
      network.hostMap = rules;
    }
    if (input.network.offline !== undefined) { if (typeof input.network.offline !== 'boolean') throw badRequest('config.network.offline must be a boolean'); network.offline = input.network.offline; }
    if (input.network.proxyUrl !== undefined) {
      const proxy = modules.sanitizeProxyUrl(input.network.proxyUrl);
      if (input.network.proxyUrl && !proxy) throw badRequest('config.network.proxyUrl must be https (or http on loopback)');
      if (proxy && !hostPermitted(new URL(proxy.replace('{url}', 'x')).host, policy.allowedHosts)) throw new HttpError(403, 'network-policy', 'config.network.proxyUrl is not allowed by the runner\'s network policy');
      network.proxyUrl = proxy;
    }
    out.network = network;
  }
  if (input.permissions !== undefined) {
    only(input.permissions, PERMISSION_KEYS, 'config.permissions');
    const permissions = {};
    if (input.permissions.states !== undefined) {
      if (!isObject(input.permissions.states) || Object.keys(input.permissions.states).length > 200) throw badRequest('config.permissions.states must be an object { permission: "allow" | "deny" | "ask" } (at most 200)');
      for (const [name, state] of Object.entries(input.permissions.states)) { if (!['allow', 'deny', 'ask'].includes(state) || name.length > 200) throw badRequest(`config.permissions.states.${name}: use "allow", "deny" or "ask"`); }
      permissions.config = modules.sanitizePermissionConfig({ states: input.permissions.states, denials: {}, once: [] });
    }
    if (input.permissions.location !== undefined) permissions.location = modules.sanitizeLocation(input.permissions.location);
    if (input.permissions.dialogs !== undefined) { if (!DIALOG_MODES.includes(input.permissions.dialogs)) throw badRequest(`config.permissions.dialogs: one of ${DIALOG_MODES.join(', ')}`); permissions.dialogs = input.permissions.dialogs; }
    out.permissions = permissions;
  }
  if (input.methodOverrides !== undefined) {
    out.methodOverrides = list(input.methodOverrides, 'config.methodOverrides', 100).map((entry, index) => {
      if (!isObject(entry)) throw badRequest(`config.methodOverrides[${index}] must be { method, value, enabled }`);
      const parsed = modules.parseMethodSpec(entry.method); if (!parsed.ok) throw badRequest(`config.methodOverrides[${index}].method: ${parsed.error}`);
      return { method: String(entry.method).slice(0, 1000), value: String(entry.value ?? '').slice(0, 10000), enabled: entry.enabled !== false };
    });
  }
  if (input.ignoredActivities !== undefined) {
    out.ignoredActivities = list(input.ignoredActivities, 'config.ignoredActivities', 100).map((entry, index) => {
      const value = typeof entry === 'string' ? { name: entry, enabled: true } : entry;
      if (!isObject(value) || typeof value.name !== 'string' || !value.name || value.name.length > 500) throw badRequest(`config.ignoredActivities[${index}] must be "pkg.Activity" or { name, enabled }`);
      return { name: value.name, enabled: value.enabled !== false };
    });
  }
  if (input.endpointMocks !== undefined) {
    out.endpointMocks = list(input.endpointMocks, 'config.endpointMocks', modules.MAX_MOCKS).map((entry, index) => {
      const { errors, mock } = modules.validateMock(entry);
      if (errors.length) throw badRequest(`config.endpointMocks[${index}]: ${errors.map(e => `${e.field}: ${e.message}`).join('; ')}`);
      return mock;
    });
  }
  if (input.eventSeconds !== undefined) { const value = Number(input.eventSeconds); if (!(value === 0 || modules.EVENT_SECONDS_STEPS.includes(value))) throw badRequest(`config.eventSeconds: 0 (defaults) or one of ${modules.EVENT_SECONDS_STEPS.join(', ')}`); out.eventSeconds = value; }
  if (input.missingApis !== undefined) { if (!(input.missingApis in MISSING_APIS)) throw badRequest('config.missingApis: "strict" (default), "void", "primitives" or "all"'); out.missingApis = input.missingApis === 'off' ? 'strict' : input.missingApis; }
  if (input.strictCrash !== undefined) { if (typeof input.strictCrash !== 'boolean') throw badRequest('config.strictCrash must be a boolean'); out.strictCrash = input.strictCrash; }
  if (input.memoryMiB !== undefined) { const value = Number(input.memoryMiB); if (!modules.isMemoryStep(value)) throw badRequest(`config.memoryMiB: 0 (automatic) or one of ${modules.MEMORY_STEPS_MIB.join(', ')}`); if (value > policy.maxMemoryMiB) throw new HttpError(403, 'memory-policy', `config.memoryMiB above the runner's limit (${policy.maxMemoryMiB} MiB)`); out.memoryMiB = value; }
  if (input.appData !== undefined) { only(input.appData, ['keep', 'clear'], 'config.appData'); out.appData = { keep: input.appData.keep !== false, clear: input.appData.clear === true }; }
  if (input.raster !== undefined) { if (!['progressive', 'full'].includes(input.raster)) throw badRequest('config.raster: "full" (default) or "progressive"'); out.raster = input.raster; }
  if (input.logcat !== undefined) { if (!['on-demand', 'always'].includes(input.logcat)) throw badRequest('config.logcat: "on-demand" (default) or "always"'); out.logcat = input.logcat; }
  if (input.launch !== undefined) { if (!(typeof input.launch === 'boolean' || (typeof input.launch === 'string' && input.launch.length <= 500))) throw badRequest('config.launch: true, false or an Activity name'); out.launch = input.launch; }
  if (input.plugins !== undefined) out.plugins = validatePlugins(input.plugins, policy);
  if (!partial) for (const key of CONFIG_KEYS) if (out[key] === undefined) delete out[key];
  return out;
}

export function validatePlugins(input, policy) {
  const plugins = list(input, 'config.plugins', policy.maxPlugins);
  if (plugins.length && !policy.pluginsAllowed) throw new HttpError(403, 'plugins-disabled', 'Plugins are disabled on this runner (the operator must set RUNNER_ALLOW_PLUGINS=1; plugin code runs on the server, see the security section of the README)');
  const ids = new Set();
  return plugins.map((plugin, index) => {
    if (!isObject(plugin)) throw badRequest(`config.plugins[${index}] must be { id, name, code, enabled }`);
    const id = String(plugin.id ?? `plugin-${index + 1}`);
    if (!/^[\w.-]{1,64}$/.test(id) || ids.has(id)) throw badRequest(`config.plugins[${index}].id must be unique, 1-64 of [A-Za-z0-9_.-]`); ids.add(id);
    if (typeof plugin.code !== 'string' || !plugin.code.trim()) throw badRequest(`config.plugins[${index}].code must be the plugin's JavaScript (the body of an async function with \`lab\` in scope)`);
    if (Buffer.byteLength(plugin.code) > policy.maxPluginCodeBytes) throw badRequest(`config.plugins[${index}].code larger than ${policy.maxPluginCodeBytes} bytes`);
    return { id, name: String(plugin.name ?? id).slice(0, 120), code: plugin.code, enabled: plugin.enabled !== false, packageFilter: '' };
  });
}

/** The device object the Worker receives (device-profile resolveDevice input): device settings + network policy (offline = connectivity). */
export function deviceForVM(config, modules) {
  const settings = modules.sanitizeSettings({ ...(config.device ?? {}), network: { allowedHosts: config.network?.allowedHosts ?? [], hostMap: config.network?.hostMap ?? [], proxyUrl: config.network?.proxyUrl ?? '' } });
  if (config.network?.offline) settings.connectivity = 'offline';
  else if (config.device?.connectivity) settings.connectivity = config.device.connectivity;
  delete settings.location; delete settings.layoutBounds; delete settings.memoryMiB; delete settings.eventSeconds;
  return settings;
}
export const missingApisMode = value => MISSING_APIS[value ?? 'strict'] ?? 'off';
