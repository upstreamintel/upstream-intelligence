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
 * Data source: Yahoo Finance futures (no API key required)
 *   WTI:     CL=F   Brent: BZ=F   Nat Gas: NG=F
 *
 * Previous close strategy:
 *   Use the penultimate valid close from the OHLC array (range=5d, interval=1d).
 *   This is the last completed session's closing price for the current contract,
 *   which is what Yahoo Finance itself uses for the intraday change display.
 *   Meta fields (chartPreviousClose, regularMarketPreviousClose) can reference
 *   prior contracts during futures roll periods and produce inflated deltas.
 */
export const config = { runtime: 'edge' };

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status} for ${symbol}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo: no result for ${symbol}`);

  const meta  = result.meta;
  const price = meta.regularMarketPrice;

  // Use penultimate close from OHLC array — most accurate for current contract.
  // Filter out nulls (partial/missing sessions), take second-to-last valid close.
  let prev = null;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (closes && closes.length >= 2) {
    const valid = closes.filter(v => v != null);
    if (valid.length >= 2) {
      prev = valid[valid.length - 2];
    } else if (valid.length === 1) {
      prev = valid[0];
    }
  }

  // Hard fallback only — these are unreliable during roll periods
  if (!prev) prev = meta.chartPreviousClose || meta.regularMarketPreviousClose;

  const change = prev ? parseFloat((price - prev).toFixed(2)) : 0;
  const pct    = prev ? parseFloat(((change / prev) * 100).toFixed(2)) : 0;

  return { price, change, pct, updated: new Date().toISOString() };
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
        'Cache-Control': 's-maxage=60, stale-while-revalidate=120',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
}
