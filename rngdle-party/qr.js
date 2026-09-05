// Minimal QR encoder — enough to turn a join URL into a scannable code.
//
// Byte mode, error-correction level M, versions 1-10 (up to ~200 chars, far
// more than a join link needs). Written out rather than pulled from a CDN so
// the host screen still works on a LAN with no internet, which is exactly the
// situation a party is usually in.
(function (global) {

  // --- GF(256) tables for Reed-Solomon -------------------------------------
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  function rsGenerator(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];                    // multiply by x
        next[j + 1] ^= mul(poly[j], EXP[i]);   // ...and by alpha^i
      }
      poly = next;
    }
    return poly;
  }
  // Per-version, EC level M: [total codewords, ec codewords per block, blocks]
  const VERSIONS = {
    1:  [26,   10, 1], 2:  [44,   16, 1], 3:  [70,   26, 1], 4:  [100,  18, 2],
    5:  [134,  24, 2], 6:  [172,  16, 4], 7:  [196,  18, 4], 8:  [242,  22, 4],
    9:  [292,  22, 5], 10: [346,  26, 5]
  };
  const ALIGN = { 1: [], 2: [6,18], 3: [6,22], 4: [6,26], 5: [6,30],
                  6: [6,34], 7: [6,22,38], 8: [6,24,42], 9: [6,26,46], 10: [6,28,50] };

  function capacityBytes(v) { const [total, ec, blocks] = VERSIONS[v]; return total - ec * blocks - 2; }

  function encodeData(text, version) {
    const bytes = new TextEncoder().encode(text);
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    put(4, 4);                                   // byte mode
    put(bytes.length, version < 10 ? 8 : 16);    // char count
    for (const b of bytes) put(b, 8);

    const [total, ecLen, blocks] = VERSIONS[version];
    const dataCodewords = total - ecLen * blocks;
    const capacity = dataCodewords * 8;
    for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);   // terminator
    while (bits.length % 8) bits.push(0);
    const words = [];
    for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    const PAD = [0xec, 0x11];
    for (let i = 0; words.length < dataCodewords; i++) words.push(PAD[i % 2]);

    // split into blocks, RS each, then interleave
    const perBlock = Math.floor(dataCodewords / blocks), extra = dataCodewords % blocks;
    const dataBlocks = [], ecBlocks = [];
    let pos = 0;
    for (let b = 0; b < blocks; b++) {
      const len = perBlock + (b >= blocks - extra ? 1 : 0);
      const chunk = words.slice(pos, pos + len); pos += len;
      dataBlocks.push(chunk);
      ecBlocks.push(rsBlock(chunk, ecLen));
    }
    const out = [];
    const maxData = Math.max(...dataBlocks.map(b => b.length));
    for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);
    return out;
  }

  function rsBlock(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const res = new Array(data.length + ecLen).fill(0);
    for (let i = 0; i < data.length; i++) res[i] = data[i];
    for (let i = 0; i < data.length; i++) {
      const coef = res[i];
      if (!coef) continue;
      for (let j = 0; j < gen.length; j++) res[i + j] ^= mul(gen[j], coef);
    }
    return res.slice(data.length);
  }

  // --- matrix ---------------------------------------------------------------
  function buildMatrix(version, codewords, mask) {
    const size = version * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(null));
    const reserve = (r, c) => (r >= 0 && r < size && c >= 0 && c < size);

    const finder = (r0, c0) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        if (!reserve(r0 + r, c0 + c)) continue;
        const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                   (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                   (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[r0 + r][c0 + c] = on ? 1 : 0;
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    for (let i = 8; i < size - 8; i++) {                       // timing
      m[6][i] = i % 2 === 0 ? 1 : 0;
      m[i][6] = i % 2 === 0 ? 1 : 0;
    }
    for (const r of ALIGN[version]) for (const c of ALIGN[version]) {   // alignment
      if (m[r][c] !== null) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
        m[r + dr][c + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
    }
    m[size - 8][8] = 1;                                        // dark module

    // reserve format areas so data skips them
    for (let i = 0; i < 9; i++) { if (m[8][i] === null) m[8][i] = 0; if (m[i][8] === null) m[i][8] = 0; }
    for (let i = size - 8; i < size; i++) { if (m[8][i] === null) m[8][i] = 0; if (m[i][8] === null) m[i][8] = 0; }

    // data, snaking upward in 2-wide columns
    const maskFn = [
      (r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
    ][mask];
    let bit = 0;
    const total = codewords.length * 8;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let i = 0; i < size; i++) {
        const up = ((size - 1 - col) >> 1) % 2 === 0;
        const row = up ? size - 1 - i : i;
        for (let k = 0; k < 2; k++) {
          const c = col - k;
          if (m[row][c] !== null) continue;
          let v = 0;
          if (bit < total) v = (codewords[bit >> 3] >> (7 - (bit & 7))) & 1;
          bit++;
          m[row][c] = maskFn(row, c) ? v ^ 1 : v;
        }
      }
    }

    // format info: EC level M (00) + mask, BCH-protected then XOR'd
    const fmt = (0b00 << 3) | mask;
    let rem = fmt << 10;
    for (let i = 4; i >= 0; i--) if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
    const bitsF = ((fmt << 10) | rem) ^ 0b101010000010010;
    const at = i => (bitsF >> (14 - i)) & 1;   // format bits are placed most-significant first
    for (let i = 0; i <= 5; i++) m[8][i] = at(i);
    m[8][7] = at(6); m[8][8] = at(7); m[7][8] = at(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = at(i);
    // Second copy: 7 bits up the left edge (the 8th cell there is the dark
    // module and must stay set), then 8 bits along the top-right.
    for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = at(i);
    for (let i = 7; i <= 14; i++) m[8][size - 15 + i] = at(i);
    return m;
  }

  function penalty(m) {
    const size = m.length; let score = 0;
    const runScore = line => { let s = 0, run = 1;
      for (let i = 1; i < line.length; i++) {
        if (line[i] === line[i - 1]) { run++; if (run === 5) s += 3; else if (run > 5) s++; }
        else run = 1;
      } return s; };
    for (let i = 0; i < size; i++) { score += runScore(m[i]); score += runScore(m.map(r => r[i])); }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++)
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    let dark = 0; for (const row of m) for (const v of row) dark += v;
    score += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
    return score;
  }

  /** Smallest version that fits, matrix with the best of the 8 masks. */
  function encode(text) {
    let version = 0;
    for (let v = 1; v <= 10; v++) {
      if (new TextEncoder().encode(text).length <= capacityBytes(v)) { version = v; break; }
    }
    if (!version) throw new Error('qr: text too long');
    const codewords = encodeData(text, version);
    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const m = buildMatrix(version, codewords, mask);
      const p = penalty(m);
      if (p < bestScore) { bestScore = p; best = m; }
    }
    return best;
  }

  /** Scannable SVG. `dark`/`light` let it sit on either theme. */
  function svg(text, opts) {
    opts = opts || {};
    const m = encode(text);
    const size = m.length, quiet = opts.quiet == null ? 3 : opts.quiet;
    const dim = size + quiet * 2;
    const dark = opts.dark || '#0a0a0a', light = opts.light || '#ffffff';
    let path = '';
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
      if (m[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="Join QR code">` +
           `<rect width="${dim}" height="${dim}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
  }

  global.RNGPARTY_QR = { encode, svg };

})(typeof window !== 'undefined' ? window : globalThis);
