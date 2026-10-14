// ZXing fallback decode proof (v553): the vendored zxing-wasm reader build
// must actually decode a real EAN-13 with the vendored bytes — not a stub.
// A known ISBN is rendered to an in-memory RGBA image with a hand-rolled
// EAN-13 encoder, then read back through js/vendor/zxing/es/reader.js +
// zxing_reader.wasm exactly as vendored. Node cannot fetch() a bare file
// path the way a browser fetches the wasm over HTTP, so the module is
// prepared with a wasmBinary override read from the same vendored file —
// the bytes under test are identical either way.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = process.env.BOOKTOK_DIR || path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'js', 'vendor', 'zxing');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

function ean13ImageData(code) {
  const d = code.split('').map(Number);
  let bits = '101';
  const par = PARITY[d[0]];
  for (let i = 1; i <= 6; i++) bits += (par[i - 1] === 'L' ? L : G)[d[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[d[i]];
  bits += '101';
  const MOD = 4, QUIET = 12, H = 200;
  const W = (bits.length + QUIET * 2) * MOD;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let x = 0; x < bits.length; x++) {
    if (bits[x] !== '1') continue;
    for (let px = 0; px < MOD; px++) {
      const col = (QUIET + x) * MOD + px;
      for (let y = 0; y < H; y++) {
        const o = (y * W + col) * 4;
        data[o] = data[o + 1] = data[o + 2] = 0; data[o + 3] = 255;
      }
    }
  }
  return { data, width: W, height: H };
}

(async () => {
  ok('vendored reader glue exists', fs.existsSync(path.join(VENDOR, 'es', 'reader.js')));
  ok('vendored share module exists', fs.existsSync(path.join(VENDOR, 'share.js')));
  ok('vendored reader wasm exists', fs.existsSync(path.join(VENDOR, 'zxing_reader.wasm')));
  ok('vendored reader wasm is the full build (>900 KB)',
    fs.existsSync(path.join(VENDOR, 'zxing_reader.wasm')) && fs.statSync(path.join(VENDOR, 'zxing_reader.wasm')).size > 900000);
  const glue = fs.readFileSync(path.join(VENDOR, 'es', 'reader.js'), 'utf8') +
    fs.readFileSync(path.join(VENDOR, 'share.js'), 'utf8');
  ok('vendored zxing glue carries no CDN reference', !/jsdelivr|unpkg\.com|cdnjs/.test(glue));

  const mod = await import(pathToFileURL(path.join(VENDOR, 'es', 'reader.js')).href);
  ok('vendored module reports zxing-wasm 3.1.5', mod.ZXING_WASM_VERSION === '3.1.5');
  mod.prepareZXingModule({
    overrides: { wasmBinary: fs.readFileSync(path.join(VENDOR, 'zxing_reader.wasm')) },
    fireImmediately: true,
  });

  const ISBN = '9780349437064';
  const results = await mod.readBarcodes(ean13ImageData(ISBN),
    { formats: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E'] });
  ok('decodes the generated EAN-13 exactly',
    results.length === 1 && results[0].text === ISBN);
  ok('decoded result is a valid read', results.length === 1 && results[0].isValid === true);

  const none = await mod.readBarcodes(ean13ImageData(ISBN), { formats: ['QR Code'] });
  ok('format restriction excludes the EAN-13 when not requested', none.length === 0);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH:', e); process.exit(1); });
