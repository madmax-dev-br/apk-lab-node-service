// Server-side screenshots. The site draws a snapshot with the page's DOM: VM rasters (Compose/Canvas content, View backgrounds, shadows, Skia paragraphs) are
// images, plain XML widget text and simple controls are DOM. Here the same snapshot is composed with the bundle's CanvasKit (vendor/canvaskit, CPU surface):
//   * every VM raster is drawn exactly where the page puts it (rgba-raster pixels and PNG rasters, stretched to the View's bounds like the page's CSS does);
//   * text the page would draw with the DOM (TextView/Button/EditText without a Skia paragraph raster) is drawn with the bundled Roboto, one or more lines
//     wrapped to the content box: an approximation of the browser's text layout, reported in `notes` (`approximatedText`).
// Coordinates are the snapshot's dp (the VM's density is 1 dp = 1 px in the lab); `scale` multiplies the output size.
import { readFile } from 'node:fs/promises';
import path from "node:path";
import { pathToFileURL } from "node:url";

const FONT_FILES = { 400: 'Roboto-Regular.ttf', 500: 'Roboto-Medium.ttf', 700: 'Roboto-Bold.ttf', italic: 'Roboto-Italic.ttf', boldItalic: 'Roboto-BoldItalic.ttf' };
export const MAX_SCREENSHOT_SIDE = 4096, MAX_SCALE = 4;

const hexColor = (text, fallback) => {
  if (typeof text === 'string' && /^#[0-9a-f]{8}$/i.test(text)) { const v = parseInt(text.slice(1), 16) >>> 0; return [(v >>> 16) & 255, (v >>> 8) & 255, v & 255, (v >>> 24) / 255]; }
  if (typeof text === 'string' && /^#[0-9a-f]{6}$/i.test(text)) { const v = parseInt(text.slice(1), 16); return [(v >>> 16) & 255, (v >>> 8) & 255, v & 255, 1]; }
  return fallback;
};
const argbColor = value => { const a = Number(value) >>> 0; return [(a >>> 16) & 255, (a >>> 8) & 255, a & 255, (a >>> 24) / 255]; };

export function createScreenPainter({ runtimeDir, rasterBytes }) {
  let ready = null;
  const base = path.join(runtimeDir, 'vendor/canvaskit/0.42.0');
  async function init() {
    const { default: CanvasKitInit } = await import(pathToFileURL(path.join(base, "canvaskit.mjs")).href);
    const CK = await CanvasKitInit({ locateFile: name => path.join(base, name) });
    const faces = {};
    for (const [key, file] of Object.entries(FONT_FILES)) { try { faces[key] = CK.Typeface.MakeFreeTypeFaceFromData((await readFile(path.join(base, file))).buffer); } catch { /* optional face */ } }
    if (!faces[400]) throw new Error('Roboto-Regular.ttf could not be loaded from the runtime');
    return { CK, faces };
  }
  const get = () => (ready ??= init());

  /**
   * Paints `snapshot` -> { png: Buffer, width, height, notes }. crop: { left, top, right, bottom } in screen dp (after the system bars offset) or null.
   */
  async function paint(snapshot, { scale = 1, crop = null, systemBars = true } = {}) {
    const { CK, faces } = await get();
    const bars = snapshot?.systemBars ?? null;
    const screenW = Math.round(bars?.widthDp ?? Math.max(1, ...(snapshot?.views ?? []).map(v => v.bounds?.right ?? 0)));
    const screenH = Math.round(bars?.heightDp ?? Math.max(1, ...(snapshot?.views ?? []).map(v => v.bounds?.bottom ?? 0)));
    const k = Math.max(0.1, Math.min(MAX_SCALE, Number(scale) || 1));
    if (screenW * k > MAX_SCREENSHOT_SIDE || screenH * k > MAX_SCREENSHOT_SIDE) throw Object.assign(new Error(`screenshot larger than ${MAX_SCREENSHOT_SIDE}px`), { code: 'too-large' });
    const W = Math.max(1, Math.round(screenW * k)), H = Math.max(1, Math.round(screenH * k));
    const surface = CK.MakeSurface(W, H); if (!surface) throw new Error('CanvasKit could not create a surface');
    const canvas = surface.getCanvas(), notes = { approximatedText: 0, vectorDrawablesSkipped: 0, webviews: 0, rasters: 0 }, images = [], paints = [];
    const paintOf = (rgba) => { const p = new CK.Paint(); p.setAntiAlias(true); if (rgba) p.setColor(CK.Color(rgba[0], rgba[1], rgba[2], rgba[3])); paints.push(p); return p; };
    const fonts = new Map();
    const fontFor = (size, weight, italic) => {
      const face = italic ? (weight >= 600 ? faces.boldItalic : faces.italic) ?? faces[400] : weight >= 600 ? faces[700] ?? faces[400] : weight >= 500 ? faces[500] ?? faces[400] : faces[400];
      const key = `${size}|${weight}|${italic}`; if (!fonts.has(key)) fonts.set(key, new CK.Font(face, size)); return fonts.get(key);
    };
    const imageOf = raster => {
      if (!raster || typeof raster !== 'object') return null;
      let image = null;
      if (raster.kind === 'rgba-raster' && raster.image?.rgba) image = CK.MakeImage({ width: raster.image.width, height: raster.image.height, alphaType: CK.AlphaType.Unpremul, colorType: CK.ColorType.RGBA_8888, colorSpace: CK.ColorSpace.SRGB }, raster.image.rgba, raster.image.width * 4);
      else if (typeof raster.dataURL === 'string') { const bytes = rasterBytes(raster.dataURL); if (bytes) image = CK.MakeImageFromEncoded(bytes); }
      if (image) { images.push(image); notes.rasters++; }
      return image;
    };
    const drawRaster = (raster, x, y, w, h) => {
      if (raster && raster.kind !== 'raster' && raster.kind !== 'rgba-raster' && typeof raster.dataURL !== 'string') { if (raster.svg || typeof raster === 'string') notes.vectorDrawablesSkipped++; return; }
      const image = imageOf(raster); if (!image || !(w > 0 && h > 0)) return;
      canvas.drawImageRectOptions(image, CK.LTRBRect(0, 0, image.width(), image.height()), CK.LTRBRect(x, y, x + w, y + h), CK.FilterMode.Linear, CK.MipmapMode.None, null);
    };
    const measure = (font, text) => { const ids = font.getGlyphIDs(text); const widths = font.getGlyphWidths(ids); let sum = 0; for (const w of widths) sum += w; return sum; };
    const wrap = (font, text, width) => {
      const out = [];
      for (const paragraph of String(text).split('\n')) {
        if (!(width > 0)) { out.push(paragraph); continue; }
        let line = '';
        for (const word of paragraph.split(/(\s+)/)) {
          const candidate = line + word;
          if (line && measure(font, candidate.trimEnd()) > width + 0.5) { out.push(line.trimEnd()); line = word.trimStart(); }
          else line = candidate;
        }
        out.push(line);
      }
      return out;
    };
    const drawText = (view, kind, w, h) => {
      let text = view.displayText ?? view.text ?? ''; let color = hexColor(view.textColor, kind === 'button' ? [33, 33, 33, 1] : kind === 'input' ? [33, 33, 33, 1] : [117, 117, 117, 1]);
      if (kind === 'input' && !text && view.hint) { text = view.hint; color = [117, 117, 117, 1]; }
      if (!text) return;
      if (view.textAllCaps || (kind === 'button' && view.textAllCaps !== false)) text = text.toUpperCase();
      const size = Math.min(200, view.textSize > 0 ? view.textSize : 14), weight = view.textStyle & 1 ? 700 : Number(view.textFontWeight) || (kind === 'button' ? 500 : 400), italic = !!(view.textStyle & 2) || !!view.textFontItalic;
      const font = fontFor(size, weight, italic), metrics = font.getMetrics(), ascent = -metrics.ascent, descent = metrics.descent;
      const pad = (kind === 'check' && view.compoundPadding) ? view.compoundPadding : view.padding ?? {};
      const left = (pad.left || 0) + (kind === 'check' && !view.compoundPadding ? 28 : 0), right = w - (pad.right || 0), top = pad.top || 0, bottom = h - (pad.bottom || 0);
      const lineHeight = view.textLineHeight > 0 ? view.textLineHeight : Math.ceil(ascent + descent);
      const lines = kind === 'input' || view.singleLine ? [text.replace(/\n/g, ' ')] : wrap(font, text, right - left);
      const gravity = view.gravity > 0 ? view.gravity : kind === 'button' ? 0x11 : kind === 'input' || kind === 'check' ? 0x10 : 0;
      const block = lines.length * lineHeight;
      const vertical = gravity & 0x70, y0 = vertical === 0x10 ? top + (bottom - top - block) / 2 : vertical === 0x50 ? bottom - block : top;
      const p = paintOf(color);
      lines.forEach((line, index) => {
        const width = measure(font, line), horizontal = gravity & 7;
        const x = (gravity & 1) && horizontal !== 5 && horizontal !== 3 ? left + (right - left - width) / 2 : horizontal === 5 ? right - width : left;
        const baseline = y0 + index * lineHeight + (lineHeight - (ascent + descent)) / 2 + ascent;
        canvas.drawText(line, x, baseline, p, font);
      });
      notes.approximatedText++;
    };
    const drawCheck = (view, h) => {
      if (view.switchWidget) return;   // a VM-drawn Switch is part of the background raster
      const box = 18, x = (view.padding?.left || 0) + 2, y = (h - box) / 2, accent = [0, 150, 136, 1];
      const stroke = paintOf(view.checked ? accent : [117, 117, 117, 1]); stroke.setStyle(view.checked ? CK.PaintStyle.Fill : CK.PaintStyle.Stroke); stroke.setStrokeWidth(2);
      canvas.drawRRect(CK.RRectXY(CK.LTRBRect(x, y, x + box, y + box), 2, 2), stroke);
      if (view.checked) { const mark = paintOf([255, 255, 255, 1]); mark.setStyle(CK.PaintStyle.Stroke); mark.setStrokeWidth(2); const path = new CK.Path(); path.moveTo(x + 4, y + 9); path.lineTo(x + 8, y + 13); path.lineTo(x + 14, y + 5); canvas.drawPath(path, mark); path.delete(); }
    };
    const drawProgress = (view, w, h) => {
      const track = paintOf([231, 224, 236, 1]), bar = paintOf(hexColor(view.progressTint, [0, 150, 136, 1])), y = (h - 4) / 2;
      canvas.drawRect(CK.LTRBRect(0, y, w, y + 4), track);
      const fraction = view.indeterminate ? 0.3 : Math.max(0, Math.min(1, (view.progress || 0) / (view.max || 100)));
      canvas.drawRect(CK.LTRBRect(0, y, w * fraction, y + 4), bar);
    };
    const visit = (view, clip) => {
      if (!view || typeof view !== 'object' || view.visibility === 8 || view.visibility === 4 || !view.bounds) return;
      const b = view.bounds, w = b.right - b.left, h = b.bottom - b.top, kind = view.kind;
      if (view.shadow && Number.isFinite(view.shadow.margin)) drawRaster(view.shadow, b.left - view.shadow.margin, b.top - view.shadow.margin, view.shadow.width, view.shadow.height);
      canvas.save();
      canvas.translate(b.left, b.top);
      if (Array.isArray(view.transformMatrix) && view.transformMatrix.length === 9) { const m = view.transformMatrix; canvas.concat([m[0], m[1], m[2], m[3], m[4], m[5], 0, 0, 1]); }
      if (clip) canvas.clipRect(CK.LTRBRect(0, 0, w, h), CK.ClipOp.Intersect, true);
      const alpha = Number.isFinite(view.renderAlpha) ? view.renderAlpha : 1;
      if (alpha < 1) { const layer = paintOf(); layer.setAlphaf(Math.max(0, alpha)); canvas.saveLayer(layer); }
      if (view.background) { const color = hexColor(view.background, null); if (color) canvas.drawRect(CK.LTRBRect(0, 0, w, h), paintOf(color)); }
      if (view.drawableSVG) drawRaster(view.drawableSVG, 0, 0, w, h);
      if (kind === 'webview') { notes.webviews++; canvas.drawRect(CK.LTRBRect(0, 0, w, h), paintOf([245, 245, 245, 1])); }
      if (view.textRaster && ['text', 'button'].includes(kind)) { const pad = view.compoundPadding || view.padding || {}; drawRaster(view.textRaster, pad.left || 0, pad.top || 0, view.textRaster.width, view.textRaster.height); }
      else if (['text', 'button', 'input', 'check'].includes(kind) && !view.contentRaster) drawText(view, kind, w, h);
      if (kind === 'check') drawCheck(view, h);
      if (kind === 'progress') drawProgress(view, w, h);
      if (!view.canvasChildrenCaptured && Array.isArray(view.children) && view.children.length) {
        const pad = view.padding || {}, clipPadding = kind !== 'scroll' && view.clipToPadding !== false && Object.values(pad).some(v => v > 0);
        canvas.save();
        if (clipPadding) canvas.clipRect(CK.LTRBRect(pad.left || 0, pad.top || 0, w - (pad.right || 0), h - (pad.bottom || 0)), CK.ClipOp.Intersect, true);
        if (view.scrollX || view.scrollY) canvas.translate(-(view.scrollX || 0), -(view.scrollY || 0));
        for (const child of view.children) visit(child, view.clipChildren !== false);
        canvas.restore();
      }
      if (view.contentRaster) drawRaster(view.contentRaster, 0, 0, w, h);
      if (view.foregroundSVG) drawRaster(view.foregroundSVG, 0, 0, w, h);
      if (alpha < 1) canvas.restore();
      canvas.restore();
    };
    try {
      canvas.scale(k, k);
      canvas.clear(CK.WHITE);
      const frame = bars?.contentFrame ?? { left: 0, top: 0, right: screenW, bottom: screenH };
      const roots = snapshot?.views ?? [], main = roots.find(view => !view.windowSurface);
      // PhoneWindow background (android:windowBackground of the Activity theme)
      const background = main?.windowBackground;
      canvas.save(); canvas.translate(frame.left, frame.top);
      const frameW = frame.right - frame.left, frameH = frame.bottom - frame.top;
      if (background?.kind === 'color') canvas.drawRect(CK.LTRBRect(0, 0, frameW, frameH), paintOf(argbColor(background.argb)));
      else if (background?.kind === 'drawable') drawRaster(background.drawing, 0, 0, frameW, frameH);
      for (const root of roots) {
        const surfaceInfo = root.windowSurface;
        if (surfaceInfo && surfaceInfo.visible === false) continue;
        if (surfaceInfo?.modal && surfaceInfo.dimAmount > 0) canvas.drawRect(CK.LTRBRect(-frame.left, -frame.top, screenW, screenH), paintOf([0, 0, 0, Math.min(1, surfaceInfo.dimAmount)]));
        canvas.save(); canvas.translate(surfaceInfo?.x ?? 0, surfaceInfo?.y ?? 0); visit(root, false); canvas.restore();
      }
      canvas.restore();
      if (systemBars && bars) {
        if (bars.status?.visible && bars.status.height > 0) canvas.drawRect(CK.LTRBRect(0, 0, screenW, bars.status.height), paintOf(argbColor(bars.status.color)));
        if (bars.nav?.visible && bars.nav.thickness > 0) {
          const t = bars.nav.thickness, rect = bars.nav.side === 'right' ? CK.LTRBRect(screenW - t, 0, screenW, screenH) : bars.nav.side === 'left' ? CK.LTRBRect(0, 0, t, screenH) : CK.LTRBRect(0, screenH - t, screenW, screenH);
          canvas.drawRect(rect, paintOf(argbColor(bars.nav.color)));
        }
      }
      let image = surface.makeImageSnapshot(), width = W, height = H;
      if (crop) {
        const l = Math.max(0, Math.floor(crop.left * k)), t = Math.max(0, Math.floor(crop.top * k)), r = Math.min(W, Math.ceil(crop.right * k)), bt = Math.min(H, Math.ceil(crop.bottom * k));
        if (!(r > l && bt > t)) { image.delete(); throw Object.assign(new Error('The element is outside the screen'), { code: 'empty-crop' }); }
        const cropped = surface.makeImageSnapshot([l, t, r, bt]); image.delete(); image = cropped; width = r - l; height = bt - t;
      }
      const bytes = image.encodeToBytes(CK.ImageFormat.PNG, 100); image.delete();
      if (!bytes) throw new Error('PNG encoding failed');
      return { png: Buffer.from(bytes), width, height, notes };
    } finally {
      for (const image of images) image.delete();
      for (const p of paints) p.delete();
      for (const font of fonts.values()) font.delete();
      surface.delete();
    }
  }
  return { paint, ready: get };
}
