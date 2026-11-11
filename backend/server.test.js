const assert = require('node:assert/strict');
const test = require('node:test');
const { handleRequest, isAllowedChapterUrl, isAllowedUrl } = require('./server');

function createResponse() {
  return {
    headersSent: false,
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body = '') {
      this.body += body;
    },
  };
}

test('allows only HTTPS URLs on the supported source hosts', () => {
  assert.equal(isAllowedUrl('https://tcbonepiecechapters.com/', new Set(['tcbonepiecechapters.com'])), true);
  assert.equal(isAllowedUrl('http://tcbonepiecechapters.com/', new Set(['tcbonepiecechapters.com'])), false);
  assert.equal(isAllowedUrl('https://tcbonepiecechapters.com.attacker.test/', new Set(['tcbonepiecechapters.com'])), false);
  assert.equal(isAllowedUrl('https://user@tcbonepiecechapters.com/', new Set(['tcbonepiecechapters.com'])), false);
  assert.equal(isAllowedUrl('https://tcbonepiecechapters.com:8443/', new Set(['tcbonepiecechapters.com'])), false);
});

test('allows only supported chapter URLs', () => {
  assert.equal(isAllowedChapterUrl('https://tcbonepiecechapters.com/chapters/chapter-1'), true);
  assert.equal(isAllowedChapterUrl('https://tcbonepiecechapters.com/'), false);
  assert.equal(isAllowedChapterUrl('https://example.test/chapters/chapter-1'), false);
});

test('rejects unsupported latest and chapter URLs without fetching', async () => {
  const latestResponse = createResponse();
  await handleRequest({ method: 'GET', url: '/api/latest?site=http%3A%2F%2F127.0.0.1%2F' }, latestResponse);
  assert.equal(latestResponse.statusCode, 400);

  const chapterResponse = createResponse();
  await handleRequest({ method: 'GET', url: '/api/chapter?url=https%3A%2F%2F127.0.0.1%2Fchapters%2F1' }, chapterResponse);
  assert.equal(chapterResponse.statusCode, 400);
});

test('reports invalid and oversized PDF request bodies as client errors', async () => {
  const invalidResponse = createResponse();
  await handleRequest({
    method: 'POST',
    url: '/api/chapter.pdf',
    body: '{',
  }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);

  const oversizedResponse = createResponse();
  await handleRequest({
    method: 'POST',
    url: '/api/chapter.pdf',
    body: { title: 'x'.repeat(9000) },
  }, oversizedResponse);
  assert.equal(oversizedResponse.statusCode, 413);
});

test('does not follow source redirects to unsupported hosts', async () => {
  const originalFetch = global.fetch;
  let fetchCount = 0;
  global.fetch = async () => {
    fetchCount += 1;
    return new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/' },
    });
  };

  try {
    const response = createResponse();
    await handleRequest({ method: 'GET', url: '/api/latest' }, response);
    assert.equal(response.statusCode, 500);
    assert.equal(fetchCount, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
