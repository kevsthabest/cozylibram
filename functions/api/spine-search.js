// v264: admin-only experiment — can Gemini (with web-search grounding) find
// a book's SPINE photo on the web? Offered in the Observatory's Spine Lab
// tab. If spine images turn out to be retrievable by search, they could one
// day supplement (not replace) the photograph-the-spine flow.
//
// POST { title, author? } -> { candidates: [{ image_url, page_url, note }],
//                              sources: [{ uri, title }] }
import { authedUser, unauthorized, forbiddenBanned } from '../_lib/require-user.js';
import { rateLimit } from '../_lib/rate-limit.js';
import { geminiFetch } from '../_lib/gemini.js';

const json = (status, obj) => new Response(JSON.stringify(obj),
  { status, headers: { 'Content-Type': 'application/json' } });

const MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/i;
const IMG_RE = /^https?:\/\/[^\s"'<>]+?\.(jpg|jpeg|png|webp)(\?[^\s"'<>]*)?$/i;

// Keep only sane-looking http(s) image URLs, cap the list.
export function cleanSpineSearchCandidates(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach(c => {
    if (out.length >= 5) return;
    const url = c && typeof c.image_url === 'string' ? c.image_url.trim() : '';
    if (!url || !IMG_RE.test(url) || seen.has(url.toLowerCase())) return;
    seen.add(url.toLowerCase());
    out.push({
      image_url: url.slice(0, 500),
      page_url: (c.page_url && String(c.page_url).startsWith('http')) ? String(c.page_url).slice(0, 500) : null,
      note: (c.note && String(c.note).trim() || '').slice(0, 200),
    });
  });
  return out;
}

// Grounding sources from a generateContent response (fallback page list).
export function spineSearchSources(data) {
  const out = [];
  try {
    const chunks = (((data.candidates || [])[0] || {}).groundingMetadata || {}).groundingChunks || [];
    chunks.forEach(ch => {
      const web = ch && ch.web;
      if (web && web.uri && web.uri.startsWith('http')) {
        out.push({ uri: String(web.uri).slice(0, 500), title: String(web.title || '').slice(0, 200) });
      }
    });
  } catch (e) {}
  return out.slice(0, 8);
}

// Last-resort: pull bare image URLs out of free text when JSON parsing fails.
export function spineSearchUrlsFromText(text) {
  const out = [];
  const re = /https?:\/\/[^\s"'<>]+?\.(jpg|jpeg|png|webp)(\?[^\s"'<>]*)?/gi;
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < 5) {
    const u = m[0];
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

const PROMPT = (title, author) =>
  'You are helping test whether book spine photos can be found through web search. ' +
  'Find a web page for the book "' + title + '"' + (author ? ' by ' + author : '') +
  ' that shows the book\'s SPINE — the narrow bound edge of the physical book, ' +
  'not the front cover. Good sources: bookseller or publisher product photos ' +
  'showing the spine, "3D book" mockup images, or library catalog photos. ' +
  'Return a JSON object with exactly one key, "candidates": an array of up to 5 ' +
  'objects, each with "image_url" (a direct https URL to a jpg/png/webp image ' +
  'that depicts the spine), "page_url" (the page where you found it), and "note" ' +
  '(one short line describing what the image shows, e.g. "spine clearly visible ' +
  'in 3D mockup"). Prefer images where the spine fills most of the frame. ' +
  'If you cannot find any image clearly showing the spine, return {"candidates": []}. ' +
  'Never invent URLs — only return image URLs you actually found through search.';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  const rl = rateLimit(request, 'spine-search', 10, 60000);
  if (rl) return rl;
  const caller = await authedUser(request, env);
  if (!caller) return unauthorized();
  if (caller.banned) return forbiddenBanned();
  const supaUrl = String((env && env.SUPABASE_URL) || '').replace(/\/+$/, '');
  const svcKey = (env && env.SUPABASE_SERVICE_KEY) || '';
  if (!supaUrl || !svcKey) return json(500, { error: 'server misconfigured' });
  const svcHeaders = { apikey: svcKey, Authorization: 'Bearer ' + svcKey, 'Content-Type': 'application/json' };
  const adm = await fetch(supaUrl + '/rest/v1/app_admins?user_id=eq.' + encodeURIComponent(caller.id) + '&select=user_id',
    { headers: svcHeaders });
  if (!adm.ok) return json(500, { error: 'admin check failed' });
  if (!(await adm.json().catch(() => [])).length) return json(403, { error: 'admin only' });

  const body = await request.json().catch(() => null);
  const title = String((body && body.title) || '').trim().slice(0, 200);
  const author = String((body && body.author) || '').trim().slice(0, 200);
  if (!title) return json(400, { error: 'title is required' });

  const key = (env.VISION_API_KEY || '').trim() || (env.TROPE_KEY_GEMINI || '').trim();
  if (!key) return json(503, { error: "cover reading isn't set up on this server" });
  const model = (env.VISION_MODEL || 'gemini-3.8-flash').trim();
  if (!MODEL_RE.test(model)) return json(503, { error: 'bad VISION_MODEL' });

  // v265: retry on 429/503 — Google rate-limits briefly-exhausted quotas.
  const g = await geminiFetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      tools: [{ google_search: {} }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 1500 },
      contents: [{ role: 'user', parts: [{ text: PROMPT(title, author) }] }],
    }),
  });
  if (!g.ok) {
    if (g.networkError) return json(502, { error: 'vision provider unreachable' });
    if (g.status === 429) return json(502, { error: 'Gemini is rate-limiting this key right now — wait a minute and try again' });
    return json(502, { error: 'vision provider error (upstream ' + g.status + ')' });
  }
  const upstream = g.res;
  let data;
  try { data = await upstream.json(); }
  catch (e) { return json(502, { error: 'vision provider returned an unreadable answer' }); }
  const text = (((data.candidates || [])[0] || {}).content || {}).parts
    .filter(p => p && typeof p.text === 'string').map(p => p.text).join('');
  let candidates = [];
  try {
    candidates = cleanSpineSearchCandidates(JSON.parse(text).candidates);
  } catch (e) {
    candidates = spineSearchUrlsFromText(text).map(image_url => ({ image_url, page_url: null, note: 'scraped from answer text' }));
  }
  return json(200, { candidates, sources: spineSearchSources(data) });
}
