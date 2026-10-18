// server.py regression harness: CI runs only .test/*.test.js, and the
// local mirror is Python — this wrapper runs the Python harness
// (.test/server_test.py, which boots the real server in-process) so the
// mirror's contracts gate like everything else. server.py is stdlib-only,
// so python3 alone suffices; when python3 is unavailable the suite skips
// (the avatars suites' probe precedent) rather than failing the run.
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = process.env.COZYLIBRAM_DIR || path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); };

const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.log('SKIP - python3 not available; server.py harness not run');
} else {
  const r = spawnSync('python3', [path.join(ROOT, '.test', 'server_test.py')], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  ok('python server harness (.test/server_test.py) green', r.status === 0);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
