import { rateLimit } from '../_lib/rate-limit.js';
import { authedUser, unauthorized, forbiddenBanned } from '../_lib/require-user.js';
import { geminiFetch } from '../_lib/gemini.js';

// v309: structured AI usage logging. Filter Cloudflare logs by [AI_USAGE].
function aiLog(endpoint, user, status, detail) {
  try {
    var u = user && (user.email || user.id) || 'anon';
    console.log('[AI_USAGE] endpoint=' + endpoint + ' user=' + u + ' status=' + status + (detail ? ' detail=' + detail : ''));
  } catch (e) {}
}

// Cloudflare Pages Function: POST /api/enhance-face
//
// v281: AI post-processing for scanned edition faces. The phone camera can't
// focus closely, so scanned text often comes out soft — and some copies are
// shelf-worn. Two opt-in modes, both via the already-configured Gemini key
// (no new provider):
//   'sharpen' — deblur/denoise/sharpen printed text and detail, faithful.
//   'restore' — remove stickers, price tags, scuffs and creases, reconstruct
//               hidden artwork plausibly.
//
// Uses the native Gemini generateContent image-editing model
// (gemini-2.5-flash-image; override with ENHANCE_MODEL). The key lives
// server-side: VISION_API_KEY, falling back to TROPE_KEY_GEMINI.
//
// Guards: POST only, mode allowlist, image is a capped data URL or raw
// base64 (max ~2.6MB). Signed-in callers only (v225: quota-spending
// endpoint), rate-limited harder than read-cover (image edits cost more).
// The client always shows before/after and the user keeps or discards —
// enhancement is never applied silently.

const GEN_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_IMAGE_CHARS = 3500000; // ~2.6MB base64
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/:+@-]{0,119}$/;

const PROMPTS = {
  sharpen:
    'You are enhancing a straightened photo of one face of a physical book ' +
    '(a spine, cover, or page edge). Remove camera blur and noise; sharpen ' +
    'printed text and fine detail; even out mild lighting falloff. Keep the ' +
    'design, colors, typography, layout, and wording EXACTLY as photographed ' +
    '— do not redesign, reword, translate, or add any element. Output only ' +
    'the enhanced image.',
  restore:
    'You are restoring a straightened photo of one face of a physical book ' +
    '(a spine, cover, or page edge). Remove stickers, price tags, library ' +
    'labels, scuffs, scratches, creases, and shelf wear; plausibly ' +
    'reconstruct any artwork or text hidden underneath, matching the ' +
    'surrounding design, colors, and typography. Keep everything else ' +
    'exactly as photographed — do not redesign what is undamaged. Output ' +
    'only the restored image.',
};

export function enhancePrompt(mode) {
  return PROMPTS[mode] || null;
}

// Pure: validate + normalize the request body. Returns { image, mode } or null.
export function cleanEnhanceBody(body) {
  const mode = body && body.mode;
  if (mode !== 'sharpen' && mode !== 'restore') return null;
  let image = body && body.image;
  if (typeof image !== 'string' || !image.length || image.length > MAX_IMAGE_CHARS) return null;
  if (!image.startsWith('data:')) image = 'data:image/jpeg;base64,' + image;
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(image)) return null;
  return { image, mode };
}

// Pure: pull the first inline image out of a generateContent response.
export function extractEnhancedImage(json) {
  try {
    const parts = json.candidates[0].content.parts;
    for (const p of parts) {
      if (p.inlineData && p.inlineData.data) {
        return 'data:' + (p.inlineData.mimeType || 'image/png') + ';base64,' + p.inlineData.data;
      }
    }
  } catch (e) {}
  return null;
}

const jsonErr = (status, error) => new Response(JSON.stringify({ error }),
  { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response('bad request', { status: 400 });
  }
  const clean = cleanEnhanceBody(body);
  if (!clean) return new Response('bad request', { status: 400 });
  // v225 (security): quota-spending endpoint — signed-in callers only.
  const user = await authedUser(request, env);
  if (!user) { aiLog('enhance-face', null, '401', 'no-auth'); return unauthorized(); }
  if (user.banned) { aiLog('enhance-face', user, '403', 'banned'); return forbiddenBanned(); }
  const limited = rateLimit(request, 'enhance-face', 10, 60 * 1000);
  if (limited) { aiLog('enhance-face', user, '429', 'local-limiter'); return limited; }

  const key = (env.VISION_API_KEY || '').trim() || (env.TROPE_KEY_GEMINI || '').trim();
  if (!key) {
    return jsonErr(503, "face enhancement isn't set up on this server (set VISION_API_KEY or TROPE_KEY_GEMINI)");
  }
  const model = (env.ENHANCE_MODEL || 'gemini-2.5-flash-image').trim();
  if (!MODEL_RE.test(model)) return jsonErr(503, 'bad ENHANCE_MODEL');

  const b64 = clean.image.split(',')[1];
  const g = await geminiFetch(GEN_URL + '/' + model + ':generateContent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
      'User-Agent': 'CozyLibram/1.0 enhance-face',
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: enhancePrompt(clean.mode) },
          { inlineData: { mimeType: 'image/jpeg', data: b64 } },
        ],
      }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });
  if (!g.ok) {
    aiLog('enhance-face', user, String(g.status || 'network-err'), 'upstream');
    if (g.networkError) return jsonErr(502, 'enhance provider unreachable');
    const status = g.status;
    // Same mapping as read-cover: a 503 from OUR endpoint unambiguously
    // means "not set up"; upstream overload surfaces as 502.
    if (status === 503) return jsonErr(502, 'enhance model temporarily unavailable (upstream 503)');
    return new Response(await g.res.text(), { status });
  }
  let out = null;
  try {
    out = extractEnhancedImage(await g.res.json());
  } catch (e) {}
  if (!out) { aiLog('enhance-face', user, '502', 'no-image'); return jsonErr(502, 'enhance model returned no image'); }
  aiLog('enhance-face', user, 'ok', model);
  return new Response(JSON.stringify({ image: out }),
    { headers: { 'Content-Type': 'application/json' } });
}
