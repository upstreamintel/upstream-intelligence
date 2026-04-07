// api/stocks.js
// Fetches real-time stock quotes from Finnhub for a list of tickers.
// Results are cached for 5 minutes (s-maxage=300) so all concurrent users
// share a single Finnhub call — keeps free tier well within rate limits.

const DEFAULT_TICKERS = ['COP', 'BTE', 'CRGY', 'KO', 'CVX', 'NVDA'];

export default async function handler(req, res) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FINNHUB_API_KEY not configured' });
  }

  // Accept comma-separated tickers from query param, fall back to defaults
  const tickers = req.query.tickers
    ? req.query.tickers.toUpperCase().split(',').map(t => t.trim()).filter(Boolean)
    : DEFAULT_TICKERS;

  try {
    // Fan out to Finnhub in parallel — one /quote call per ticker
    const results = await Promise.all(
      tickers.map(async symbol => {
        try {
          const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${apiKey}`;
          const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const d = await r.json();
          // Finnhub returns c=current, d=change, dp=pct change, pc=prev close
          if (!d || d.c === 0) throw new Error('No data');
          return {
            symbol,
            price:  d.c  ?? null,
            change: d.d  ?? null,
            pct:    d.dp ?? null,
            prev:   d.pc ?? null,
          };
        } catch (e) {
          return { symbol, price: null, change: null, pct: null, prev: null, error: true };
        }
      })
    );

    // Cache for 5 minutes — all users share this response
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({ tickers: results });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
