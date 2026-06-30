const { start } = require('./app/bootstrap.cjs');

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
