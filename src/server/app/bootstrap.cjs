const http = require('node:http');
const {
  LiveRecordService,
  HOST,
  DEV_MODE,
  OPEN_BROWSER,
  writeJson,
  getRuntimePort,
  openUrl
} = require('./service.cjs');
const { createViteMiddleware, handleRequest } = require('./routes.cjs');

async function start() {
  const service = new LiveRecordService();
  await service.init();
  const vite = DEV_MODE ? await createViteMiddleware() : null;
  const port = getRuntimePort(service.settings.serverPort);
  service.currentPort = port;

  const server = http.createServer((request, response) => {
    handleRequest(service, vite, port, request, response).catch((error) => {
      writeJson(response, error.statusCode || 500, { error: error.message || String(error) });
    });
  });

  const url = `http://${HOST}:${port}`;
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      if (OPEN_BROWSER) {
        openUrl(url);
      }
      console.log(`端口 ${port} 已被占用，已尝试打开现有 WebUI: ${url}`);
      process.exit(0);
      return;
    }
    throw error;
  });

  server.listen(port, HOST, () => {
    console.log(`哔哩录播 2K WebUI 已启动: ${url}`);
    console.log('浏览器关闭后，保持这个 Node 进程运行即可继续监听/录制。');
    if (OPEN_BROWSER && service.settings.openBrowserOnStart) {
      setTimeout(() => openUrl(url), 300);
    }
  });

  const shutdown = () => {
    service.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { start };
