/**
 * /api/prices.js — WTI, Brent & Henry Hub natural gas price proxy
 *
 * Returns:
 *   {
 *     wti:    { price, change, pct, updated },
 *     brent:  { price, change, pct, updated },
 *     natgas: { price, change, pct, updated }
 *   }
 *
 * WTI + Brent: oilpriceapi.com (requires OIL_PRICE_API_KEY env var)
 * Nat Gas:     Yahoo Finance NG=F front-month futures (no key required)
 */
export const config = { runtime: 'edge' };
const BASE = 'https://api.oilpriceapi.com/v1';

async function fetchOilPrice(code, apiKey) {
  // Fetch latest spot price
  const res = await fetch(`${BASE}/prices/latest?by_code=${code}`, {
    headers: { 'Authorization': `Token ${apiKey}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`oilpriceapi HTTP ${res.status} for ${code}`);
  const j = await res.json();
  const d = j.data;
  if (!d) throw new Error(`No data for ${code}`);
  const price = parseFloat(d.price);

  // Fetch last 2 daily averages to compute day-over-day change
  let change = 0, pct = 0;
  try {
    const res2 = await fetch(`${BASE}/prices?by_code=${code}&by_type=daily_average_price&limit=2`, {
      headers: { 'Authorization': `Token ${apiKey}`, 'Content-Type': 'application/json' },
    });
    if (res2.ok) {
      const j2 = await res2.json();
      const entries = j2?.data?.prices;
      if (entries && entries.length >= 2) {
        const today = parseFloat(entries[0].price);
        const prev  = parseFloat(entries[1].price);
        change = parseFloat((today - prev).toFixed(2));
        pct    = parseFloat(((change / prev) * 100).toFixed(2));
      }
    }
  } catch(_) { /* leave change/pct as 0 if history fetch fails */ }

  return {
    price,
    change,
    pct,
    updated: d.created_at || new Date().toISOString(),
  };
}

async function fetchNatGas() {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/NG=F?interval=1d&range=5d';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);
  const j = await res.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error('Yahoo: no meta');
  const price  = meta.regularMarketPrice;
  const prev   = meta.chartPreviousClose;
  const change = parseFloat((price - prev).toFixed(3));
  const pct    = parseFloat(((change / prev) * 100).toFixed(2));
  return {
    price,
    change,
    pct,
    updated: new Date().toISOString(),
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  const apiKey = process.env.OIL_PRICE_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OIL_PRICE_API_KEY not configured' }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
  try {
    const [wti, brent, natgas] = await Promise.allSettled([
      fetchOilPrice('WTI_USD', apiKey),
      fetchOilPrice('BRENT_CRUDE_USD', apiKey),
      fetchNatGas(),
    ]);
    const result = {
      wti:    wti.status    === 'fulfilled' ? wti.value    : null,
      brent:  brent.status  === 'fulfilled' ? brent.value  : null,
      natgas: natgas.status === 'fulfilled' ? natgas.value : null,
    };
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=900, stale-while-revalidate=300',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}
