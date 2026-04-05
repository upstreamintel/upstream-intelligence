/**
 * /api/eia.js — EIA Weekly Petroleum Status Report proxy
 *
 * Usage:  GET /api/eia
 *
 * Returns:
 *   {
 *     crude_build_draw: -2.1,          // negative = draw (bullish), positive = build (bearish)
 *     unit: "MMbbl",
 *     report_date: "2025-04-02",       // Wednesday release date
 *     published: "2025-04-02T14:30:00Z",
 *     consensus_estimate: -1.5,        // if available (null if not)
 *     total_stocks: 432.1,             // total US crude inventories (MMbbl)
 *     spr: 237.4,                      // Strategic Petroleum Reserve (MMbbl)
 *   }
 *
 * Requires env var:  EIA_API_KEY  (free at eia.gov/opendata)
 *
 * EIA API v2 series used:
 *   PET.WCRSTUS1.W  — Weekly US Crude Oil Stocks (thousand barrels)
 *   PET.WCSSTUS1.W  — Strategic Petroleum Reserve stocks
 *
 * Build/draw is calculated as week-over-week delta of crude stocks.
 * Edge cached 6 hours — report drops Wednesdays at 10:30am ET, no need to poll harder.
 */

export const config = { runtime: 'edge' };

const EIA_BASE = 'https://api.eia.gov/v2';

async function fetchSeries(seriesId, apiKey, periods = 2) {
  const url = `${EIA_BASE}/seriesid/${seriesId}?api_key=${apiKey}&length=${periods}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`EIA API HTTP ${res.status} for ${seriesId}`);
  const j = await res.json();
  // EIA v2 response structure: { response: { data: [ {period, value, ...} ] } }
  const data = j.response?.data;
  if (!data?.length) throw new Error(`No data returned for ${seriesId}`);
  return data; // sorted newest-first by EIA default
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
    });
  }

  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'EIA_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    // Fetch 2 periods so we can compute week-over-week delta
    const [crudeData, sprData] = await Promise.all([
      fetchSeries('PET.WCRSTUS1.W', apiKey, 2),
      fetchSeries('PET.WCSSTUS1.W', apiKey, 1),
    ]);

    const latest  = crudeData[0];
    const prior   = crudeData[1];

    // EIA reports in thousand barrels — convert to MMbbl for display
    const latestKbbl  = parseFloat(latest.value);
    const priorKbbl   = parseFloat(prior.value);
    const deltaKbbl   = latestKbbl - priorKbbl;
    const deltaMmbbl  = parseFloat((deltaKbbl / 1000).toFixed(2));
    const totalMmbbl  = parseFloat((latestKbbl / 1000).toFixed(1));
    const sprMmbbl    = parseFloat((parseFloat(sprData[0].value) / 1000).toFixed(1));

    // Period format from EIA v2 is "YYYY-MM-DD"
    const reportDate = latest.period;

    return new Response(JSON.stringify({
      crude_build_draw:    deltaMmbbl,   // neg = draw, pos = build
      unit:                'MMbbl',
      report_date:         reportDate,
      published:           new Date().toISOString(),  // EIA doesn't return publish timestamp in this endpoint
      consensus_estimate:  null,         // would require a separate consensus data source
      total_stocks:        totalMmbbl,
      spr:                 sprMmbbl,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 's-maxage=21600, stale-while-revalidate=3600',  // 6-hour edge cache
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
