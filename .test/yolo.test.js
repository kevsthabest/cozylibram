#!/usr/bin/env node
/* Unit tests for js/211-yolo.js: NMS, guide selection, ensemble. */
const fs = require('fs');
const src = fs.readFileSync('/home/hatch/workspace/booktok/js/211-yolo.js', 'utf8');
const stub = 'var document = undefined; var ort = undefined; ';
const run = (expr) => new Function(stub + src + '\nreturn (' + expr + ');')();

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('PASS -', name); }
  else { fail++; console.log('FAIL -', name); }
};

ok('nms suppresses overlap',
  JSON.stringify(run('ecYoloNms([[0,0,10,10],[1,1,11,11],[50,50,60,60]], [0.9,0.8,0.7])')) === '[0,2]');

ok('iou identical = 1',
  Math.abs(run('ecQuadIoU([[0,0],[10,0],[10,10],[0,10]], [[0,0],[10,0],[10,10],[0,10]])') - 1) < 0.001);

ok('iou disjoint = 0',
  run('ecQuadIoU([[0,0],[10,0],[10,10],[0,10]], [[20,20],[30,20],[30,30],[20,30]])') === 0);

ok('best-for-guide ignores class',
  run(`ecYoloBestForGuide([
    { box: [0,0,10,10], conf: 0.9, cls: 27, maskBox: null },
    { box: [45,45,65,65], conf: 0.5, cls: 36, maskBox: [47,47,63,63] }
  ], { x: 40, y: 40, w: 30, h: 30 }).cls`) === 36);

ok('ensemble keeps edge on agreement',
  JSON.stringify(run(`ecEnsembleQuad([[0,0],[10,0],[10,10],[0,10]], [[0,0],[10,0],[10,10],[0,10]])`)) ===
  '[[0,0],[10,0],[10,10],[0,10]]');

ok('ensemble trusts yolo on disagreement',
  JSON.stringify(run(`ecEnsembleQuad([[0,0],[10,0],[10,10],[0,10]], [[50,50],[60,50],[60,60],[50,60]])`)) ===
  '[[50,50],[60,50],[60,60],[50,60]]');

ok('ensemble falls back to edge alone',
  JSON.stringify(run(`ecEnsembleQuad([[0,0],[10,0],[10,10],[0,10]], null)`)) === '[[0,0],[10,0],[10,10],[0,10]]');

ok('ensemble null when both fail', run(`ecEnsembleQuad(null, null)`) === null);

ok('yoloQuad prefers maskBox',
  JSON.stringify(run(`ecYoloQuad({ box: [0,0,20,20], maskBox: [2,3,18,19] })`)) === '[[2,3],[18,3],[18,19],[2,19]]');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
