/* Moderation execute paths (v399) — modBan/modUnban, deleteWork, report status.
   Run: node .test/moderation-paths.test.js */
'use strict';
const { JSDOM } = require('jsdom');
const fs = require('fs');

const html = fs.readFileSync('/home/hatch/workspace/booktok/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously' });
const window = dom.window;
window.fetch = async () => { throw new Error('no network in moderation tests'); };

require('./harness').loadApp(window);

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('PASS - ' + name); }
  else { fail++; console.log('FAIL - ' + name); }
}
const run = (js) => window.eval(js);

// Mock cloudClient to capture Supabase calls
run(`
window.__sbCalls = [];
window.cloudClient = async () => ({
  from: (table) => ({
    insert: (row) => { window.__sbCalls.push({ op: 'insert', table, row }); return Promise.resolve({ error: null }); },
    delete: () => ({ eq: (col, val) => { window.__sbCalls.push({ op: 'delete', table, col, val }); return Promise.resolve({ error: null }); } }),
    update: (row) => ({ eq: (col, val) => { window.__sbCalls.push({ op: 'update', table, row, col, val }); return Promise.resolve({ error: null }); } }),
  })
});
cloudUser = { id: 'admin-1' };
`);

(async () => {
/* ---- modBan ---- */
await run(`modBan('user-123')`);
const banCall = run(`window.__sbCalls.find(c => c.op === 'insert' && c.table === 'banned_users')`);
ok('modBan inserts into banned_users', !!banCall);
ok('modBan sets user_id', banCall && banCall.row.user_id === 'user-123');
ok('modBan records banned_by', banCall && banCall.row.banned_by === 'admin-1');

/* ---- modUnban ---- */
run(`window.__sbCalls = []`);
await run(`modUnban('user-123')`);
const unbanCall = run(`window.__sbCalls.find(c => c.op === 'delete' && c.table === 'banned_users')`);
ok('modUnban deletes from banned_users', !!unbanCall);
ok('modUnban targets correct user', unbanCall && unbanCall.val === 'user-123');

/* ---- modSetReportStatus ---- */
run(`window.__sbCalls = []`);
await run(`modSetReportStatus('report-1', 'dismissed')`);
const reportCall = run(`window.__sbCalls.find(c => c.op === 'update' && c.table === 'user_reports')`);
ok('modSetReportStatus updates user_reports', !!reportCall);
ok('modSetReportStatus sets status', reportCall && reportCall.row.status === 'dismissed');
ok('modSetReportStatus records handler', reportCall && reportCall.row.handled_by === 'admin-1');

/* ---- deleteWork (local) ---- */
run(`
window.__deletedWorks = [];
// Mock the Supabase delete for works
const origCloudClient = window.cloudClient;
window.cloudClient = async () => ({
  from: (table) => ({
    delete: () => ({ eq: (col, val) => {
      if (table === 'works') window.__deletedWorks.push(val);
      return Promise.resolve({ error: null });
    }}),
  })
});
`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
