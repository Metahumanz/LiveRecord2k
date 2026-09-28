'use strict';
async function runBounded(items, concurrency, operation) {
  let cursor = 0, failure;
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
    while (!failure && cursor < items.length) {
      const index = cursor++;
      try { await operation(items[index], index); } catch (error) { failure = error; }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
}
module.exports = { runBounded };
