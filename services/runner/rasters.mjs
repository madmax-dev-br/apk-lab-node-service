// PNG rasters of the VM snapshots, kept per process. The bundle's raster receiver (raster-cache.js createRasterReceiver) keeps the same bounded LRU as the VM Worker and
// turns every distinct PNG into a "URL" through `toURL`; here that URL is a key into this store, and the receiver's eviction (URL.revokeObjectURL) frees it.
const PREFIX = 'apklab-raster:';
const store = new Map(); let next = 0;
const nodeRevoke = URL.revokeObjectURL?.bind(URL);
URL.revokeObjectURL = url => { if (typeof url === 'string' && url.startsWith(PREFIX)) { store.delete(url); return; } return nodeRevoke?.(url); };

/** toURL / toImage for createRasterReceiver: PNG base64 -> stored Buffer; raw RGBA -> { rgba, width, height } (unpremultiplied, as the page's ImageData). */
export const rasterHooks = {
  toURL: base64 => { const key = `${PREFIX}${(++next).toString(36)}`; store.set(key, Buffer.from(base64, 'base64')); return key; },
  toImage: (buffer, width, height) => ({ rgba: new Uint8Array(buffer), width, height }),
};
export const rasterBytes = key => store.get(key) ?? null;
export const rasterStats = () => { let bytes = 0; for (const value of store.values()) bytes += value.length; return { entries: store.size, bytes }; };
export const isRasterKey = value => typeof value === 'string' && value.startsWith(PREFIX);
