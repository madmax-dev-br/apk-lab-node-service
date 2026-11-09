// The parts of the public APK Web Lab bundle the runner uses directly (all DOM-free modules of the site): the Worker client, the raster cache, the layout-bounds
// model, the plugin host and runtime, and the Controles sanitizers. Nothing here is copied: the modules are imported from the runtime directory.
import { requireRuntime, importRuntime, runtimeFileURL } from '../../lib/runtime-dir.mjs';

/** Entry points of the bundle this service imports (scripts/make-runtime-lock.mjs follows their imports to build the download list). */
export const BUNDLE_ENTRY_POINTS = ['apk-worker-client.js', 'raster-cache.js', 'compose-inspector-panel.js', 'plugin-host.js', 'plugin-runtime.js', 'device-settings.js', 'runtime/apk-worker.js',
  'runtime/host-map.js', 'runtime/endpoint-mocks.js', 'runtime/method-overrides.js', 'runtime/runtime-permissions.js', 'runtime/time-limits.js', 'runtime/memory-budget.js', 'runtime/motion-raster.js'];

export async function loadBundle(dir) {
  const info = requireRuntime(dir);
  const [client, raster, panel, pluginHost, pluginRuntime, settings, hostMap, mocks, overrides, permissions, timeLimits, memory, motion] = await Promise.all([
    'apk-worker-client.js', 'raster-cache.js', 'compose-inspector-panel.js', 'plugin-host.js', 'plugin-runtime.js', 'device-settings.js', 'runtime/host-map.js', 'runtime/endpoint-mocks.js',
    'runtime/method-overrides.js', 'runtime/runtime-permissions.js', 'runtime/time-limits.js', 'runtime/memory-budget.js', 'runtime/motion-raster.js'].map(file => importRuntime(info, file)));
  return {
    info,
    workerURL: new URL(`${runtimeFileURL(info, 'runtime/apk-worker.js').href}?v=${info.revision}`),
    APKWorkerClient: client.APKWorkerClient,
    createRasterReceiver: raster.createRasterReceiver,
    buildLayoutBoundsElements: panel.buildLayoutBoundsElements, flattenViews: panel.flattenViews,
    createPluginHost: pluginHost.createPluginHost, screenFromSnapshot: pluginHost.screenFromSnapshot, pluginWorkerSource: pluginRuntime.pluginWorkerSource, PLUGIN_TEMPLATES: pluginRuntime.PLUGIN_TEMPLATES ?? [],
    sanitizeSettings: settings.sanitizeSettings, sanitizeHosts: settings.sanitizeHosts, sanitizeProxyUrl: settings.sanitizeProxyUrl,
    sanitizeHostMap: hostMap.sanitizeHostMap, parseRule: hostMap.parseRule,
    validateMock: mocks.validateMock, MAX_MOCKS: mocks.MAX_MOCKS ?? 50,
    parseMethodSpec: overrides.parseMethodSpec,
    sanitizePermissionConfig: permissions.sanitizeConfig, sanitizeLocation: permissions.sanitizeLocation, answerDialog: permissions.answerDialog,
    EVENT_SECONDS_STEPS: timeLimits.EVENT_SECONDS_STEPS, isMemoryStep: memory.isMemoryStep, MEMORY_STEPS_MIB: memory.MEMORY_STEPS_MIB, memoryBudget: memory.memoryBudget,
    MOTION_SCALE_STEPS: motion.MOTION_SCALE_STEPS ?? [1, 0.75, 0.5, 0.35, 0.25], defaultDeviceSettings: settings.defaultDeviceSettings,
  };
}
