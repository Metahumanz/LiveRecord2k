const { start } = require('./app/bootstrap.cjs');
const { runAssWorker } = require('./danmaku/ass-worker.cjs');

const task = process.argv.includes('--ass-worker') ? runAssWorker() : start();

task.catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
