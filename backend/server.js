const http = require('http');
const { createPdf } = require('./pdf');

const DEFAULT_SITE = 'https://tcbonepiecechapters.com/';
const PORT = Number(process.env.PORT || 3001);

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fetchDocument(rawUrl) {
  return fetch(rawUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  }).then((response) => {
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }
    return response.text();
  });
}

function parseLatestChapters(html) {
  const chapterEntries = new Map();
  const chapterRegex = /<a[^>]*href="(\/chapters\/[^\"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(chapterRegex)) {
    const [, href, innerHtml] = match;
    if (!href || !href.includes('/chapters/')) {
      continue;
    }

    const textMatch = />([^<]+)<\/.*?>/i.exec(innerHtml);
    const text = (textMatch ? textMatch[1] : '')
      .replace(/\s+/g, ' ')
      .trim();
    const altMatch = /alt="([^"]+)"/i.exec(innerHtml);
    const title = (text || altMatch?.[1] || '').replace(/\s+/g, ' ').trim();

    if (!title || chapterEntries.has(href)) {
      continue;
    }

    chapterEntries.set(href, {
      title,
      url: new URL(href, DEFAULT_SITE).toString(),
    });
  }

  return Array.from(chapterEntries.values()).slice(0, 20);
}

function parseChapterPages(html) {
  const matches = [...html.matchAll(/https?:\/\/cdn\.onepiecechapters\.com\/file\/[^\s"'<>]+/gi)];
  const pages = matches
    .map((match) => match[0])
    .filter((page) => page.includes('.png') || page.includes('.jpg') || page.includes('.jpeg') || page.includes('.webp'));

  return [...new Set(pages)];
}

function jsonResponse(res, payload, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    let exceededLimit = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (exceededLimit) return;
      body += chunk;
      exceededLimit = Buffer.byteLength(body) > maxBytes;
    });
    req.on('end', () => {
      if (exceededLimit) {
        reject(new Error('Request body is too large.'));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function isAllowedChapterUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' &&
      ['tcbonepiecechapters.com', 'www.tcbonepiecechapters.com'].includes(url.hostname) &&
      url.pathname.startsWith('/chapters/');
  } catch {
    return false;
  }
}

function safeFilename(title) {
  const slug = title.normalize('NFKD').replace(/[^\w -]/g, '').trim().replace(/\s+/g, '-').slice(0, 100);
  return `${slug || 'chapter'}.pdf`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const siteUrl = url.searchParams.get('site') || DEFAULT_SITE;

  if (url.pathname === '/api/chapter.pdf') {
    if (req.method !== 'POST') {
      jsonResponse(res, { error: 'Only POST requests are supported.' }, 405);
      return;
    }

    try {
      const body = await readJsonBody(req);
      const chapterUrl = typeof body.chapterUrl === 'string' ? body.chapterUrl : '';
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
      if (!isAllowedChapterUrl(chapterUrl)) {
        jsonResponse(res, { error: 'PDF export is only available for TCB chapter pages.' }, 400);
        return;
      }

      const chapterHtml = await fetchDocument(chapterUrl);
      const pageUrls = parseChapterPages(chapterHtml);
      if (!pageUrls.length || pageUrls.length > 80) {
        jsonResponse(res, { error: 'This chapter must contain between 1 and 80 pages to export.' }, 422);
        return;
      }

      const imageBuffers = [];
      let totalBytes = 0;
      for (let start = 0; start < pageUrls.length; start += 4) {
        const batch = pageUrls.slice(start, start + 4);
        const batchImages = await Promise.all(batch.map(async (pageUrl) => {
          const imageUrl = new URL(pageUrl);
          if (imageUrl.protocol !== 'https:' || imageUrl.hostname !== 'cdn.onepiecechapters.com') {
            throw new Error('Chapter page image host is not supported.');
          }
          const imageResponse = await fetch(imageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MangaLoader/1.0)' },
            signal: AbortSignal.timeout(60000),
          });
          if (!imageResponse.ok) {
            throw new Error(`Unable to download chapter page (HTTP ${imageResponse.status}).`);
          }
          return Buffer.from(await imageResponse.arrayBuffer());
        }));
        totalBytes += batchImages.reduce((sum, image) => sum + image.length, 0);
        if (totalBytes > 120 * 1024 * 1024) {
          jsonResponse(res, { error: 'The chapter is too large to export as a PDF.' }, 413);
          return;
        }
        imageBuffers.push(...batchImages);
      }

      const pdf = createPdf(title || chapterUrl.split('/').pop().replace(/-/g, ' '), chapterUrl, imageBuffers);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': pdf.length,
        'Content-Disposition': `attachment; filename="${safeFilename(title || 'chapter')}"`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(pdf);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        jsonResponse(res, { error: error.message || 'Unable to create the chapter PDF.' }, 500);
      }
    }
    return;
  }

  if (req.method !== 'GET') {
    jsonResponse(res, { error: 'Only GET requests are supported.' }, 405);
    return;
  }

  if (url.pathname === '/api/latest') {
    try {
      const html = await fetchDocument(siteUrl);
      const chapters = parseLatestChapters(html);
      jsonResponse(res, { chapters, source: siteUrl });
    } catch (error) {
      jsonResponse(res, { error: error.message || 'Unable to load chapters.' }, 500);
    }
    return;
  }

  if (url.pathname === '/api/chapter') {
    const chapterUrl = url.searchParams.get('url') || siteUrl;

    try {
      const html = await fetchDocument(chapterUrl);
      const pages = parseChapterPages(html);
      jsonResponse(res, {
        title: escapeHtml(chapterUrl.split('/').pop().replace(/-/g, ' ') || 'Chapter'),
        pages,
      });
    } catch (error) {
      jsonResponse(res, { error: error.message || 'Unable to load chapter pages.' }, 500);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Manga loader backend running on http://localhost:${PORT}`);
});
