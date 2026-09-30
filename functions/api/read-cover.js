import { rateLimit } from '../_lib/rate-limit.js';

// Cloudflare Pages Function: POST /api/read-cover
//
// v197: vision cover reading. Accepts a downscaled book-cover photo and asks
// the vision model for the printed ISBN (digits only), falling back to
// title/author when no ISBN is printed (pre-1970 books have none). The
// client validates any returned ISBN's check digit before trusting it — a
// misread becomes "couldn't read it", never the wrong book.
//
// The OpenAI API key lives in the Pages environment variable VISION_API_KEY
// (model override: VISION_MODEL, default gpt-4o-mini). The browser never
// sees the key. Shelf/bulk spine mode arrives in v198; this endpoint only
// accepts mode 'single' for now.
//
// Guards: POST only, JSON body, mode allowlist, image is a capped data URL
// or raw base64 (max ~2.5MB — the client downscales to ~1024px first),
// response_format json_object so the model can't ramble, temperature 0.

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_IMAGE_CHARS = 3500000; // ~2.6MB base64
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/:+@-]{0,119}$/;

const PROMPT_SINGLE = 'You are reading a photo of a book cover. Return a JSON ' +
  'object with exactly these keys: "isbn" (the printed ISBN digits with no ' +
  'dashes or spaces, or null if no ISBN is printed — pre-1970 books have ' +
  'none), "title" (or null), "author" (or null). The ISBN is usually printed ' +
  'near the barcode on the back cover. Prefer the ISBN when one is visible. ' +
  'Reply with ONLY the JSON object, no other text.';

const jsonErr = (status, error) => new Response(JSON.stringify({ error }),
  { status, headers: { 'Content-Type': 'application/json' } });

function cleanResult(obj) {
  if (!obj || typeof obj !== 'object') return { isbn: null, title: null, author: null };
  const s = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
  let isbn = s(obj.isbn);
  if (isbn) {
    isbn = isbn.replace(/[^0-9X]/gi, '').toUpperCase();
    if (!/^(\d{13}|\d{10}|\d{9}X)$/i.test(isbn)) isbn = null; // not ISBN-shaped: don't trust it
  }
  return { isbn, title: s(obj.title), author: s(obj.author) };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  // Vision calls cost more than text — cap harder than trope-infer.
  const limited = rateLimit(request, 'read-cover', 20, 60 * 1000);
  if (limited) return limited;

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const mode = body && body.mode;
  if (mode !== 'single') return new Response('bad request', { status: 400 }); // v198 adds 'shelf'
  let image = body && body.image;
  if (typeof image !== 'string' || !image.length || image.length > MAX_IMAGE_CHARS) {
    return new Response('bad request', { status: 400 });
  }
  // Accept a data URL or raw base64; normalize to a data URL for the model.
  if (!image.startsWith('data:')) image = 'data:image/jpeg;base64,' + image;
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
    return new Response('bad request', { status: 400 });
  }

  const key = (env.VISION_API_KEY || '').trim();
  if (!key) {
    return jsonErr(503, "cover reading isn't set up on this server (set VISION_API_KEY)");
  }
  const model = (env.VISION_MODEL || 'gpt-4o-mini').trim();
  if (!MODEL_RE.test(model)) return jsonErr(503, 'bad VISION_MODEL');

  let upstream;
  try {
    upstream = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'User-Agent': 'CozyLibram/1.0 read-cover',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT_SINGLE },
            { type: 'image_url', image_url: { url: image } },
          ],
        }],
      }),
    });
  } catch (e) {
    return jsonErr(502, 'vision provider unreachable');
  }
  if (!upstream.ok) {
    // Forward the upstream status so the client's 401/403/429 handling works.
    // Never leak the key: the body is the provider's, which contains no secret.
    return new Response(await upstream.text(), { status: upstream.status });
  }
  let parsed;
  try {
    parsed = cleanResult(JSON.parse(
      (await upstream.json()).choices[0].message.content));
  } catch (e) {
    return jsonErr(502, 'vision provider returned an unreadable answer');
  }
  return new Response(JSON.stringify(parsed),
    { headers: { 'Content-Type': 'application/json' } });
}
