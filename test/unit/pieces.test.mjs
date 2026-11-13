// Pieces of the screen (services/runner/pieces.mjs): the request shapes the runner and the queue accept, refused with a 400 that names the field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rectFrom, paddingFrom, piecesFrom, pieceOut, MAX_PIECES } from '../../services/runner/pieces.mjs';
import { validateSteps } from '../../services/queue/steps.mjs';

test('rect: "l,t,r,b", [l, t, r, b] or { left, top, right, bottom } in window dp, with area', () => {
  assert.deepEqual(rectFrom('0,0,200,100'), { left: 0, top: 0, right: 200, bottom: 100 });
  assert.deepEqual(rectFrom([16, 172.5, 395, 236]), { left: 16, top: 172.5, right: 395, bottom: 236 });
  assert.deepEqual(rectFrom({ left: 1, top: 2, right: 3, bottom: 4 }), { left: 1, top: 2, right: 3, bottom: 4 });
  assert.equal(rectFrom(null), null); assert.equal(rectFrom(''), null);
  for (const bad of ['1,2,3', '0,0,0,10', '10,0,5,5', 'a,b,c,d', [0, 0, 1e6, 10], { left: 0, top: 0, right: 5 }]) assert.throws(() => rectFrom(bad), { status: 400 }, JSON.stringify(bad));
  assert.equal(paddingFrom('8'), 8); assert.equal(paddingFrom(undefined), 0); assert.throws(() => paddingFrom(65), { status: 400 }); assert.throws(() => paddingFrom(-1), { status: 400 });
});

test('pieces: 1 to 16, each exactly one of rect, key or selector (with an optional own padding); the PNG goes out as base64', () => {
  assert.deepEqual(piecesFrom([{ selector: { testTag: 'search' } }, { key: 'c:1:2', padding: 4 }, { rect: '0,0,200,100' }]),
    [{ selector: { testTag: 'search' } }, { key: 'c:1:2', padding: 4 }, { rect: { left: 0, top: 0, right: 200, bottom: 100 } }]);
  for (const bad of [undefined, [], Array.from({ length: MAX_PIECES + 1 }, () => ({ key: 'k' })), [{}], [{ key: 'k', rect: '0,0,1,1' }], [{ selector: { tag: 'x' } }], [{ key: '' }], [{ rect: '0,0,1' }], [{ key: 'k', zoom: 2 }]])
    assert.throws(() => piecesFrom(bad), { status: 400 }, JSON.stringify(bad));
  assert.deepEqual(pieceOut({ index: 0, kind: 'rect', width: 2, height: 1, png: Buffer.from('ab') }), { index: 0, kind: 'rect', width: 2, height: 1, pngBase64: 'YWI=' });
  assert.deepEqual(pieceOut({ index: 1, kind: 'key', error: { code: 'element-not-found', message: 'x' } }), { index: 1, kind: 'key', error: { code: 'element-not-found', message: 'x' } });
});

test('queue steps: screenshot with rect and padding, and screenshotPieces, are validated before a job is accepted', () => {
  assert.equal(validateSteps([{ type: 'screenshot', rect: '0,0,200,100', padding: 4 }, { type: 'screenshotPieces', pieces: [{ selector: { testTag: 'search' } }, { rect: [0, 0, 10, 10] }], padding: 8 }]).length, 2);
  assert.throws(() => validateSteps([{ type: 'screenshot', rect: '0,0,1,1', selector: { testTag: 'x' } }]), /rect or selector/);
  assert.throws(() => validateSteps([{ type: 'screenshot', rect: '5,5,1,1' }]), /steps\[0\]\.rect/);
  assert.throws(() => validateSteps([{ type: 'screenshotPieces', pieces: [] }]), /pieces/);
  assert.throws(() => validateSteps([{ type: 'screenshotPieces', pieces: [{ key: 'k' }], padding: 100 }]), /padding/);
});
