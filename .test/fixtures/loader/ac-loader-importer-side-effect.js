// Loader self-test fixture: the side-effect importer. Imports the
// dependency for its effects only (its bridge block republishing the
// surface), binding no names of its own.
import './zz-loader-dep.js';

export function readSideEffectValue() { return window.fixtureValue; }

window.readSideEffectValue = readSideEffectValue;
