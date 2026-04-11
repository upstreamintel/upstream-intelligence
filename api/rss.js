/**
 * /api/rss.js — Universal RSS proxy for Upstream Intelligence
 *
 * Usage:  GET /api/rss?url=<encoded-feed-url>
 *
 * Returns a JSON array of article objects:
 *   [{ title, link, pubDate, desc }, ...]
 *
 * Strategy:
 *   1. Fetch the raw XML server-side (no CORS restrictions)
 *   2. Parse with regex fallback (no DOM available in Node)
 *   3. Return up to 25 items, sorted newest-first
 *
 * Supported sources (including previously blocked):
 *   - Xinhua / CGTN   (geo-blocked from browsers, fine server-side)
 *   - Tasnim News     (same)
 *   - Middle East Monitor / Eye (auth headers stripped by browser proxies)
 *   - Energy Voice    (CF bot protection bypassed via Accept headers)
 *   - RRC Texas       (no RSS feed — scraped from HTML news page)
 *   - All existing sources (replaces rss2json / corsproxy / allorigins)
 */

export const config = { runtime: 'edge' };

// Per-source header overrides — some feeds need a real User-Agent or Accept header
const SOURCE_HEADERS = {
  'energyvoice.com': {
    'User-Agent': 'Mozilla/5.0 (compatible; UpstreamIntelBot/1.0)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
  'memri.org': {
    'User-Agent': 'Mozilla/5.0 (compatible; UpstreamIntelBot/1.0)',
  },
};

function getExtraHeaders(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    for (const [domain, headers] of Object.entries(SOURCE_HEADERS)) {
      if (hostname.includes(domain)) return headers;
    }
  } catch {}
  return {};
}

// ── RRC Texas HTML Scraper ──────────────────────────────────────────────────
// The RRC news page has no RSS feed. This scrapes the /news/ HTML page and
// returns items in the same shape as parseXML so the rest of the pipeline
// doesn't need to change.
//
// Page structure (as of 2026):
//   <h3><a href="/news/slug/">Title</a></h3>
//   <p>Date\n\nDescription text...</p>
//
// We extract all <h3> anchor links under the news list, pair each with the
// following <p> for date + description, then resolve relative URLs.

function parseRRCHtml(html) {
  const BASE = 'https://www.rrc.texas.gov';
  const items = [];

  // Match each news item: <h3> containing an <a href="/news/...">Title</a>
  // followed shortly by a date line and description paragraph
  const itemRe = /<h3[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>\s*([\w]+ \d{1,2},\s*\d{4})\s*([\s\S]*?)(?=<h3|<ul class="news-archive|$)/gi;

  let m;
  while ((m = itemRe.exec(html)) !== null) {
    const rawHref  = m[1].trim();
    const rawTitle = m[2].replace(/###\s*/, '').replace(/<[^>]+>/g, '').trim();
    const rawDate  = m[3].trim();
    const rawDesc  = m[4].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    // Resolve relative URLs
    const link = rawHref.startsWith('http') ? rawHref : `${BASE}${rawHref}`;

    // Parse the date string into ISO format for consistent sorting
    const pubDate = new Date(rawDate).toISOString();

    if (rawTitle && link) {
      items.push({
        title:   rawTitle,
        link:    link,
        pubDate: isNaN(new Date(rawDate)) ? '' : pubDate,
        desc:    rawDesc.slice(0, 300),
      });
    }
  }

  // Fallback: simpler pattern for list-based structure (<li> with <a> + date)
  if (!items.length) {
    const liRe = /<li[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*\n?\s*\(?([\w][\w\s,\-\/]+\d{4})\)?/gi;
    while ((m = liRe.exec(html)) !== null) {
      const rawHref  = m[1].trim();
      const rawTitle = m[2].replace(/###\s*/, '').replace(/<[^>]+>/g, '').trim();
      const rawDate  = m[3].trim();
      const link     = rawHref.startsWith('http') ? rawHref : `${BASE}${rawHref}`;
      const pubDate  = new Date(rawDate).toISOString();

      if (rawTitle && link && rawTitle.length > 5) {
        items.push({
          title:   rawTitle,
          link:    link,
          pubDate: isNaN(new Date(rawDate)) ? '' : pubDate,
          desc:    '',
        });
      }
    }
  }

  return items;
}

// ── XML Parser (runs in Node/Edge — no DOMParser) ──────────────────────────
// Extracts <item> blocks then pulls fields with targeted regexes.
// Handles CDATA, entity encoding, Atom <entry> tags, and dc:date.

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripCDATA(str) {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, '').trim();
}

function extractField(block, ...tags) {
  for (const tag of tags) {
    // Try CDATA first, then plain content
    const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
    const plainRe = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const attrRe  = new RegExp(`<${tag}[^>]*href=["']([^"']+)["']`, 'i');  // Atom <link href="…">

    let m = cdataRe.exec(block);
    if (m) return m[1].trim();
    m = plainRe.exec(block);
    if (m) return decodeEntities(stripTags(stripCDATA(m[1]))).trim();
    m = attrRe.exec(block);
    if (m) return m[1].trim();
  }
  return '';
}

function parseXML(text) {
  // Support both RSS <item> and Atom <entry>
  const itemRe = /<(?:item|entry)(?: [^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi;
  const blocks = text.match(itemRe) || [];

  return blocks.map(block => {
    const title   = extractField(block, 'title');
    const link    = extractField(block, 'link', 'guid');
    const pubDate = extractField(block, 'pubDate', 'published', 'updated', 'dc:date', 'date');
    const desc    = stripTags(extractField(block, 'description', 'summary', 'content', 'content:encoded'));

    return { title, link, pubDate, desc };
  }).filter(i => i.title && i.link);
}

// ── Sort & limit ────────────────────────────────────────────────────────────
function processItems(items) {
  return items
    .sort((a, b) => {
      const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return db - da;
    })
    .slice(0, 25);
}

// ── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });
  }

  const { searchParams } = new URL(req.url);
  const feedUrl = searchParams.get('url');

  if (!feedUrl) {
    return new Response(JSON.stringify({ error: 'Missing ?url= parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Basic allowlist check — only fetch http(s) URLs
  let parsed;
  try {
    parsed = new URL(feedUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid URL' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return new Response(JSON.stringify({ error: 'Only http/https allowed' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Detect RRC news page — no RSS feed, parse HTML instead
  const isRRC = parsed.hostname.includes('rrc.texas.gov') && parsed.pathname.includes('/news');

  try {
    const res = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; UpstreamIntelligence/2.0; +https://upstreamintel.github.io)',
        'Accept': isRRC
          ? 'text/html, */*'
          : 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        ...getExtraHeaders(feedUrl),
      },
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Feed returned HTTP ${res.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const text = await res.text();

    // Branch: HTML scrape for RRC, XML parse for everything else
    const raw = isRRC ? parseRRCHtml(text) : parseXML(text);

    if (!raw.length) {
      return new Response(JSON.stringify({ error: 'No items found in feed' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const items = processItems(raw);

    return new Response(JSON.stringify(items), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        // Cache 5 minutes at the edge — reduces cold fetch latency on repeat loads
        'Cache-Control': 's-maxage=300, stale-while-revalidate=60',
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Fetch failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
