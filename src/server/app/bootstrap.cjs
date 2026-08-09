const http = require('node:http');
const {
  LiveRecordService,
  DEV_MODE,
  OPEN_BROWSER,
  writeJson,
  getRuntimeHost,
  getRuntimePort,
  openUrl
} = require('./service.cjs');
const { createViteMiddleware, handleRequest } = require('./routes.cjs');

async function start() {
  const service = new LiveRecordService();
  await service.init();
  const vite = DEV_MODE ? await createViteMiddleware() : null;
  const port = getRuntimePort(service.settings.serverPort);
  const host = getRuntimeHost(service.settings.serverHost);
  service.currentPort = port;
  service.currentHost = host;

  const server = http.createServer((request, response) => {
    handleRequest(service, vite, port, request, response).catch((error) => {
      writeJson(response, error.statusCode || 500, { error: error.message || String(error) });
    });
  });

  const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${browserHost}:${port}`;
  const listenLabel = `${host}:${port}`;
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      if (OPEN_BROWSER) {
        openUrl(url);
      }
      console.log(`监听地址 ${listenLabel} 已被占用，已尝试打开现有 WebUI: ${url}`);
      process.exit(0);
      return;
    }
    throw error;
  });

  server.listen(port, host, () => {
    console.log(`哔哩录播 2K WebUI 已启动: ${url}`);
    console.log(`实际监听: ${listenLabel}`);
    if (host === '0.0.0.0' || host === '::') {
      console.log(`局域网访问: http://本机局域网IP:${port}`);
    }
    console.log('浏览器关闭后，保持这个 Node 进程运行即可继续监听/录制。');
    if (OPEN_BROWSER && service.settings.openBrowserOnStart) {
      setTimeout(() => openUrl(url), 300);
    }
  });

  let shutdownPromise = null;
  const shutdown = (reason = 'signal') => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const serverClosed = new Promise((resolve) => server.close(resolve));
      await service.beginShutdown(reason);
      for (const response of service.clients.keys()) response.end();
      await vite?.close?.();
      await Promise.race([serverClosed, new Promise((resolve) => setTimeout(resolve, 5000))]);
      process.exit(0);
    })().catch((error) => {
      console.error(`优雅退出失败：${error.stack || error.message || error}`);
      process.exit(1);
    });
    const watchdog = setTimeout(() => process.exit(1), 125000);
    watchdog.unref();
    return shutdownPromise;
  };
  service.setShutdownHandler(shutdown);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { start };
