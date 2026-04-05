/**
 * /api/rigcount.js — Weekly Rig Count via EIA API
 * Uses EIA_API_KEY (already configured in Vercel env vars)
 * Series: RIG_TOTUS_1 (US Total), RIG_TOTPB_1 (Permian), RIG_TOTEF_1 (Eagle Ford)
 */

const EIA_BASE = 'https://api.eia.gov/v2';

async function fetchSeries(seriesId, apiKey, periods = 2) {
  const url = `${EIA_BASE}/seriesid/${seriesId}?api_key=${apiKey}&length=${periods}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`EIA HTTP ${res.status} for ${seriesId}`);
  const j = await res.json();
  const data = j.response?.data;
  if (!data?.length) throw new Error(`No data for ${seriesId}`);
  return data; // newest first
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).setHeader('Access-Control-Allow-Origin', '*').end();
  }

  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'EIA_API_KEY not configured' });
  }

  try {
    const [usData, permianData, efData] = await Promise.allSettled([
      fetchSeries('RIG_TOTUS_1', apiKey, 2),
      fetchSeries('RIG_TOTPB_1', apiKey, 2),
      fetchSeries('RIG_TOTEF_1', apiKey, 2),
    ]);

    const us      = usData.status      === 'fulfilled' ? usData.value      : null;
    const permian = permianData.status === 'fulfilled' ? permianData.value : null;
    const ef      = efData.status      === 'fulfilled' ? efData.value      : null;

    const weekEnding = us?.[0]?.period ?? null;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json({
      week_ending:       weekEnding,
      us_total:          us      ? parseInt(us[0].value)      : null,
      permian:           permian ? parseInt(permian[0].value) : null,
      eagle_ford:        ef      ? parseInt(ef[0].value)      : null,
      us_total_change:   us      && us[1]      ? parseInt(us[0].value)      - parseInt(us[1].value)      : null,
      permian_change:    permian && permian[1] ? parseInt(permian[0].value) - parseInt(permian[1].value) : null,
      eagle_ford_change: ef      && ef[1]      ? parseInt(ef[0].value)      - parseInt(ef[1].value)      : null,
    });

  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: err.message });
  }
}
