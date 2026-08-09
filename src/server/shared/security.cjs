'use strict';

const dns = require('node:dns');
const net = require('node:net');

const SENSITIVE_KEY_PATTERN = /(?:authorization|proxy-authorization|cookie|set-cookie|token|secret|password|passwd|pwd|sessdata|bili_jct|access_key)/i;
const URL_CREDENTIAL_PATTERN = /([?&](?:access_token|token|secret|password|key|auth|signature)=)[^&#\s]*/gi;

function normalizeIpAddress(value) {
  let address = String(value || '').trim().toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  if (address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4) {
    return address.slice(7);
  }
  return address;
}

function ipv4Number(address) {
  const parts = normalizeIpAddress(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inIpv4Range(address, base, prefix) {
  const value = ipv4Number(address);
  const network = ipv4Number(base);
  if (value === null || network === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function inIpSubnet(address, base, prefix, family) {
  try {
    const blockList = new net.BlockList();
    blockList.addSubnet(base, prefix, family);
    return blockList.check(address, family);
  } catch {
    return false;
  }
}

function isLoopbackAddress(value) {
  const address = normalizeIpAddress(value);
  return address === '::1' || inIpv4Range(address, '127.0.0.0', 8);
}

function isPrivateOrSpecialAddress(value) {
  const address = normalizeIpAddress(value);
  const family = net.isIP(address);
  if (!family) return true;
  if (family === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4]
    ].some(([base, prefix]) => inIpv4Range(address, base, prefix));
  }
  return [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8]
  ].some(([base, prefix]) => inIpSubnet(address, base, prefix, 'ipv6'));
}

function normalizeTrustedProxyList(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return values.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean).slice(0, 32);
}

function isAddressInCidr(address, cidr) {
  const normalizedAddress = normalizeIpAddress(address);
  const rule = String(cidr || '').trim().toLowerCase();
  if (!rule) return false;
  if (rule === 'loopback') return isLoopbackAddress(normalizedAddress);
  if (!rule.includes('/')) return normalizeIpAddress(rule) === normalizedAddress;
  const [base, prefixText] = rule.split('/', 2);
  const prefix = Number(prefixText);
  if (net.isIP(normalizedAddress) === 4 && net.isIP(base) === 4 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
    return inIpv4Range(normalizedAddress, base, prefix);
  }
  if (net.isIP(normalizedAddress) === 6 && net.isIP(base) === 6 && Number.isInteger(prefix) && prefix >= 0 && prefix <= 128) {
    return inIpSubnet(normalizedAddress, normalizeIpAddress(base), prefix, 'ipv6');
  }
  return false;
}

function isTrustedProxyAddress(address, trustedProxies) {
  return normalizeTrustedProxyList(trustedProxies).some((rule) => isAddressInCidr(address, rule));
}

function hasForwardingHeaders(headers = {}) {
  return ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'].some(
    (name) => String(headers[name] || '').trim()
  );
}

function forwardedAddressChain(headers = {}) {
  const forwardedFor = String(headers['x-forwarded-for'] || '')
    .split(',')
    .map((value) => normalizeForwardedAddress(value))
    .filter((value) => net.isIP(value));
  if (forwardedFor.length) return forwardedFor;
  const realIp = String(headers['x-real-ip'] || '').trim();
  const normalizedRealIp = normalizeForwardedAddress(realIp);
  if (net.isIP(normalizedRealIp)) return [normalizedRealIp];
  const forwarded = String(headers.forwarded || '');
  const match = /(?:^|[;,])\s*for=(?:"?\[?)([^\]";,]+)(?:\]?"?)/i.exec(forwarded);
  const normalizedForwarded = normalizeForwardedAddress(match?.[1] || '');
  return net.isIP(normalizedForwarded) ? [normalizedForwarded] : [];
}

function normalizeForwardedAddress(value) {
  let text = String(value || '').trim().replace(/^"|"$/g, '');
  if (text.startsWith('[')) {
    const closing = text.indexOf(']');
    if (closing > 0) text = text.slice(1, closing);
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(text)) {
    text = text.slice(0, text.lastIndexOf(':'));
  }
  return normalizeIpAddress(text);
}

function getRequestNetworkContext(request, trustedProxies = []) {
  const peerAddress = normalizeIpAddress(request.socket?.remoteAddress || request.connection?.remoteAddress || '');
  const trustedProxy = isTrustedProxyAddress(peerAddress, trustedProxies);
  const forwarded = hasForwardingHeaders(request.headers || {});
  let forwardedAddress = '';
  if (trustedProxy) {
    const chain = forwardedAddressChain(request.headers || {});
    let currentProxy = peerAddress;
    for (let index = chain.length - 1; index >= 0 && isTrustedProxyAddress(currentProxy, trustedProxies); index -= 1) {
      forwardedAddress = chain[index];
      currentProxy = forwardedAddress;
    }
  }
  return {
    peerAddress,
    trustedProxy,
    forwarded,
    clientAddress: forwardedAddress || peerAddress,
    forwardedProto: trustedProxy ? String(request.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() : ''
  };
}

function createPinnedLookup(records) {
  const addresses = records.map((record) => ({ address: normalizeIpAddress(record.address), family: Number(record.family) }));
  return (_hostname, options, callback) => {
    const requestedFamily = typeof options === 'number' ? options : Number(options?.family || 0);
    const candidates = requestedFamily ? addresses.filter((item) => item.family === requestedFamily) : addresses;
    const selected = candidates[0] || addresses[0];
    if (!selected) {
      callback(Object.assign(new Error('DNS 没有返回可用地址。'), { code: 'ENOTFOUND' }));
      return;
    }
    if (options?.all) callback(null, candidates.length ? candidates : addresses);
    else callback(null, selected.address, selected.family);
  };
}

async function validateRemoteUrl(rawUrl, options = {}) {
  const target = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl || ''));
  const protocols = options.protocols || ['https:', 'http:'];
  if (!protocols.includes(target.protocol)) throw new Error(`不允许访问 ${target.protocol} 地址。`);
  if (target.username || target.password) throw new Error('远端地址不能包含用户名或密码。');
  if (typeof options.allowHost === 'function' && !options.allowHost(target.hostname)) {
    throw new Error(`不允许访问远端主机 ${target.hostname}。`);
  }
  const literalFamily = net.isIP(normalizeIpAddress(target.hostname));
  const records = literalFamily
    ? [{ address: normalizeIpAddress(target.hostname), family: literalFamily }]
    : await dns.promises.lookup(target.hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error('DNS 没有返回可用地址。');
  if (!options.allowPrivate && records.some((record) => isPrivateOrSpecialAddress(record.address))) {
    throw new Error(`远端地址解析到本机、私有或保留网络，已拒绝访问：${target.hostname}`);
  }
  return { target, records, lookup: createPinnedLookup(records) };
}

function redactSensitive(value) {
  let text = value instanceof Error ? value.message : String(value ?? '');
  text = text.replace(URL_CREDENTIAL_PATTERN, '$1[redacted]');
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, '$1 [redacted]');
  text = text.replace(
    /\b(cookie|authorization|token|secret|password|passwd|pwd|sessdata|bili_jct)\s*[:=]\s*([^\s,;]+)/gi,
    '$1=[redacted]'
  );
  return text;
}

function redactObject(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactSensitive(value) : value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactObject(item, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redactObject(item, seen);
  }
  return output;
}

module.exports = {
  normalizeIpAddress,
  isLoopbackAddress,
  isPrivateOrSpecialAddress,
  normalizeTrustedProxyList,
  isTrustedProxyAddress,
  hasForwardingHeaders,
  getRequestNetworkContext,
  validateRemoteUrl,
  redactSensitive,
  redactObject
};
