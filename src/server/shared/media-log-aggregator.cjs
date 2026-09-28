'use strict';
function createMediaLogAggregator(log, prefix, now = Date.now) {
  const groups = new Map();
  const keyOf = line => String(line).replace(/0x[\da-f]+/gi, '<hex>').replace(/\b(?:pos|position)\s+\d+/gi, 'pos <offset>');
  return {
    write(line) {
      for (const text of String(line).split(/\r?\n/).filter(Boolean)) this.writeLine(text);
    },
    writeLine(line) {
      const key = keyOf(line);
      let item = groups.get(key);
      if (!item) {
        if (groups.size >= 128) this.flush();
        item = { count: 0, reported: 0, last: String(line), at: now() };
        groups.set(key, item);
        log('warn', prefix + item.last);
      }
      item.count += 1; item.last = String(line);
      if (now() - item.at >= 10_000 && item.count - item.reported > 1) {
        log('warn', `${prefix}同类信息累计 ${item.count} 次；最近：${item.last}`);
        item.reported = item.count; item.at = now();
      }
    },
    flush() {
      for (const item of groups.values()) if (item.count > 1 && item.reported !== item.count) log('warn', `${prefix}同类信息共 ${item.count} 次；最近：${item.last}`);
      groups.clear();
    }
  };
}
module.exports = { createMediaLogAggregator };
