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

function parseIPv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':');
    if (separator < 0) return null;
    const ipv4 = normalized.slice(separator + 1);
    const value = ipv4ToNumber(ipv4);
    if (value === null) return null;
    const high = (value >>> 16) & 0xffff;
    const low = value & 0xffff;
    normalized = normalized.slice(0, separator + 1) + high.toString(16) + ':' + low.toString(16);
  }

  const pieces = normalized.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;

  const missing = 8 - left.length - right.length;
  if (pieces.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: pieces.length === 2 ? missing : 0 }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
  return words.length === 8 ? words : null;
}

interface IPv6Prefix {
  readonly words: readonly number[];
  readonly length: number;
}

function parseIPv6Prefix(address: string, length: number): IPv6Prefix {
  const words = parseIPv6Words(address);
  if (!words) throw new Error('Invalid IPv6 prefix in address policy.');
  return { words, length };
}

const blockedIPv6Prefixes: readonly IPv6Prefix[] = [
  // IANA special-purpose entries that are not globally reachable.
  // The parent 2001::/23 has specific globally-reachable allocations below.
  parseIPv6Prefix('2001::', 23),
  parseIPv6Prefix('2001:2::', 48),
  parseIPv6Prefix('2001:db8::', 32),
  parseIPv6Prefix('2002::', 16), // 6to4: global reachability is not defined by IANA.
  parseIPv6Prefix('3fff::', 20), // Documentation.
];

const globallyReachableIPv6Exceptions: readonly IPv6Prefix[] = [
  // More-specific IANA allocations permitted within 2001::/23.
  parseIPv6Prefix('2001:1::1', 128),
  parseIPv6Prefix('2001:1::2', 128),
  parseIPv6Prefix('2001:1::3', 128),
  parseIPv6Prefix('2001:3::', 32),
  parseIPv6Prefix('2001:4:112::', 48),
  parseIPv6Prefix('2001:20::', 28),
  parseIPv6Prefix('2001:30::', 28),
];

function matchesPrefix(address: readonly number[], prefix: IPv6Prefix): boolean {
  const wholeWords = Math.floor(prefix.length / 16);
  const remainingBits = prefix.length % 16;
  for (let index = 0; index < wholeWords; index += 1) {
    if (address[index] !== prefix.words[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return ((address[wholeWords]! & mask) === (prefix.words[wholeWords]! & mask));
}

function isPublicIPv6(address: string): boolean {
  // Global unicast space is 2000::/3. Special-purpose ranges are then
  // evaluated using longest-prefix precedence, including IANA exceptions.
  const words = parseIPv6Words(address);
  if (!words || (words[0]! & 0xe000) !== 0x2000) return false;

  // IPv4-mapped IPv6 must inherit the policy of the embedded IPv4 address,
  // including when written in hexadecimal rather than dotted-decimal form.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const embedded = ((words[6]! << 16) | words[7]!) >>> 0;
    const ipv4 = [
      (embedded >>> 24) & 0xff, (embedded >>> 16) & 0xff,
      (embedded >>> 8) & 0xff, embedded & 0xff,
    ].join('.');
    return isPublicIPv4(ipv4);
  }

  if (globallyReachableIPv6Exceptions.some((prefix) => matchesPrefix(words, prefix))) return true;
  return !blockedIPv6Prefixes.some((prefix) => matchesPrefix(words, prefix));
}

/**
 * Checks DNS answers against conservative IANA special-purpose boundaries.
 * All DNS answers must pass before a caller pins one address for the request.
 */
export function isPublicNetworkAddress(address: string, family: number): boolean {
  if (family === 4) return isPublicIPv4(address);
  return family === 6 && isIP(address) === 6 && isPublicIPv6(address);
}
