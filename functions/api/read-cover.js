import { rateLimit } from '../_lib/rate-limit.js';
import { authedUser, unauthorized, forbiddenBanned } from '../_lib/require-user.js';

// Cloudflare Pages Function: POST /api/read-cover
//
// v197: vision cover reading. Accepts a downscaled book-cover photo and asks
// the vision model for the printed ISBN (digits only), falling back to
// title/author when no ISBN is printed (pre-1970 books have none). The
// client validates any returned ISBN's check digit before trusting it — a
// misread becomes "couldn't read it", never the wrong book.
//
// v198: switched from OpenAI to Gemini — Kevin's Gemini key was already set
// up for trope inference, so this reuses it. Same OpenAI-compatible wire
// format the trope endpoint already speaks to Gemini
// (generativelanguage.googleapis.com/v1beta/openai).
//
// The key lives server-side: VISION_API_KEY, falling back to the already-
// configured TROPE_KEY_GEMINI (model override: VISION_MODEL, default
// gemini-3.8-flash). The browser never sees the key. v199 added mode
// 'shelf': bulk bookshelf-spine reading, returning title/author candidates
// left-to-right for the client to look up and review (never added silently).
//
// Guards: POST only, JSON body, mode allowlist, image is a capped data URL
// or raw base64 (max ~2.5MB — the client downscales to ~1024px first),
// response_format json_object so the model can't ramble, temperature 0.

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const MAX_IMAGE_CHARS = 3500000; // ~2.6MB base64
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/:+@-]{0,119}$/;

const PROMPT_SINGLE = 'You are reading a photo of a book cover. Return a JSON ' +
  'object with exactly these keys: "isbn" (the printed ISBN digits with no ' +
  'dashes or spaces, or null if no ISBN is printed — pre-1970 books have ' +
  'none), "title" (or null), "author" (or null). The ISBN is usually printed ' +
  'near the barcode on the back cover. Prefer the ISBN when one is visible. ' +
  'Reply with ONLY the JSON object, no other text.';

const PROMPT_SHELF = 'You are reading a photo of a bookshelf. List the books ' +
  'whose spines you can read, in left-to-right order. Return a JSON object ' +
  'with exactly one key, "books": an array (up to 30) of objects with ' +
  '"title", "author", and "confidence" ("high" for clearly legible spines, ' +
  '"medium" for partly legible or guessed letters, "low" for very ' +
  'uncertain). Also include "x0" and "x1": the approximate left and right ' +
  'edges of that book\'s spine as integers from 0 to 1000 (fractions of the ' +
  'image width, so a spine spanning the middle tenth is roughly x0=450, ' +
  'x1=550), and "y0" and "y1": the approximate top and bottom edges of the ' +
  'spine as integers from 0 to 1000 (fractions of the image height). Use null ' +
  'for a title or author you cannot read; skip spines ' +
  'you cannot read at all. Vertical text, foil, and small print are common ' +
  '— transcribe carefully. Reply with ONLY the JSON object, no other text.';

// v258: single close-up spine photo -> tight bounding box. The client uses
// it to pre-fit the manual crop UI so the user doesn't have to hunt for
// the spine edges themselves.
const PROMPT_SPINE = 'You are looking at a close-up photo of one book spine ' +
  '(the photo may also show table, background, or neighboring spines at the ' +
  'edges). Find the single most prominent, centered book spine and return a ' +
  'JSON object with exactly one key, "box": an object with "x0", "y0", "x1", ' +
  '"y1" — the tight bounding box of that spine as integers from 0 to 1000 ' +
  '(fractions of image width/height), hugging the spine edges as closely as ' +
  'possible and excluding background. The spine is the physical book\'s bound ' +
  'edge: its top and bottom are where the BOOK ends — never extend the box ' +
  'upward into screens, monitors, walls, shelves, or other background, nor ' +
  'downward past the book. A glowing screen is never part of a book spine. ' +
  'The spine usually has title text running along its length. If no book spine is visible, return ' +
  '{"box": null}. Reply with ONLY the JSON object, no other text.';

// v253: sanitize a shelf-mode model answer into
// [{title, author, confidence, x0?, x1?, y0?, y1?}]. x0/x1/y0/y1 are the
// spine's extent (0-1000); the client crops the spine photo from them when
// a book is added. Unusable boxes are dropped, never trusted blindly.
function cleanShelfResult(obj) {
  const out = [];
  const arr = obj && Array.isArray(obj.books) ? obj.books : [];
  const s = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
  const clampC = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1000, Math.round(n)));
  };
  for (const b of arr) {
    if (!b || typeof b !== 'object') continue;
    const title = s(b.title), author = s(b.author);
    if (!title && !author) continue; // unreadable — nothing to search
    const conf = b.confidence === 'high' || b.confidence === 'medium' || b.confidence === 'low'
      ? b.confidence : 'low';
    const entry = { title, author, confidence: conf };
    const x0 = clampC(b.x0), x1 = clampC(b.x1);
    if (x0 !== null && x1 !== null && x1 - x0 >= 5) { entry.x0 = x0; entry.x1 = x1; }
    const y0 = clampC(b.y0), y1 = clampC(b.y1);
    if (y0 !== null && y1 !== null && y1 - y0 >= 20) { entry.y0 = y0; entry.y1 = y1; }
    out.push(entry);
    if (out.length >= MAX_SHELF_SPINES) break;
  }
  return { books: out };
}

// v258: sanitize a spine-mode answer into {box: {x0,y0,x1,y1} | null}.
function cleanSpineResult(obj) {
  const b = obj && obj.box;
  if (!b || typeof b !== 'object') return { box: null };
  const c = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1000, Math.round(n))) : null;
  };
  const x0 = c(b.x0), y0 = c(b.y0), x1 = c(b.x1), y1 = c(b.y1);
  if (x0 === null || y0 === null || x1 === null || y1 === null) return { box: null };
  if (x1 - x0 < 5 || y1 - y0 < 20) return { box: null };
  return { box: { x0, y0, x1, y1 } };
}

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

// v199: bulk bookshelf spine scanning. mode 'shelf' reads the spines left
// to right and returns readable title/author candidates; the client looks
// each one up in the catalog and shows a review list — nothing is added
// silently.
const MAX_SHELF_SPINES = 30;

// v198: strip markdown fences in case the model wraps the JSON anyway.
function parseModelJsonRaw(text) {
  const t = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(t);
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  // v225 (security): quota-spending endpoint — signed-in callers only.
  const user = await authedUser(request, env);
  if (!user) return unauthorized();
  if (user.banned) return forbiddenBanned(); // v246: suspended accounts
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
  if (mode !== 'single' && mode !== 'shelf' && mode !== 'spine') return new Response('bad request', { status: 400 });
  let image = body && body.image;
  if (typeof image !== 'string' || !image.length || image.length > MAX_IMAGE_CHARS) {
    return new Response('bad request', { status: 400 });
  }
  // Accept a data URL or raw base64; normalize to a data URL for the model.
  if (!image.startsWith('data:')) image = 'data:image/jpeg;base64,' + image;
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
    return new Response('bad request', { status: 400 });
  }

  // v198: Kevin's Gemini key is already configured for trope inference, so
  // reuse it — VISION_API_KEY is only needed for a separate key.
  const key = (env.VISION_API_KEY || '').trim() || (env.TROPE_KEY_GEMINI || '').trim();
  if (!key) {
    return jsonErr(503, "cover reading isn't set up on this server (set VISION_API_KEY or TROPE_KEY_GEMINI)");
  }
  const model = (env.VISION_MODEL || 'gemini-3.8-flash').trim();
  if (!MODEL_RE.test(model)) return jsonErr(503, 'bad VISION_MODEL');

  const isShelf = mode === 'shelf';
  const isSpine = mode === 'spine';
  const prompt = isShelf ? PROMPT_SHELF : isSpine ? PROMPT_SPINE : PROMPT_SINGLE;
  let upstream;
  try {
    upstream = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'User-Agent': 'CozyLibram/1.0 read-cover',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: isShelf ? 2000 : 300,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: image } },
          ],
        }],
      }),
    });
  } catch (e) {
    return jsonErr(502, 'vision provider unreachable');
  }
  if (!upstream.ok) {
    const status = upstream.status;
    // v203: an upstream 503 (model overloaded/unavailable) must NOT be
    // forwarded as-is — the client reads OUR 503 as "no API key configured",
    // which misled real users when Google's model 503'd with a valid key.
    // Surface it as a 502 (bad gateway) with a clear body instead, so a 503
    // from this endpoint unambiguously means "not set up".
    if (status === 503) return jsonErr(502, 'vision model temporarily unavailable (upstream 503)');
    // Forward other upstream statuses so the client's 401/403/429 handling works.
    // Never leak the key: the body is the provider's, which contains no secret.
    return new Response(await upstream.text(), { status });
  }
  let parsed;
  try {
    const content = parseModelJsonRaw((await upstream.json()).choices[0].message.content);
    parsed = isShelf ? cleanShelfResult(content) : isSpine ? cleanSpineResult(content) : cleanResult(content);
  } catch (e) {
    return jsonErr(502, 'vision provider returned an unreadable answer');
  }
  return new Response(JSON.stringify(parsed),
    { headers: { 'Content-Type': 'application/json' } });
}
