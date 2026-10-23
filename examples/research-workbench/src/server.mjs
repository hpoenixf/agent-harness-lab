import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

export async function createReaderServer({ publications, sources, artifacts, port = 0, host = '127.0.0.1' }) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Reader server must listen on a loopback host');
  const html = await readFile(new URL('../web/reader.html', import.meta.url));
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    function send(status, value, type = 'application/json; charset=utf-8') {
      response.writeHead(status, { 'Content-Type': type });
      response.end(Buffer.isBuffer(value) ? value : type.startsWith('application/json') ? JSON.stringify(value) : value);
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      send(405, { error: 'Read-only reader: use GET' });
      return;
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/') { send(200, html, 'text/html; charset=utf-8'); return; }
      if (url.pathname === '/api/publications') { send(200, await publications.list()); return; }
      const match = /^\/api\/(publications|sources|artifacts)\/([^/]+)$/.exec(url.pathname);
      if (!match) { send(404, { error: 'Unknown reader resource' }); return; }
      const [, kind, encodedId] = match;
      const id = decodeURIComponent(encodedId);
      if (/[\\/\x00-\x1f]/.test(id) || id.includes('..')) { send(400, { error: 'Invalid object identity' }); return; }
      if (kind === 'publications') {
        const revisionText = url.searchParams.get('revision');
        if (revisionText !== null && !/^[1-9]\d*$/.test(revisionText)) { send(400, { error: 'Invalid revision' }); return; }
        const value = await publications.get(id, revisionText === null ? {} : { revision: Number(revisionText) });
        send(value ? 200 : 404, value ?? { error: 'Publication not found' });
      } else if (kind === 'sources') {
        const value = await sources.get(id);
        send(value ? 200 : 404, value ?? { error: 'Original source window not found' });
      } else {
        const value = await artifacts.get(id);
        if (!value) { send(404, { error: 'Registered artifact not found' }); return; }
        const { record, bytes } = value;
        const fallback = record.filename.replace(/[^A-Za-z0-9._-]/g, '_');
        response.setHeader('Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(record.filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
        response.setHeader('Content-Length', bytes.length);
        send(200, bytes, record.mediaType);
      }
    } catch (error) {
      if (error instanceof URIError || /Invalid .*identity|Invalid .*revision/.test(error.message)) send(400, { error: 'Invalid reader request' });
      else send(500, { error: 'Registered resource could not be read' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  const originHost = host.includes(':') ? `[${host}]` : host;
  return { url: `http://${originHost}:${address.port}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
