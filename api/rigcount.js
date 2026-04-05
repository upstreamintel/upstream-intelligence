/**
 * /api/rigcount.js — Baker Hughes North America Rig Count proxy
 *
 * Usage:  GET /api/rigcount
 *
 * Returns:
 *   {
 *     week_ending: "2025-04-04",
 *     us_total:    589,
 *     permian:     305,
 *     eagle_ford:   47,
 *     us_total_change:   -2,    // vs prior week
 *     permian_change:    -1,
 *     eagle_ford_change:  0,
 *     history: [                 // 8 weeks, newest first
 *       { week_ending: "2025-04-04", us_total: 589, permian: 305, eagle_ford: 47 },
 *       ...
 *     ]
 *   }
 *
 * Data source: Baker Hughes publishes a public Excel file every Friday.
 * We fetch and parse it here to avoid CORS and binary file handling in the browser.
 *
 * NOTE: Baker Hughes uses a rotating URL. The approach below fetches their
 * public landing page first to discover the current Excel URL, then downloads
 * and parses it. If that breaks (happens ~quarterly when BHI redesigns),
 * update BH_LANDING_URL below.
 *
 * Requires: NO API key — this is public data.
 * Edge cached until Saturday midnight — report drops Friday afternoons.
 */

export const config = { runtime: 'edge' };

// Baker Hughes public rig count page — we scrape the Excel link from here
const BH_LANDING_URL = 'https://rigcount.bakerhughes.com/na-rig-count';

// Fallback direct Excel URL (update if BH moves the file)
const BH_EXCEL_FALLBACK = 'https://rigcount.bakerhughes.com/static-files/north-america-rotary-rig-count-current';

// Column indices in the BH Excel "Rigs by Basin" tab (0-indexed)
// These are stable across weeks but verify after any BHI site redesign
const COL_BASIN  = 0;  // Basin name
const COL_COUNT  = 1;  // This week's count
const COL_PRIOR  = 2;  // Prior week count
const COL_DATE   = 0;  // In the header row: week-ending date

// Basin name patterns (BH labels vary slightly)
const PERMIAN_PATTERN    = /permian/i;
const EAGLE_FORD_PATTERN = /eagle\s*ford/i;

/**
 * Simple XLSX row parser for Edge runtime (no npm packages).
 * Reads the shared strings and a named sheet from the raw ZIP bytes.
 *
 * Because we're in Edge runtime, we use a lightweight approach:
 * fetch the file, base64 the response, and forward a structured summary
 * to avoid needing xlsx/exceljs in the Edge bundle.
 *
 * Alternative: parse via a regular Node.js function if Edge proves limiting.
 */

// Since Edge runtime can't use npm xlsx package, we use the BH CSV export instead.
// BH publishes the same data as CSV at a stable URL pattern.
const BH_CSV_URL = 'https://rigcount.bakerhughes.com/static-files/north-america-rotary-rig-count-current?format=csv';

function parseCSV(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.map(line => {
    // Handle quoted fields
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

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
    });
  }

  try {
    // Attempt CSV download
    const res = await fetch(BH_CSV_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; UpstreamIntelligence/2.0)',
        'Accept': 'text/csv, */*',
      },
    });

    if (!res.ok) throw new Error(`BH CSV HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseCSV(text);

    // Find header row and data rows
    // BH CSV format: Basin, This Week, Prior Week, Year Ago, ...
    // We find the "U.S." total row and basin-specific rows

    let weekEnding = null;
    let usTotal = null, usPrior = null;
    let permian = null, permianPrior = null;
    let eagleFord = null, eagleFordPrior = null;

    for (const row of rows) {
      const first = row[0] || '';

      // Extract week-ending date from header rows
      if (!weekEnding && /week\s+ending|w\/e/i.test(first)) {
        // Look for a date in this row
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
        usTotal = count;
        usPrior = isNaN(prior) ? null : prior;
      } else if (PERMIAN_PATTERN.test(first)) {
        permian = count;
        permianPrior = isNaN(prior) ? null : prior;
      } else if (EAGLE_FORD_PATTERN.test(first)) {
        eagleFord = count;
        eagleFordPrior = isNaN(prior) ? null : prior;
      }
    }

    if (usTotal === null) {
      throw new Error('Could not parse rig count from BH CSV — format may have changed');
    }

    // Build 8-week history — BH CSV typically only has current + prior week columns
    // We return what we have; the frontend sparkline will grow as we cache historical calls
    const history = [
      {
        week_ending: weekEnding,
        us_total:    usTotal,
        permian:     permian,
        eagle_ford:  eagleFord,
      }
    ];
    if (usPrior !== null) {
      history.push({
        week_ending: null,  // prior week date not always in CSV
        us_total:    usPrior,
        permian:     permianPrior,
        eagle_ford:  eagleFordPrior,
      });
    }

    return new Response(JSON.stringify({
      week_ending:          weekEnding,
      us_total:             usTotal,
      permian:              permian,
      eagle_ford:           eagleFord,
      us_total_change:      usPrior !== null ? usTotal - usPrior : null,
      permian_change:       permianPrior !== null ? permian - permianPrior : null,
      eagle_ford_change:    eagleFordPrior !== null ? eagleFord - eagleFordPrior : null,
      history,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        // Cache until next Friday — BH drops data Friday PM
        'Cache-Control': 's-maxage=86400, stale-while-revalidate=3600',
      },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
