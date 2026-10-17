// Loader self-test fixture: the aliasing importer. Exercises the two
// import shapes a shared global scope cannot resolve unaided — an
// aliased import (the local name exists nowhere until the loader binds
// it) and a namespace import (a live view over the dependency's exports,
// not a snapshot of them).
import { fixtureValue as aliasedValue, fixtureLive as aliasedLive } from './zz-loader-dep.js';
import * as depNs from './zz-loader-dep.js';

export function readAliasedValue() { return aliasedValue; }
export function readAliasedLive() { return aliasedLive; }
export function writeAliasedLive(v) { aliasedLive = v; }
export function readNsValue() { return depNs.fixtureValue; }
export function readNsLive() { return depNs.fixtureLive; }
export function fixtureDepNs() { return depNs; }

window.readAliasedValue = readAliasedValue;
window.readAliasedLive = readAliasedLive;
window.writeAliasedLive = writeAliasedLive;
window.readNsValue = readNsValue;
window.readNsLive = readNsLive;
window.fixtureDepNs = fixtureDepNs;
