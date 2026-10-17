// Loader self-test fixture: the dependency. Its shape mirrors a converted
// production file exactly — named exports in place (a value, a function,
// and a let) plus a bridge block republishing the surface on window, with
// the let republished as an accessor (the ADR-003 pattern) so reads and
// writes forward to the module binding instead of copying a value.
//
// The zz- prefix is deliberate: directory order would load this file
// AFTER the aa-/ab-/ac- importers, so the self-test can only pass if the
// loader really does load dependencies first.
export const fixtureValue = 'loader-dep-value';
export function fixtureGreet(name) { return 'hello, ' + name; }
export let fixtureLive = 'initial';
export function fixtureSetLive(v) { fixtureLive = v; }

// Bridge block: republish the surface, as production files do.
window.fixtureValue = fixtureValue;
window.fixtureGreet = fixtureGreet;
Object.defineProperty(window, 'fixtureLive', { get: () => fixtureLive, set: (v) => { fixtureLive = v; }, enumerable: true, configurable: true });
window.fixtureSetLive = fixtureSetLive;
