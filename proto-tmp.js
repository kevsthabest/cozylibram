const { JSDOM } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
require('/home/hatch/workspace/booktok/.test/harness').loadApp(window);
const run = (js) => window.eval(js);

const proto = `
function sobelXY(g, w, h) {
  var gx = new Uint16Array(w*h), gy = new Uint16Array(w*h);
  for (var y = 1; y < h-1; y++) for (var x = 1; x < w-1; x++) {
    var i = y*w+x;
    gx[i] = Math.abs(-g[i-w-1]-2*g[i-1]-g[i+w-1]+g[i-w+1]+2*g[i+1]+g[i+w+1]);
    gy[i] = Math.abs(-g[i-w-1]-2*g[i-w]-g[i-w+1]+g[i+w-1]+2*g[i+w]+g[i+w+1]);
  }
  return { gx: gx, gy: gy };
}
function projDetectTall(gray, w, h, roi) {
  var blur = ecBlur3(gray, w, h);
  var sxy = sobelXY(blur, w, h), gx = sxy.gx, gy = sxy.gy;
  var x0 = Math.max(1, Math.floor(roi.x)), x1 = Math.min(w-2, Math.ceil(roi.x+roi.w));
  var y0 = Math.max(1, Math.floor(roi.y)), y1 = Math.min(h-2, Math.ceil(roi.y+roi.h));
  var rw = x1-x0, rh = y1-y0;
  if (rw < 12 || rh < 30) return null;
  var col = new Float64Array(rw), x, y;
  for (x = 0; x < rw; x++) { var s = 0; for (y = 0; y < rh; y++) s += gx[(y0+y)*w+x0+x]; col[x] = s; }
  // smooth radius 2
  var sm = new Float64Array(rw);
  for (x = 0; x < rw; x++) { var a = Math.max(0,x-2), b = Math.min(rw-1,x+2), t2=0; for (var k=a;k<=b;k++) t2+=col[k]; sm[x]=t2/(b-a+1); }
  function isPeak(i) { for (var k=Math.max(0,i-3);k<=Math.min(rw-1,i+3);k++) if (sm[k]>sm[i]) return false; return true; }
  var minW = Math.round(rw*0.30), bl=-1, br=-1, bs=0;
  for (var l = 0; l < rw; l++) { if (!isPeak(l)) continue;
    for (var r = l+minW; r < rw; r++) { if (!isPeak(r)) continue;
      var sc = sm[l]+sm[r]; if (sc > bs) { bs=sc; bl=l; br=r; } } }
  if (bl < 0) return { why: 'no-peak-pair' };
  var strength = bs / (rh * 1020 * 2);
  // row profile of |gy| between the columns; prefer rows whose edge is
  // concentrated between the columns (book edge) over full-width lines
  var L = x0+bl, R = x0+br;
  var bestT=-1, bestTs=0, bestB=-1, bestBs=0;
  for (y = 0; y < rh; y++) {
    var inner=0, outer=0, yy=(y0+y)*w;
    for (x = 0; x < rw; x++) { var v=gy[yy+x0+x]; if (x>=bl&&x<=br) inner+=v; else outer+=v; }
    var score = inner - 0.5*outer*( (br-bl+1) / Math.max(1,(rw-(br-bl+1))) );
    if (y < rh*0.45 && score > bestTs) { bestTs=score; bestT=y; }
    if (y > rh*0.55 && score > bestBs) { bestBs=score; bestB=y; }
  }
  return { l: L, r: R, t: y0+bestT, b: y0+bestB, strength: strength,
           tScore: bestTs, bScore: bestBs, rh: rh, rw: rw };
}
`;

[['/tmp/kv2.json','kv2-wood'], ['/tmp/frame19.json','frame19-monitor'], ['/tmp/frame3.json','frame3-flash']].forEach(function (pair) {
  var d;
  try { d = JSON.parse(fs.readFileSync(pair[0], 'utf8')); }
  catch (e) { console.log(pair[1], 'missing file'); return; }
  window.__px = d.px; window.__w = d.w; window.__h = d.h;
  // ROI: kv2 has its own measured roi; frame19/frame3 use the tall-guide math roi
  window.__roi = d.roi || { x: 90, y: 89, w: 60, h: 249 };
  var out = run(proto + `
    (function () {
      var gray = new Uint8ClampedArray(window.__px);
      var r = projDetectTall(gray, window.__w, window.__h, window.__roi);
      if (!r || !r.l) return JSON.stringify(r);
      var w0 = r.r - r.l, h0 = r.b - r.t;
      r.w = w0; r.h = h0; r.asp = (h0/w0).toFixed(2);
      r.strength = +r.strength.toFixed(3);
      return JSON.stringify(r);
    })()`);
  console.log(pair[1], '->', out);
});
process.exit(0);
