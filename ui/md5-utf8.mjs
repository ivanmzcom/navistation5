/**
 * OpenSubsonic token primitive: MD5(password + salt), not password storage.
 * Independent implementation of RFC 1321, sections 3.1–3.5:
 * https://www.rfc-editor.org/rfc/rfc1321
 * UTF-16/UTF-8 conversion follows Unicode 16.0, sections 3.9.2/3.9.3/3.9.6:
 * https://www.unicode.org/versions/Unicode16.0.0/core-spec/chapter-3/
 * No Node, DOM, TextEncoder, crypto provider, logging, or persistent input copy.
 */

// Covers the client's 16,384-unit password plus its 32 ASCII salt characters.
// At most three UTF-8 bytes per UTF-16 code unit: 196,608 input bytes total.
export const MAX_MD5_UTF16_UNITS = 65536;

const CONSTANTS = Object.freeze([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);
const SHIFTS = Object.freeze([7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21]);
const HEX = "0123456789abcdef";

/**
 * Return lowercase, 32-character MD5 of text encoded as UTF-8.
 * Valid surrogate pairs become one scalar; each isolated surrogate becomes
 * U+FFFD. No normalization, BOM insertion, trimming, or case conversion occurs.
 * Input is limited in UTF-16 code units before any digest work or allocation.
 */
export function md5Utf8(text) {
  if (typeof text !== "string") throw new TypeError("MD5 input must be a string");
  if (text.length > MAX_MD5_UTF16_UNITS) throw new RangeError("MD5 input is too long");

  const words = new Array(16).fill(0);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  let byteCount = 0;

  function compress() {
    let a = state[0], b = state[1], c = state[2], d = state[3];
    for (let i = 0; i < 64; i++) {
      let f, index;
      if (i < 16) { f = (b & c) | (~b & d); index = i; }
      else if (i < 32) { f = (b & d) | (c & ~d); index = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; index = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); index = (7 * i) & 15; }
      const sum = (a + f + words[index] + CONSTANTS[i]) | 0;
      const shift = SHIFTS[((i >>> 4) << 2) + (i & 3)];
      const previousD = d;
      d = c;
      c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      a = previousD;
    }
    state[0] = (state[0] + a) | 0;
    state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0;
    state[3] = (state[3] + d) | 0;
    words.fill(0);
  }

  function appendByte(value) {
    words[(byteCount >>> 2) & 15] |= value << ((byteCount & 3) << 3);
    byteCount++;
    if ((byteCount & 63) === 0) compress();
  }

  try {
    for (let i = 0; i < text.length; i++) {
      let scalar = text.charCodeAt(i);
      if (scalar >= 0xd800 && scalar <= 0xdbff) {
        const low = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
        if (low >= 0xdc00 && low <= 0xdfff) {
          scalar = 0x10000 + ((scalar - 0xd800) << 10) + (low - 0xdc00);
          i++;
        } else scalar = 0xfffd;
      } else if (scalar >= 0xdc00 && scalar <= 0xdfff) scalar = 0xfffd;

      if (scalar < 0x80) appendByte(scalar);
      else if (scalar < 0x800) {
        appendByte(0xc0 | (scalar >>> 6));
        appendByte(0x80 | (scalar & 0x3f));
      } else if (scalar < 0x10000) {
        appendByte(0xe0 | (scalar >>> 12));
        appendByte(0x80 | ((scalar >>> 6) & 0x3f));
        appendByte(0x80 | (scalar & 0x3f));
      } else {
        appendByte(0xf0 | (scalar >>> 18));
        appendByte(0x80 | ((scalar >>> 12) & 0x3f));
        appendByte(0x80 | ((scalar >>> 6) & 0x3f));
        appendByte(0x80 | (scalar & 0x3f));
      }
    }

    // Capture the original bit length before padding; append it little-endian.
    const bitsLow = (byteCount * 8) >>> 0;
    const bitsHigh = Math.floor(byteCount / 0x20000000) >>> 0;
    appendByte(0x80);
    while ((byteCount & 63) !== 56) appendByte(0);
    for (let i = 0; i < 4; i++) appendByte((bitsLow >>> (i * 8)) & 0xff);
    for (let i = 0; i < 4; i++) appendByte((bitsHigh >>> (i * 8)) & 0xff);

    let result = "";
    for (let word = 0; word < 4; word++) {
      for (let i = 0; i < 4; i++) {
        const value = (state[word] >>> (i * 8)) & 0xff;
        result += HEX[value >>> 4] + HEX[value & 15];
      }
    }
    return result;
  } finally {
    words.fill(0);
    state.fill(0);
    byteCount = 0;
    // JS strings/temporaries cannot be reliably erased from the engine's heap.
  }
}
