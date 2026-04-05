/**
 * /api/rigcount.js — Baker Hughes North America Rig Count proxy
 * Node.js runtime (not Edge) for longer timeout tolerance
 */

const BH_CSV_URL = 'https://rigcount.bakerhughes.com/static-files/north-america-rotary-rig-count-current?format=csv';

function parseCSV(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.map(line => {
    const cols = [];
    let cur = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { cols.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur.trim());
    return cols;
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(204).setHeader('Access-Control-Allow-Origin', '*').end();
  }

  try {
    const response = await fetch(BH_CSV_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; UpstreamIntelligence/2.0)',
        'Accept': 'text/csv, */*',
      },
      signal: AbortSignal.timeout(25000), // 25s — generous for BH's slow CDN
    });

    if (!response.ok) throw new Error(`BH CSV HTTP ${response.status}`);
    const text = await response.text();
    const rows = parseCSV(text);

    let weekEnding = null;
    let usTotal = null, usPrior = null;
    let permian = null, permianPrior = null;
    let eagleFord = null, eagleFordPrior = null;

    for (const row of rows) {
      const first = row[0] || '';

      if (!weekEnding && /week\s+ending|w\/e/i.test(first)) {
        for (const col of row) {
          const d = new Date(col);
          if (!isNaN(d.getTime()) && d.getFullYear() > 2020) {
            weekEnding = d.toISOString().split('T')[0];
            break;
          }
        }
      }

      const count = parseInt(row[1]);
      const prior = parseInt(row[2]);
      if (isNaN(count)) continue;

      if (/^u\.?s\.?\s*(total)?$/i.test(first.trim())) {
        usTotal = count; usPrior = isNaN(prior) ? null : prior;
      } else if (/permian/i.test(first)) {
        permian = count; permianPrior = isNaN(prior) ? null : prior;
      } else if (/eagle\s*ford/i.test(first)) {
        eagleFord = count; eagleFordPrior = isNaN(prior) ? null : prior;
      }
    }

    if (usTotal === null) throw new Error('Could not parse rig count — BH format may have changed');

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json({
      week_ending:       weekEnding,
      us_total:          usTotal,
      permian:           permian,
      eagle_ford:        eagleFord,
      us_total_change:   usPrior !== null ? usTotal - usPrior : null,
      permian_change:    permianPrior !== null ? permian - permianPrior : null,
      eagle_ford_change: eagleFordPrior !== null ? eagleFord - eagleFordPrior : null,
    });

  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(502).json({ error: err.message });
  }
}
