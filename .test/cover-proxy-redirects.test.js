// Cover-proxy redirect re-validation (issue #344).
//
// The proxy's header promises "a non-listed host can never be fetched",
// but the pre-fix fetch used the platform's default redirect handling:
// the initial URL's host was checked once and every redirect hop was
// followed unchecked — the demonstrated Open Library chain fetched two
// unlisted hosts (archive.org/download, then an ia*.us.archive.org
// storage host) to serve an everyday cover.
//
// The decision of record (the User, 2026-10-18, Option B): the proxy
// follows redirects MANUALLY with bounded hops and re-validates EVERY
// hop — a hop target is admitted only if its host is an exact match in
// COVER_PROXY_HOSTS or a subdomain of archive.org (archive.org itself is
// already an exact entry; its per-item storage hosts cannot be
// enumerated in an exact list). All other hosts stay exact-match only.
//
// The fetch stub below emulates the platform: called WITHOUT
// redirect:'manual' it follows redirects internally (what the pre-fix
// code relied on); called WITH redirect:'manual' it returns the raw 3xx
// response. That makes the pre-fix tree fail these pins for the real
// reason — it never sees the hops it is supposed to be validating.
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);

const OL_CHAIN_START = 'https://covers.openlibrary.org/b/id/123-M.jpg';
const AR_DOWNLOAD = 'https://archive.org/download/item123/cover.jpg';
const IA_FINAL = 'https://ia801409.us.archive.org/12/items/item123/cover.jpg';
const EVIL_START = 'https://covers.openlibrary.org/b/id/666-M.jpg';
const EVIL_FINAL = 'https://evil.example/steal.jpg';
const LOOP_URL = 'https://covers.openlibrary.org/b/id/loop-M.jpg';
const HTTP_START = 'https://covers.openlibrary.org/b/id/http-M.jpg';
const HTTP_TARGET = 'http://archive.org/download/item123/cover.jpg';
const LOOKALIKE_START = 'https://covers.openlibrary.org/b/id/look-M.jpg';
const LOOKALIKE_TARGET = 'https://archive.org.evil.com/cover.jpg';
const SUFFIX_START = 'https://covers.openlibrary.org/b/id/sfx-M.jpg';
const SUFFIX_TARGET = 'https://evilarchive.org/cover.jpg';
const REL_START = 'https://covers.openlibrary.org/b/id/rel-M.jpg';
const REL_FINAL = 'https://covers.openlibrary.org/b/id/rel-L.jpg';

const redirectTo = (location) => () =>
  new Response(null, { status: 302, headers: { Location: location } });
const imageOk = () => () =>
  new Response(new Uint8Array(JPEG), { headers: { 'Content-Type': 'image/jpeg' } });

const ROUTES = {
  [OL_CHAIN_START]: redirectTo(AR_DOWNLOAD),
  [AR_DOWNLOAD]: redirectTo(IA_FINAL),
  [IA_FINAL]: imageOk(),
  [EVIL_START]: redirectTo(EVIL_FINAL),
  [EVIL_FINAL]: imageOk(),
  [LOOP_URL]: redirectTo(LOOP_URL),
  [HTTP_START]: redirectTo(HTTP_TARGET),
  [HTTP_TARGET]: imageOk(),
  [LOOKALIKE_START]: redirectTo(LOOKALIKE_TARGET),
  [LOOKALIKE_TARGET]: imageOk(),
  [SUFFIX_START]: redirectTo(SUFFIX_TARGET),
  [SUFFIX_TARGET]: imageOk(),
  [REL_START]: redirectTo('/b/id/rel-L.jpg'),
  [REL_FINAL]: imageOk(),
};

// A fetch that behaves like the platform's. Records every invocation the
// caller actually makes; internal (auto-mode) hops are the stub's own
// business and are NOT recorded — that asymmetry is what proves whether
// the proxy itself is doing the following and the validating.
function platformFetch(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), redirect: init && init.redirect });
    const route = ROUTES[String(url)];
    if (init && init.redirect === 'manual') {
      if (!route) throw new Error('network down');
      return route();
    }
    let current = String(url);
    for (let i = 0; i < 20; i++) {
      const r = ROUTES[current];
      if (!r) throw new Error('network down');
      const res = r();
      const loc = res.headers.get('Location');
      if (REDIRECT_STATUSES.has(res.status) && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      return res;
    }
    throw new TypeError('maximum redirects followed');
  };
}

async function main() {
  const proxyFn = await import(path.resolve(__dirname, '../functions/cover-proxy.js'));
  const realFetch = globalThis.fetch;
  const prox = (u) => proxyFn.onRequest({
    request: new Request('https://app.test/cover-proxy?url=' + encodeURIComponent(u)),
  });
  const run = async (u) => {
    const calls = [];
    globalThis.fetch = platformFetch(calls);
    try {
      return { res: await prox(u), calls };
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  // (a) A redirect chain landing on a non-allowlisted host is refused,
  // and the unlisted host is never fetched.
  {
    const { res, calls } = await run(EVIL_START);
    ok('redirects: chain to a non-allowlisted host is refused (403)', res.status === 403);
    ok('redirects: refusal carries the host-not-allowed reason', (await res.text()) === 'host not allowed');
    ok('redirects: the unlisted hop target is never fetched',
      !calls.some((c) => c.url === EVIL_FINAL));
    ok('redirects: the proxy asked for manual redirect handling',
      calls.length > 0 && calls.every((c) => c.redirect === 'manual'));
  }

  // (b) The demonstrated Open Library chain succeeds: allowlisted entry,
  // exact-listed archive.org hop, then an ia*.us.archive.org storage
  // host admitted by the archive.org suffix rule.
  {
    const { res, calls } = await run(OL_CHAIN_START);
    ok('redirects: Open Library chain succeeds (200)', res.status === 200);
    ok('redirects: Open Library chain returns the image type',
      (res.headers.get('Content-Type') || '').startsWith('image/'));
    const bytes = new Uint8Array(await res.arrayBuffer());
    ok('redirects: Open Library chain returns the final hop bytes',
      bytes.length === JPEG.length && bytes.every((b, i) => b === JPEG[i]));
    ok('redirects: chain visited exactly the three expected URLs',
      calls.map((c) => c.url).join(' ') === [OL_CHAIN_START, AR_DOWNLOAD, IA_FINAL].join(' '));
    ok('redirects: every hop was fetched with manual handling',
      calls.every((c) => c.redirect === 'manual'));
  }

  // (c) Hop-count bounding: a self-redirecting URL is refused by the
  // proxy's own bound (1 initial fetch + 5 follows), not by the
  // platform's internal redirect cap.
  {
    const { res, calls } = await run(LOOP_URL);
    ok('redirects: over-long chain is refused (502)', res.status === 502);
    ok('redirects: refusal names the redirect bound', (await res.text()) === 'too many redirects');
    ok('redirects: fetching stopped at the proxy bound (6 calls)', calls.length === 6);
  }

  // A hop that downgrades to http is refused — protocol is part of
  // per-hop validation, not just the host.
  {
    const { res, calls } = await run(HTTP_START);
    ok('redirects: hop downgrading to http is refused (403)', res.status === 403);
    ok('redirects: the http target is never fetched',
      !calls.some((c) => c.url === HTTP_TARGET));
  }

  // Suffix lookalikes stay refused: the archive.org admit is a dot-
  // bounded suffix, not a substring.
  {
    const { res, calls } = await run(LOOKALIKE_START);
    ok('redirects: archive.org.evil.com hop is refused (403)', res.status === 403);
    ok('redirects: the lookalike target is never fetched',
      !calls.some((c) => c.url === LOOKALIKE_TARGET));
  }
  {
    const { res, calls } = await run(SUFFIX_START);
    ok('redirects: evilarchive.org hop is refused (403)', res.status === 403);
    ok('redirects: the suffix-lookalike target is never fetched',
      !calls.some((c) => c.url === SUFFIX_TARGET));
  }

  // A relative Location resolves against the current URL and is
  // validated like any other hop.
  {
    const { res, calls } = await run(REL_START);
    ok('redirects: relative Location on an allowed host succeeds (200)', res.status === 200);
    ok('redirects: relative Location resolved against the current URL',
      calls.map((c) => c.url).join(' ') === [REL_START, REL_FINAL].join(' '));
  }

  // Hop zero uses the same admission predicate: an ia*.us.archive.org
  // URL handed straight to the proxy is admitted (these are stable
  // final URLs for archive-hosted covers), while its lookalikes are not
  // (pinned by the entry checks in pages-functions plus the hop cases
  // above).
  {
    const { res, calls } = await run(IA_FINAL);
    ok('redirects: ia*.us.archive.org entry URL is admitted (200)', res.status === 200);
    ok('redirects: entry URL fetched exactly once, manually',
      calls.length === 1 && calls[0].redirect === 'manual');
  }

  console.log('TOTAL pass=' + pass + ' fail=' + fail);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
