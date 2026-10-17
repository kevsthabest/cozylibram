// Loader self-test fixture: the plain importer. Reads one value export,
// one function export, and one accessor-published export from the
// dependency, through bare imported names — the shape the successor
// pass's wiring produces. Its own readers are bridge-published so the
// suite can call them from outside the window.
import { fixtureValue, fixtureGreet, fixtureLive } from './zz-loader-dep.js';

export function readFixtureValue() { return fixtureValue; }
export function readFixtureGreet() { return fixtureGreet('loader'); }
export function readFixtureLive() { return fixtureLive; }

window.readFixtureValue = readFixtureValue;
window.readFixtureGreet = readFixtureGreet;
window.readFixtureLive = readFixtureLive;
