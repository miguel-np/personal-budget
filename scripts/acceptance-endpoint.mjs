import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4Number(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error('Invalid IPv4 address.');
  }
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function inIpv4Range(address, network, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

function isPublicIpv4(address) {
  return !BLOCKED_IPV4_RANGES.some(([network, prefix]) => inIpv4Range(address, network, prefix));
}

function ipv6Number(address) {
  let value = address.toLowerCase().split('%')[0];
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    if (separator < 0) return null;
    const embedded = value.slice(separator + 1);
    const number = ipv4Number(embedded);
    value = value.slice(0, separator + 1) + (number >>> 16).toString(16) + ':' + (number & 0xffff).toString(16);
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt('0x' + group), 0n);
}

function inIpv6Range(value, network, prefix) {
  const addressNumber = ipv6Number(value);
  const networkNumber = ipv6Number(network);
  if (addressNumber === null || networkNumber === null) return true;
  const shift = 128n - BigInt(prefix);
  return (addressNumber >> shift) === (networkNumber >> shift);
}

function isPublicIpv6(address) {
  // Only globally routable unicast space is eligible. Explicitly reject transition
  // and documentation ranges that otherwise fall inside 2000::/3.
  if (!inIpv6Range(address, '2000::', 3)) return false;
  if (inIpv6Range(address, '2001::', 23)) return false;
  if (inIpv6Range(address, '2001:db8::', 32)) return false;
  if (inIpv6Range(address, '2002::', 16)) return false;
  return true;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function normalizeHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return !host.includes('.') ||
    ['localhost', 'local', 'internal', 'test', 'example', 'invalid'].some((suffix) =>
      host === suffix || host.endsWith('.' + suffix));
}

export async function validateAcceptanceEndpoint(value, { lookup = dnsLookup } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('PERSONAL_BUDGET_ACCEPTANCE_API_URL is required.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The acceptance target must be a valid URL.');
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('The acceptance target must be an HTTPS origin without credentials, path, query or fragment.');
  }

  const hostname = normalizeHostname(url.hostname);
  const family = isIP(hostname);
  if (family !== 0) {
    if (!isPublicAddress(hostname)) throw new Error('The acceptance target must not use a private or reserved IP address.');
    return url;
  }

  if (isBlockedHostname(hostname)) {
    throw new Error('The acceptance target must not use a local or reserved hostname.');
  }

  let answers;
  try {
    answers = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('The acceptance target hostname could not be resolved safely.');
  }
  if (!Array.isArray(answers) || answers.length === 0 ||
    answers.some((answer) => !answer || !isPublicAddress(answer.address))) {
    throw new Error('Every resolved acceptance target address must be globally routable.');
  }

  return url;
}
