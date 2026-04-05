/**
 * /api/prices.js — WTI & Brent crude price proxy
 *
 * Usage:  GET /api/prices
 *
 * Returns:
 *   {
 *     wti:   { price: 72.45, change: -0.83, pct: -1.14, updated: "2025-04-04T15:30:00Z" },
 *     brent: { price: 76.21, change: -0.61, pct: -0.79, updated: "2025-04-04T15:30:00Z" }
 *   }
 *
 * Requires env var:  OIL_PRICE_API_KEY  (from oilpriceapi.com free tier)
 *
 * oilpriceapi.com free tier endpoints used:
 *   /v1/prices/latest   — spot price + 24h change
 *
 * Edge cached for 15 minutes — price doesn't move faster than that for a dashboard.
 */

export const config = { runtime: 'edge' };

const BASE = 'https://api.oilpriceapi.com/v1';

async function fetchPrice(code, apiKey) {
  const res = await fetch(`${BASE}/prices/latest?by_code=${code}`, {
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`oilpriceapi HTTP ${res.status} for ${code}`);
  const j = await res.json();
  const d = j.data;
  if (!d) throw new Error(`No data for ${code}`);

  return {
    price:   parseFloat(d.price),
    change:  parseFloat(d.price_change ?? 0),
    pct:     parseFloat(d.price_change_percent ?? 0),
    updated: d.created_at || new Date().toISOString(),
  };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
    });
  }

  const apiKey = process.env.OIL_PRICE_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OIL_PRICE_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const [wti, brent] = await Promise.all([
      fetchPrice('WTI_USD', apiKey),
      fetchPrice('BRENT_CRUDE_USD', apiKey),
    ]);

    return new Response(JSON.stringify({ wti, brent }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=900, stale-while-revalidate=300',  // 15-min edge cache
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
