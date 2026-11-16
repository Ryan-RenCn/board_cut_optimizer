import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectStore } from './storage.mjs';
import { convertDwg, defaultDwgConverter } from './dwg-convert.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

export function resolveDatabasePath(baseDirectory = root, environment = process.env) {
  const preferredDatabasePath = join(baseDirectory, 'data', 'board_cut_optimizer.sqlite');
  const legacyDatabasePath = join(baseDirectory, 'data', 'smartcut.sqlite');
  return environment.BOARD_CUT_OPTIMIZER_DB_PATH
    || environment.SMARTCUT_DB_PATH
    || (existsSync(preferredDatabasePath) || !existsSync(legacyDatabasePath) ? preferredDatabasePath : legacyDatabasePath);
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new Error('请求数据超过 10 MB 限制');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createBoardCutServer({
  staticRoot = root,
  databasePath = resolveDatabasePath(staticRoot),
  host = '127.0.0.1',
  port = 2547,
  dwgConverterPath = defaultDwgConverter,
} = {}) {
  const store = createProjectStore(databasePath);
  let listening = false;
  let closed = false;

  async function handleApi(request, response, pathname) {
    if (pathname === '/api/cad/convert-dwg' && request.method === 'POST') {
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) { sendJson(response, 403, { error: '不允许跨站转换请求' }); return true; }
      if (request.headers['content-type'] !== 'application/octet-stream') { sendJson(response, 415, { error: '请以DWG二进制上传' }); return true; }
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 10 * 1024 * 1024) throw new Error('DWG文件超过10 MB'); chunks.push(chunk); }
      try { sendJson(response, 200, await convertDwg(Buffer.concat(chunks), { converterPath: dwgConverterPath })); }
      catch (error) { sendJson(response, 400, { error: error.message }); }
      return true;
    }
    if (pathname === '/api/global-settings' && request.method === 'GET') {
      sendJson(response, 200, { globalSettings: store.getGlobalSettings() });
      return true;
    }
    if (pathname === '/api/global-settings' && request.method === 'PUT') {
      const { globalSettings } = await readJson(request);
      sendJson(response, 200, { globalSettings: store.saveGlobalSettings(globalSettings) });
      return true;
    }
    if (pathname === '/api/draft' && request.method === 'GET') {
      sendJson(response, 200, { project: store.getDraft() });
      return true;
    }
    if (pathname === '/api/draft' && request.method === 'PUT') {
      const { project } = await readJson(request);
      if (!project || typeof project !== 'object') throw new TypeError('缺少工程数据');
      sendJson(response, 200, { project: store.saveDraft(project) });
      return true;
    }
    if (pathname === '/api/projects' && request.method === 'GET') {
      sendJson(response, 200, { projects: store.listProjects() });
      return true;
    }
    if (pathname === '/api/projects' && request.method === 'POST') {
      const { project } = await readJson(request);
      sendJson(response, 200, { project: store.saveProject(project) });
      return true;
    }
    if (pathname.startsWith('/api/projects/') && request.method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/projects/'.length));
      if (!id) throw new TypeError('缺少工程 id');
      const deleted = store.deleteProject(id);
      sendJson(response, deleted ? 200 : 404, { deleted });
      return true;
    }
    if (pathname === '/api/migrate-local-storage' && request.method === 'POST') {
      sendJson(response, 200, store.migrateLegacy(await readJson(request)));
      return true;
    }
    return false;
  }

  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
      if (pathname.startsWith('/api/')) {
        if (!await handleApi(request, response, pathname)) sendJson(response, 404, { error: '接口不存在' });
        return;
      }
      const requested = normalize(join(staticRoot, pathname === '/' ? 'index.html' : pathname));
      if (!requested.startsWith(staticRoot) || !existsSync(requested) || statSync(requested).isDirectory()) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, { 'Content-Type': types[extname(requested)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      createReadStream(requested).pipe(response);
    } catch (error) {
      const clientError = error instanceof URIError || error instanceof SyntaxError || error instanceof TypeError || /10 MB/.test(error.message);
      sendJson(response, clientError ? 400 : 500, { error: error.message || '服务器内部错误' });
    }
  });

  return {
    databasePath,
    async start() {
      if (closed) throw new Error('服务已经关闭');
      if (!listening) {
        await new Promise((resolveStart, reject) => {
          const onError = (error) => reject(error);
          server.once('error', onError);
          server.listen(port, host, () => {
            server.off('error', onError);
            listening = true;
            resolveStart();
          });
        });
      }
      const address = server.address();
      return { url: `http://${host}:${address.port}`, databasePath };
    },
    async close() {
      if (closed) return;
      if (listening) await new Promise((resolveClose) => server.close(resolveClose));
      store.close();
      listening = false;
      closed = true;
    },
  };
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const localServer = createBoardCutServer({ port: Number(process.env.PORT || 2547) });
  const { url } = await localServer.start();
  console.log(`板优排 board_cut_optimizer: ${url}`);
  const shutdown = async () => {
    await localServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
