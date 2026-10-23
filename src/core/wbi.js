// Small browser-compatible MD5 for Bilibili's WBI request signature. This is a
// protocol checksum, not a cryptographic security primitive used by this app.
const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0);
const mixinOrder = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16,
  24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52];

export function md5(text) {
  const input = new TextEncoder().encode(String(text));
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input); padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (input.length * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(input.length / 0x20000000), true);
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < padded.length; offset += 64) {
    let [a, b, c, d] = state;
    for (let i = 0; i < 64; i++) {
      const round = i >>> 4;
      let f, index;
      if (round === 0) { f = (b & c) | (~b & d); index = i; }
      else if (round === 1) { f = (d & b) | (~d & c); index = (5 * i + 1) % 16; }
      else if (round === 2) { f = b ^ c ^ d; index = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); index = (7 * i) % 16; }
      const sum = (a + f + constants[i] + view.getInt32(offset + index * 4, true)) | 0;
      const shift = shifts[round * 4 + i % 4];
      const nextB = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      a = d; d = c; c = b; b = nextB;
    }
    state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
  }
  return state.flatMap(word => [0, 8, 16, 24].map(shift => ((word >>> shift) & 255).toString(16).padStart(2, '0'))).join('');
}

export function signWbi(params, imgKey, subKey, wts = Math.floor(Date.now() / 1000)) {
  if (!/^[a-f\d]{32}$/i.test(imgKey) || !/^[a-f\d]{32}$/i.test(subKey)) {
    throw new TypeError('WBI 签名密钥无效，请刷新重试。');
  }
  if (!Number.isSafeInteger(Number(wts)) || Number(wts) <= 0) throw new TypeError('WBI 时间戳无效。');
  const source = `${imgKey}${subKey}`;
  const mixinKey = mixinOrder.slice(0, 32).map(index => source[index]).join('');
  const values = { ...params, wts: Number(wts) };
  delete values.w_rid;
  const signed = {};
  for (const key of Object.keys(values).sort()) {
    if (values[key] !== undefined && values[key] !== null) signed[key] = String(values[key]).replace(/[!'()*]/g, '');
  }
  const query = new URLSearchParams(signed).toString();
  signed.w_rid = md5(query + mixinKey);
  return signed;
}
