import { isIP } from 'node:net';

const blockedIPv4Prefixes: readonly [number, number][] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
  [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];

function ipv4ToNumber(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
}

function isPublicIPv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  if (value === null) return false;
  return !blockedIPv4Prefixes.some(([network, prefix]) => {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (network & mask);
  });
}

function mappedIPv4Address(address: string): string | null {
  const suffix = address.slice('::ffff:'.length);
  if (isIP(suffix) === 4) return suffix;
  const parts = suffix.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const high = Number.parseInt(parts[0]!, 16);
  const low = Number.parseInt(parts[1]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

function secondHextetAtMost(address: string, maximum: number): boolean {
  const second = address.split(':')[1] ?? '';
  if (second === '') return true;
  if (!/^[0-9a-f]{1,4}$/.test(second)) return false;
  return Number.parseInt(second, 16) <= maximum;
}

function isPublicIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  // Accept only global-unicast space (2000::/3), then subtract special-purpose
  // ranges that are not globally reachable or are deliberately non-routable.
  if (!/^[23]/.test(normalized)) return false;
  if (normalized.startsWith('2001:') && secondHextetAtMost(normalized, 0x01ff)) return false; // IANA 2001::/23
  if (normalized.startsWith('2001:db8:')) return false; // Documentation
  if (normalized.startsWith('2002:')) return false; // 6to4
  if (normalized.startsWith('3fff:') && secondHextetAtMost(normalized, 0x0fff)) return false; // IANA 3fff::/20 documentation
  return true;
}

/**
 * Checks DNS answers against conservative IANA special-purpose boundaries.
 * All DNS answers must pass before a caller pins one address for the request.
 */
export function isPublicNetworkAddress(address: string, family: number): boolean {
  if (family === 4) return isPublicIPv4(address);
  if (family !== 6 || isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = mappedIPv4Address(normalized);
    return mapped !== null && isPublicIPv4(mapped);
  }
  return isPublicIPv6(normalized);
}
