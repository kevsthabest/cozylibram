const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(status, body, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({}, JSON_HEADERS, extra || {}),
  });
}

function cleanIsbn(raw) {
  const s = decodeURIComponent(String(raw || '')).replace(/[^0-9X]/gi, '').toUpperCase();
  return /^(?:\d{10}|\d{13}|\d{9}X)$/.test(s) ? s : null;
}

function publicObjectUrl(base, bucket, path) {
  if (!base || !bucket || !path) return null;
  return String(base).replace(/\/$/, '') + '/storage/v1/object/public/' +
    encodeURIComponent(bucket) + '/' +
    String(path).split('/').map(encodeURIComponent).join('/');
}

async function supabaseGet(env, table, params) {
  const base = String(env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = String(env.SUPABASE_ANON_KEY || '').trim();
  if (!base || !key) throw new Error('Supabase public API is not configured');
  const qs = new URLSearchParams(params || {});
  const res = await fetch(base + '/rest/v1/' + table + '?' + qs.toString(), {
    headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('Supabase returned ' + res.status);
  return res.json();
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (request.method !== 'GET') return json(405, { error: 'method not allowed' });

  const { rateLimit } = await import('../../_lib/rate-limit.js');
  const limited = rateLimit(request, 'public-edition-api', 120, 60 * 1000);
  if (limited) return limited;

  const raw = (request.params && request.params.isbn) ||
    new URL(request.url).pathname.split('/').pop();
  const isbn = cleanIsbn(raw);
  if (!isbn) return json(400, { error: 'invalid ISBN' });

  try {
    const editions = await supabaseGet(env, 'editions', {
      select: 'id,isbn,publisher,format,page_count,publication_date,cover_url,provider_ids,thickness_mm,thickness_source,thickness_confidence,thickness_measured_at,updated_at',
      isbn: 'eq.' + isbn, limit: '1',
    });
    const edition = editions && editions[0];
    if (!edition) return json(404, { error: 'edition not found', isbn });

    const slots = await supabaseGet(env, 'edition_asset_slots', {
      select: 'face,appearance,canonical_asset_id,selection_method,selected_at',
      edition_id: 'eq.' + edition.id, limit: '100',
    });
    const ids = (slots || []).map(s => s.canonical_asset_id).filter(Boolean);
    let assets = [];
    if (ids.length) {
      assets = await supabaseGet(env, 'edition_assets', {
        select: 'id,face,appearance,bucket,path,width,height,format,byte_size,sha256,quality_score,verified,created_at,updated_at',
        id: 'in.(' + ids.join(',') + ')', rejected: 'eq.false', limit: '100',
      });
    }
    const byId = {};
    (assets || []).forEach(a => { byId[a.id] = a; });
    const faces = {};
    (slots || []).forEach(slot => {
      const a = byId[slot.canonical_asset_id];
      if (!a) return;
      faces[slot.appearance + ':' + slot.face] = {
        id: a.id, face: slot.face, appearance: slot.appearance,
        url: publicObjectUrl(env.SUPABASE_URL, a.bucket, a.path),
        width: a.width, height: a.height, format: a.format, byte_size: a.byte_size,
        sha256: a.sha256, quality_score: a.quality_score, verified: !!a.verified,
        selection_method: slot.selection_method, selected_at: slot.selected_at,
      };
    });

    const measurements = await supabaseGet(env, 'edition_measurements', {
      select: 'thickness_mm,confidence,verified,method,created_at',
      edition_id: 'eq.' + edition.id, rejected: 'eq.false',
      order: 'verified.desc,confidence.desc,created_at.asc', limit: '1',
    });

    return json(200, {
      isbn: edition.isbn,
      edition: {
        id: edition.id, publisher: edition.publisher, format: edition.format,
        page_count: edition.page_count, publication_date: edition.publication_date,
        cover_url: edition.cover_url, provider_ids: edition.provider_ids || {},
        dimensions: {
          thickness_mm: edition.thickness_mm || null,
          thickness_source: edition.thickness_source || null,
          thickness_confidence: edition.thickness_confidence || null,
          measured_at: edition.thickness_measured_at || null,
        },
        updated_at: edition.updated_at,
      },
      faces,
      measurement: measurements && measurements[0] ? measurements[0] : null,
    }, { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400' });
  } catch (e) {
    return json(503, { error: 'edition repository unavailable' });
  }
}
