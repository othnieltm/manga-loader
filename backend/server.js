const http = require('http');
const { once } = require('node:events');
const { createPdf } = require('./pdf');

const DEFAULT_SITE = 'https://tcbonepiecechapters.com/';
const PORT = Number(process.env.PORT || 3001);
const SOURCE_HOSTS = new Set(['tcbonepiecechapters.com', 'www.tcbonepiecechapters.com']);
const IMAGE_HOSTS = new Set(['cdn.onepiecechapters.com']);

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isAllowedUrl(rawUrl, hosts) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' &&
      hosts.has(url.hostname) &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === '443');
  } catch {
    return false;
  }
}

function isAllowedChapterUrl(rawUrl) {
  if (!isAllowedUrl(rawUrl, SOURCE_HOSTS)) return false;
  return new URL(rawUrl).pathname.startsWith('/chapters/');
}

async function fetchAllowedUrl(rawUrl, hosts, options = {}) {
  let url = new URL(rawUrl);

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!isAllowedUrl(url.toString(), hosts)) {
      throw new Error('The requested URL host is not supported.');
    }

    const response = await fetch(url, {
      ...options,
      redirect: 'manual',
    });

    if (response.status < 300 || response.status >= 400) {
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      return response;
    }

    const location = response.headers.get('location');
    if (!location || redirects === 5) {
      throw new Error('The source returned too many redirects.');
    }
    url = new URL(location, url);
  }

  throw new Error('The source returned too many redirects.');
}

function fetchDocument(rawUrl) {
  return fetchAllowedUrl(rawUrl, SOURCE_HOSTS, {
    signal: AbortSignal.timeout(20000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  }).then((response) => response.text());
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
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 8192) {
  if (req.body !== undefined) {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (Buffer.byteLength(JSON.stringify(body)) > maxBytes) {
        return Promise.reject(requestError('Request body is too large.', 413));
      }
      return Promise.resolve(body);
    } catch (error) {
      return Promise.reject(error instanceof SyntaxError
        ? requestError('Request body must be valid JSON.', 400)
        : error);
    }
  }

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
        reject(requestError('Request body is too large.', 413));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(requestError('Request body must be valid JSON.', 400));
      }
    });
    req.on('error', reject);
  });
}

function requestError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeFilename(title) {
  const slug = title.normalize('NFKD').replace(/[^\w -]/g, '').trim().replace(/\s+/g, '-').slice(0, 100);
  return `${slug || 'chapter'}.pdf`;
}

async function writeBuffer(res, buffer) {
  const chunkSize = 64 * 1024;
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    if (!res.write(buffer.subarray(offset, offset + chunkSize))) {
      await once(res, 'drain');
    }
  }
  res.end();
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    jsonResponse(res, { error: 'Invalid request URL.' }, 400);
    return;
  }

  if (url.pathname === '/api/chapter.pdf') {
    if (req.method !== 'POST') {
      jsonResponse(res, { error: 'Only POST requests are supported.' }, 405);
      return;
    }

    try {
      const body = await readJsonBody(req);
      const chapterUrl = typeof body?.chapterUrl === 'string' ? body.chapterUrl : '';
      const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 200) : '';
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
          if (!isAllowedUrl(imageUrl.toString(), IMAGE_HOSTS)) {
            throw new Error('Chapter page image host is not supported.');
          }
          const imageResponse = await fetchAllowedUrl(imageUrl.toString(), IMAGE_HOSTS, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MangaLoader/1.0)' },
            signal: AbortSignal.timeout(10000),
          });
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
      });
      await writeBuffer(res, pdf);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        jsonResponse(res, { error: error.message || 'Unable to create the chapter PDF.' }, error.statusCode || 500);
      }
    }
    return;
  }

  if (req.method !== 'GET') {
    jsonResponse(res, { error: 'Only GET requests are supported.' }, 405);
    return;
  }

  if (url.pathname === '/api/latest') {
    const siteUrl = url.searchParams.get('site') || DEFAULT_SITE;
    if (!isAllowedUrl(siteUrl, SOURCE_HOSTS)) {
      jsonResponse(res, { error: 'Only HTTPS TCB source URLs are supported.' }, 400);
      return;
    }
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
    const chapterUrl = url.searchParams.get('url') || '';
    if (!isAllowedChapterUrl(chapterUrl)) {
      jsonResponse(res, { error: 'Only TCB chapter pages are supported.' }, 400);
      return;
    }

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
}

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Manga loader backend running on http://localhost:${PORT}`);
  });
}

module.exports = {
  handleRequest,
  isAllowedChapterUrl,
  isAllowedUrl,
};
