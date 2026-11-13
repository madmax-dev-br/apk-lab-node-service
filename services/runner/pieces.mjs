// Pieces of the screen: a box of the window ("rect"), one element by key, or the first element a selector matches. Validation only (no session, no painting):
// the runner's REST routes and the queue's screenshotPieces step use it, and the session paints every piece from one picture (screen.mjs `crops`).
import { badRequest } from '../../lib/http.mjs';

export const MAX_PIECES = 16;
export const MAX_PADDING = 64;
const SELECTOR_KEYS = ['key', 'testTag', 'text', 'textContains', 'contentDescription', 'androidId', 'viewId', 'kind', 'clickable', 'index'];

/**
 * A box of the window in dp, the coordinates of layout-bounds `bounds`: "left,top,right,bottom" (a query value), [l, t, r, b] or { left, top, right, bottom }.
 * Returns null for null/undefined/'' and throws 400 for anything else that is not a box with area inside 0..10000.
 */
export function rectFrom(value, where = 'rect') {
  if (value === null || value === undefined || value === '') return null;
  const list = typeof value === 'string' ? value.split(',').map(part => part.trim()) : Array.isArray(value) ? value : [value?.left, value?.top, value?.right, value?.bottom];
  if (list.length !== 4 || list.some(item => item === '' || item === null || item === undefined)) throw badRequest(`${where}: left,top,right,bottom in dp of the window (the coordinates of layout-bounds "bounds")`);
  const [left, top, right, bottom] = list.map(Number);
  if (![left, top, right, bottom].every(n => Number.isFinite(n) && n >= -10000 && n <= 10000)) throw badRequest(`${where}: four numbers in dp`);
  if (!(right > left && bottom > top)) throw badRequest(`${where}: right must be greater than left and bottom greater than top`);
  return { left, top, right, bottom };
}

/** padding in dp around a piece: 0 to 64 (null/undefined -> fallback). */
export function paddingFrom(value, where = 'padding', fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PADDING) throw badRequest(`${where}: 0 to ${MAX_PADDING} dp`);
  return n;
}

/** The `pieces` of a request: 1 to 16 items, each exactly one of { rect }, { key } or { selector }, with an optional own padding. */
export function piecesFrom(list) {
  if (!Array.isArray(list) || list.length === 0) throw badRequest(`pieces: a list of 1 to ${MAX_PIECES} items, each { rect } | { key } | { selector }`);
  if (list.length > MAX_PIECES) throw badRequest(`pieces: at most ${MAX_PIECES} per call`);
  return list.map((piece, index) => {
    const where = `pieces[${index}]`;
    if (!piece || typeof piece !== 'object' || Array.isArray(piece)) throw badRequest(`${where}: { rect } | { key } | { selector }`);
    const unknown = Object.keys(piece).filter(key => !['rect', 'key', 'selector', 'padding'].includes(key)); if (unknown.length) throw badRequest(`${where}: unknown keys ${unknown.join(', ')}`);
    const given = ['rect', 'key', 'selector'].filter(key => piece[key] !== undefined);
    if (given.length !== 1) throw badRequest(`${where}: exactly one of rect, key or selector`);
    const padding = piece.padding === undefined ? undefined : paddingFrom(piece.padding, `${where}.padding`);
    if (piece.rect !== undefined) return { rect: rectFrom(piece.rect, `${where}.rect`), ...(padding !== undefined ? { padding } : {}) };
    if (piece.key !== undefined) { if (typeof piece.key !== 'string' || !piece.key || piece.key.length > 200) throw badRequest(`${where}.key: a key of layout-bounds`); return { key: piece.key, ...(padding !== undefined ? { padding } : {}) }; }
    const selector = piece.selector;
    if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw badRequest(`${where}.selector: { testTag | text | textContains | contentDescription | androidId | viewId | key | kind, index? }`);
    const extra = Object.keys(selector).filter(key => !SELECTOR_KEYS.includes(key)); if (extra.length) throw badRequest(`${where}.selector: unknown keys ${extra.join(', ')}`);
    for (const [key, value] of Object.entries(selector)) if (typeof value === 'string' && value.length > 2000) throw badRequest(`${where}.selector.${key} too long`);
    return { selector: { ...selector }, ...(padding !== undefined ? { padding } : {}) };
  });
}

/** A piece as JSON: the PNG as base64 (`pngBase64`), and its URL-free fields as they are. */
export function pieceOut(piece) {
  const { png, element, ...rest } = piece;
  return { ...rest, ...(element ? { element } : {}), ...(png ? { pngBase64: png.toString('base64') } : {}) };
}
