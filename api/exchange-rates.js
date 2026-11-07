const SOURCE_URL = 'https://exrye.com/aden';
const CURRENCIES = Object.freeze(['AED', 'BHD', 'EUR', 'KWD', 'OMR', 'SAR', 'USD', 'YER']);

function json(res, status, body) {
  return res
    .status(status)
    .setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=1800')
    .json(body);
}

function textFromHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function numericCell(cell) {
  const text = textFromHtml(cell).replace(/[٬،]/g, ',').replace(/,/g, '');
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseRatesFromHtml(html) {
  const rates = {};
  const rows = String(html).match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const rowText = textFromHtml(row);
    const codeMatch = rowText.match(/\b(AED|BHD|EUR|KWD|OMR|SAR|USD|YER)\b/i);
    if (!codeMatch) continue;

    const code = codeMatch[1].toUpperCase();
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(match => match[1]);
    const values = cells.map(numericCell).filter(value => value !== null);

    if (values.length >= 2) {
      rates[code] = { buy: values[0], sell: values[1] };
    }
  }

  const complete = CURRENCIES.every(code =>
    rates[code] &&
    Number.isFinite(rates[code].buy) &&
    Number.isFinite(rates[code].sell)
  );

  return complete ? rates : null;
}

module.exports = async function exchangeRatesHandler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: 'Method not allowed.' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const upstream = await fetch(SOURCE_URL, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'WALLET-OS/1.0 (+https://github.com/s20020411110-cmd/WALLET_OS)'
      },
      cache: 'no-store',
      signal: controller.signal
    });

    if (!upstream.ok) {
      return json(res, 502, { error: `Exchange source returned HTTP ${upstream.status}.` });
    }

    const html = await upstream.text();
    const rates = parseRatesFromHtml(html);
    if (!rates) {
      return json(res, 502, {
        error: 'Could not read the expected buy/sell rate table from exrye.com/aden.',
        source: SOURCE_URL
      });
    }

    const plainText = textFromHtml(html);
    const updatedMatch = plainText.match(/أخر\s*تحديث\s*[:：]\s*([^|]{1,24})/i);
    return json(res, 200, {
      source: SOURCE_URL,
      sourceUpdatedLabel: updatedMatch ? updatedMatch[1].trim() : 'غير محدد',
      fetchedAt: new Date().toISOString(),
      rates
    });
  } catch (error) {
    return json(res, 502, {
      error: error && error.name === 'AbortError'
        ? 'The exchange source timed out.'
        : 'Unable to reach exrye.com/aden.'
    });
  } finally {
    clearTimeout(timer);
  }
};

module.exports.parseRatesFromHtml = parseRatesFromHtml;
