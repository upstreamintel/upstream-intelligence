// api/summarize.js
// Fetches a URL, strips HTML, calls Anthropic Claude API, returns summary.
// When url=inline, skips page fetch and sends prompt directly (used by framing analysis).
// Env var required: ANTHROPIC_API_KEY

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url, prompt } = req.query;
  if (!url || !prompt) {
    return res.status(400).json({ error: 'Missing url or prompt parameter' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  let userMessage = '';

  if (url === 'inline') {
    // ── Inline mode: prompt already contains all content (framing analysis) ──
    userMessage = decodeURIComponent(prompt);
  } else {
    // ── URL mode: fetch and strip the target page, then combine with prompt ──
    let pageText = '';
    try {
      const pageRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; UpstreamIntelligence/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
      const html = await pageRes.text();

      pageText = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 12000);
    } catch (err) {
      return res.status(502).json({ error: `Failed to fetch page: ${err.message}` });
    }

    if (!pageText || pageText.length < 100) {
      return res.status(502).json({ error: 'Page returned insufficient content' });
    }

    userMessage = `${decodeURIComponent(prompt)}\n\nPage content:\n${pageText}`;
  }

  // ── Call Anthropic API ──
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [
          { role: 'user', content: userMessage },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      return res.status(502).json({ error: `Anthropic API error: ${anthropicRes.status}`, detail: errBody });
    }

    const data = await anthropicRes.json();
    const summary = data?.content?.[0]?.text || '';
    if (!summary) return res.status(502).json({ error: 'Empty response from Claude' });

    return res.status(200).json({ summary });
  } catch (err) {
    return res.status(502).json({ error: `Claude API call failed: ${err.message}` });
  }
}
