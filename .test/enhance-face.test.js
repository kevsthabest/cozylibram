// /api/enhance-face (v281): body validation, prompt selection, image
// extraction, and the unauthenticated 400/405 paths (mode validation runs
// before auth).
const path = require('path');

const ROOT = '/home/hatch/workspace/booktok';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

(async () => {
  const mod = await import(path.join(ROOT, 'functions/api/enhance-face.js'));

  /* ---- cleanEnhanceBody ---- */
  const good = mod.cleanEnhanceBody({ image: 'data:image/jpeg;base64,AAA', mode: 'sharpen' });
  ok('valid body passes through', good && good.mode === 'sharpen' &&
    good.image === 'data:image/jpeg;base64,AAA');
  ok('restore mode accepted',
    mod.cleanEnhanceBody({ image: 'data:image/jpeg;base64,AAA', mode: 'restore' }).mode === 'restore');
  ok('bad mode rejected', mod.cleanEnhanceBody({ image: 'data:image/jpeg;base64,AAA', mode: 'x' }) === null);
  ok('missing mode rejected', mod.cleanEnhanceBody({ image: 'data:image/jpeg;base64,AAA' }) === null);
  ok('missing image rejected', mod.cleanEnhanceBody({ mode: 'sharpen' }) === null);
  ok('oversized image rejected',
    mod.cleanEnhanceBody({ image: 'data:image/jpeg;base64,' + 'A'.repeat(4000000), mode: 'sharpen' }) === null);
  ok('raw base64 normalized to a data URL',
    mod.cleanEnhanceBody({ image: 'AAA', mode: 'sharpen' }).image === 'data:image/jpeg;base64,AAA');
  ok('non-image data URL rejected',
    mod.cleanEnhanceBody({ image: 'data:text/plain;base64,AAA', mode: 'sharpen' }) === null);

  /* ---- enhancePrompt ---- */
  ok('sharpen prompt is faithful-only',
    /EXACTLY as photographed/.test(mod.enhancePrompt('sharpen')) &&
    /do not redesign/i.test(mod.enhancePrompt('sharpen')));
  ok('restore prompt targets damage',
    /stickers/i.test(mod.enhancePrompt('restore')) && /reconstruct/i.test(mod.enhancePrompt('restore')));
  ok('unknown mode has no prompt', mod.enhancePrompt('x') === null);

  /* ---- extractEnhancedImage ---- */
  const resp = { candidates: [{ content: { parts: [
    { text: 'done' },
    { inlineData: { mimeType: 'image/png', data: 'QQ==' } },
  ] } }] };
  ok('extracts the inline image',
    mod.extractEnhancedImage(resp) === 'data:image/png;base64,QQ==');
  ok('null when no image part', mod.extractEnhancedImage({ candidates: [] }) === null);
  ok('null on garbage', mod.extractEnhancedImage(null) === null);

  /* ---- onRequest: method + validation (no auth needed for these) ---- */
  const req = (method, body) => new Request('https://x/api/enhance-face', {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const env = {};
  let r = await mod.onRequest({ request: req('GET'), env });
  ok('GET -> 405', r.status === 405);
  r = await mod.onRequest({ request: req('POST', { image: 'data:image/jpeg;base64,AAA', mode: 'nope' }), env });
  ok('bad mode -> 400 before auth', r.status === 400);
  r = await mod.onRequest({ request: req('POST', { mode: 'sharpen' }), env });
  ok('missing image -> 400 before auth', r.status === 400);
  r = await mod.onRequest({
    request: new Request('https://x/api/enhance-face', { method: 'POST', body: 'not json' }), env,
  });
  ok('malformed JSON -> 400', r.status === 400);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
