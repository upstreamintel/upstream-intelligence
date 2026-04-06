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
 * All three use Yahoo Finance futures (no API key required):
 *   WTI:     CL=F (WTI Crude front-month futures)
 *   Brent:   BZ=F (Brent Crude front-month futures)
 *   Nat Gas: NG=F (Henry Hub Natural Gas front-month futures)
 */
export const config = { runtime: 'edge' };

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status} for ${symbol}`);
  const j = await res.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`Yahoo: no meta for ${symbol}`);
  const price  = meta.regularMarketPrice;
  const prev   = meta.chartPreviousClose;
  const change = parseFloat((price - prev).toFixed(2));
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

  try {
    const [wti, brent, natgas] = await Promise.allSettled([
      fetchYahoo('CL=F'),
      fetchYahoo('BZ=F'),
      fetchYahoo('NG=F'),
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
