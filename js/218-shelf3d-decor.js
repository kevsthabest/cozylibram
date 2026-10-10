'use strict';

/* ---- 218-shelf3d-decor.js: 3D shelf decoration catalog (v406) ----
   Single source of truth for shelf decorations: catalog entries, per-theme
   recommended sets, and per-theme preset arrangements.

   Catalog format per entry:
     id      — stable key used by presets, sets, and the engine inventory
     name    — display name in the inventory
     build   — builder key (DECO_MAKERS / ROOM_MAKERS in js/215-shelf3d.js)
     room    — true for room decorations (inventory Room tab, free placement);
               'wall' items pin to the back wall, floor items sit on the floor
     mount   — for room items: 'wall' | 'floor' (placement plane)
     premium — premium-tier flag. INTERNAL ONLY during alpha: everything stays
               unlocked and usable; no paywall enforcement yet. The flag
               establishes the entitlement structure for later.
     stock   — initial inventory count per session
     svg     — 30x30 inventory icon

   SETS: theme key -> recommended decoration ids (UI Designer fit table).
   PRESETS: theme key -> placements. Each placement:
     { deco, pi, x }                  — shelf plank (pi 0=bottom..2=top)
     { deco, room:true, x, y, z }     — room decoration (wall or floor)
     Optional: tint (wax/bulb/flower hex), tint2 (secondary hex),
               variant (named palette, e.g. vase:'harvest').

   Behavior contract (with js/215-shelf3d.js):
   - Switching app theme NEVER auto-rearranges decorations mid-session.
   - Mounting with an empty shelf auto-applies the current theme's preset
     (decorations are session-only, so "empty shelf" == every fresh mount).
   - The "Dress shelf for <theme>" button applies the preset on explicit tap
     (with confirm when decorations exist, toggleable back). */

window.Shelf3DDecor = (function () {

  var CATALOG = [
    /* ---- core shelf set ---- */
    { id: 'plant', name: 'Plant', build: 'plant', stock: 3, premium: false,
      svg: '<svg viewBox="0 0 30 30"><path d="M10 22 L20 22 L18 28 L12 28 Z" fill="#a85f32"/><path d="M15 22 C15 14 12 10 6 8 C12 8 14 12 15 16 C16 12 18 8 24 8 C18 10 15 14 15 22" fill="#4a7a3a"/></svg>' },
    { id: 'candle', name: 'Candle', build: 'candle', stock: 5, premium: false,
      svg: '<svg viewBox="0 0 30 30"><rect x="12" y="13" width="6" height="12" rx="1" fill="#e8dcc8"/><ellipse cx="15" cy="13" rx="3" ry="1.4" fill="#d8cbb2"/><path d="M15 4 C17 8 17.5 10 15 12 C12.5 10 13 8 15 4" fill="#ff9a2a"/></svg>' },
    { id: 'mug', name: 'Mug', build: 'mug', stock: 2, premium: false,
      svg: '<svg viewBox="0 0 30 30"><rect x="8" y="12" width="11" height="13" rx="2" fill="#b5542a"/><path d="M19 15 c4 0 4 7 0 7" stroke="#b5542a" stroke-width="2.6" fill="none"/></svg>' },
    { id: 'stack', name: 'Book stack', build: 'stack', stock: 4, premium: false,
      svg: '<svg viewBox="0 0 30 30"><rect x="6" y="20" width="18" height="5" rx="1" fill="#7a4a5a"/><rect x="7" y="15" width="16" height="5" rx="1" fill="#3a5a7a"/><rect x="6" y="10" width="18" height="5" rx="1" fill="#8a6a2a"/></svg>' },
    { id: 'lights', name: 'Fairy lights', build: 'lights', stock: 2, premium: false,
      svg: '<svg viewBox="0 0 30 30"><path d="M3 8 Q15 18 27 8" stroke="#5a4a3a" stroke-width="1.4" fill="none"/><circle cx="8" cy="11.5" r="1.8" fill="#ffcf7a"/><circle cx="15" cy="13" r="1.8" fill="#ffcf7a"/><circle cx="22" cy="11.5" r="1.8" fill="#ffcf7a"/></svg>' },
    { id: 'clock', name: 'Clock', build: 'clock', stock: 1, premium: false,
      svg: '<svg viewBox="0 0 30 30"><rect x="8" y="5" width="14" height="17" rx="2" fill="#5a3a22"/><circle cx="15" cy="13.5" r="5.5" fill="#f2e8d5"/><path d="M15 13.5 L15 10 M15 13.5 L18 14.5" stroke="#2a2018" stroke-width="1.4"/></svg>' },
    { id: 'photo', name: 'Photo frame', build: 'photo', stock: 2, premium: false,
      svg: '<svg viewBox="0 0 30 30"><rect x="8" y="5" width="14" height="18" rx="1" fill="#8a6a3a"/><rect x="10.5" y="7.5" width="9" height="13" fill="#2a3a5a"/><circle cx="18" cy="11" r="2" fill="#f6eff8"/></svg>' },
    { id: 'succulent', name: 'Succulent', build: 'succulent', stock: 3, premium: false,
      svg: '<svg viewBox="0 0 30 30"><path d="M11 20 L19 20 L17.5 26 L12.5 26 Z" fill="#7a8a9a"/><path d="M15 20 C15 15 13 12 9 11 C13 11 14 14 15 17 C16 14 17 11 21 11 C17 12 15 15 15 20" fill="#6a9a7a"/></svg>' },
    /* unlocked per Kevin's approval (were locked behind place-counts) */
    { id: 'lantern', name: 'Lantern', build: 'lantern', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><rect x="10" y="8" width="10" height="14" rx="3" fill="#3a3a4a"/><circle cx="15" cy="15" r="3" fill="#ffcf7a" opacity=".8"/></svg>' },
    { id: 'globe', name: 'Globe', build: 'globe', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><circle cx="15" cy="14" r="8" fill="#3a5a7a"/><path d="M15 6 a8 8 0 0 1 0 16" fill="#4a7a3a"/><rect x="13" y="22" width="4" height="4" fill="#5a3a22"/></svg>' },
    /* ---- room decorations ---- */
    { id: 'web', name: 'Spiderweb', build: 'web', room: true, mount: 'wall', stock: 2, premium: false,
      svg: '<svg viewBox="0 0 30 30"><g stroke="#cfd6e4" stroke-width="1" fill="none" opacity=".85"><circle cx="15" cy="15" r="4"/><circle cx="15" cy="15" r="8"/><circle cx="15" cy="15" r="12"/><path d="M15 3 V27 M3 15 H27 M6.5 6.5 L23.5 23.5 M23.5 6.5 L6.5 23.5"/></g><circle cx="19" cy="19" r="1.6" fill="#1a1420"/></svg>' },
    { id: 'pumpkin', name: 'Pumpkin', build: 'pumpkin', room: true, mount: 'floor', stock: 2, premium: false,
      svg: '<svg viewBox="0 0 30 30"><ellipse cx="15" cy="18" rx="9" ry="7" fill="#c25a1e"/><rect x="14" y="8" width="2.4" height="5" rx="1" fill="#4a5a2a"/></svg>' },
    /* ---- P0 new builds ---- */
    { id: 'vase', name: 'Stems vase', build: 'vase', stock: 2, premium: false,
      variants: {
        amour:    { flower: '#e5488f', stem: '#4a7a3a' },
        velvet:   { flower: '#d43a55', stem: '#3a5a2a' },
        pastel:   { flower: '#b9a3f2', stem: '#6a9a7a' },
        harvest:  { flower: '#c08a24', stem: '#8a6a2a' },
        frost:    { flower: '#dfe8f2', stem: '#4a7a5a' },
        yuletide: { flower: '#d43a55', stem: '#2a6a3a' },
      },
      svg: '<svg viewBox="0 0 30 30"><path d="M11 16 h8 l-1.5 10 h-5 Z" fill="#7a8a9a"/><path d="M15 16 C15 10 13 8 10 6 M15 16 C15 9 16 7 19 5 M15 16 V4" stroke="#4a7a3a" stroke-width="1.6" fill="none"/><circle cx="10" cy="5" r="2.4" fill="#e5488f"/><circle cx="19" cy="4" r="2.4" fill="#e5488f"/><circle cx="15" cy="3" r="2.4" fill="#f2a3c0"/></svg>' },
    { id: 'moon', name: 'Crescent moon', build: 'moon', room: true, mount: 'wall', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><path d="M20 4 A11 11 0 1 0 20 26 A13.5 13.5 0 1 1 20 4" fill="#dfe8ff"/></svg>' },
    { id: 'stargarland', name: 'Star garland', build: 'stargarland', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><path d="M3 8 Q15 18 27 8" stroke="#5a4a3a" stroke-width="1.4" fill="none"/><path d="M8 9 l1.2 2.4 2.6.4 -1.9 1.9 .5 2.6 -2.4-1.2 -2.4 1.2 .5-2.6 -1.9-1.9 2.6-.4 Z" fill="#cfe0ff"/><path d="M15 10.5 l1.2 2.4 2.6.4 -1.9 1.9 .5 2.6 -2.4-1.2 -2.4 1.2 .5-2.6 -1.9-1.9 2.6-.4 Z" fill="#cfe0ff"/><path d="M22 9 l1.2 2.4 2.6.4 -1.9 1.9 .5 2.6 -2.4-1.2 -2.4 1.2 .5-2.6 -1.9-1.9 2.6-.4 Z" fill="#cfe0ff"/></svg>' },
    { id: 'gifts', name: 'Gift boxes', build: 'gifts', stock: 2, premium: false,
      svg: '<svg viewBox="0 0 30 30"><rect x="6" y="16" width="12" height="9" fill="#d43a55"/><rect x="11" y="16" width="2.4" height="9" fill="#f2d06a"/><rect x="6" y="19.5" width="12" height="2.4" fill="#f2d06a"/><rect x="14" y="8" width="10" height="8" fill="#2a6a3a"/><rect x="18" y="8" width="2" height="8" fill="#f2d06a"/></svg>' },
    { id: 'eggs', name: 'Painted eggs', build: 'eggs', stock: 1, premium: false,
      svg: '<svg viewBox="0 0 30 30"><ellipse cx="9" cy="12" rx="3.4" ry="4.4" fill="#f2a3c0"/><ellipse cx="16" cy="10" rx="3.4" ry="4.4" fill="#b9a3f2"/><ellipse cx="22" cy="13" rx="3.4" ry="4.4" fill="#a8d8c8"/><path d="M5 20 h20 l-2.5 6 h-15 Z" fill="#8a6a4a"/></svg>' },
    { id: 'snowflake', name: 'Snowflake', build: 'snowflake', room: true, mount: 'wall', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><g stroke="#bfe0ff" stroke-width="1.8"><path d="M15 4 V26 M5.5 9.5 L24.5 20.5 M24.5 9.5 L5.5 20.5"/></g><circle cx="15" cy="15" r="2.2" fill="none" stroke="#bfe0ff" stroke-width="1.4"/></svg>' },
    /* ---- P1 new builds ---- */
    { id: 'coins', name: 'Gold coin stack', build: 'coins', stock: 2, premium: false,
      svg: '<svg viewBox="0 0 30 30"><ellipse cx="15" cy="22" rx="7" ry="2.6" fill="#c08a24"/><ellipse cx="15" cy="19" rx="7" ry="2.6" fill="#d8a83a"/><ellipse cx="15" cy="16" rx="7" ry="2.6" fill="#f2d06a"/><ellipse cx="15" cy="13" rx="7" ry="2.6" fill="#f2d06a"/></svg>' },
    { id: 'clover', name: 'Clover', build: 'clover', stock: 2, premium: false,
      svg: '<svg viewBox="0 0 30 30"><circle cx="11" cy="12" r="4" fill="#2a8a4a"/><circle cx="19" cy="12" r="4" fill="#2a8a4a"/><circle cx="15" cy="17" r="4" fill="#35a055"/><path d="M15 20 C15 23 14 25 12 27" stroke="#2a8a4a" stroke-width="1.6" fill="none"/></svg>' },
    { id: 'applebowl', name: 'Apple bowl', build: 'applebowl', stock: 1, premium: false,
      svg: '<svg viewBox="0 0 30 30"><ellipse cx="11" cy="12" rx="3.6" ry="3.2" fill="#c0392b"/><ellipse cx="18" cy="11" rx="3.6" ry="3.2" fill="#d43a55"/><ellipse cx="15" cy="15" rx="3.6" ry="3.2" fill="#e05252"/><path d="M6 18 h18 l-3 7 h-12 Z" fill="#8a6a4a"/></svg>' },
    /* ---- v423: premium theme packs (all premium:true, unlocked in alpha) ---- */
    /* Stormrider */
    { id: 'dragon-egg', name: 'Dragon egg', build: 'dragonEgg', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><path d="M15 4 C21 4 25 12 25 19 C25 24 20 27 15 27 C10 27 5 24 5 19 C5 12 9 4 15 4Z" fill="#3a4a6a"/><path d="M10 14 Q13 11 16 14 M14 19 Q17 16 20 19" stroke="#7fb3e8" stroke-width="1.2" fill="none"/></svg>' },
    { id: 'storm-lantern', name: 'Storm lantern', build: 'stormLantern', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><rect x="10" y="8" width="10" height="14" rx="2" fill="#2a2a3a"/><path d="M16 11 L12 17 L14.5 17 L13.5 21 L18 15 L15.5 15 Z" fill="#e8a94e"/></svg>' },
    { id: 'rider-blade', name: 'Rider blade', build: 'riderBlade', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><path d="M15 3 L17 8 L16 20 L15 24 L14 20 L13 8 Z" fill="#b8c4d4"/><path d="M15 20 C11 17 7 16 4 16 C8 18 12 20 15 22 C18 20 22 18 26 16 C23 16 19 17 15 20Z" fill="#7fb3e8"/></svg>' },
    /* Briarthrone */
    { id: 'thorn-crown', name: 'Thorn crown', build: 'thornCrown', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><ellipse cx="15" cy="20" rx="9" ry="3" fill="none" stroke="#8a6a5a" stroke-width="2"/><path d="M8 18 L6 10 L10 16 M14 17 L14 8 L17 15 M20 17 L22 9 L24 16" stroke="#8a6a5a" stroke-width="1.6" fill="none"/></svg>' },
    { id: 'moon-goblet', name: 'Moon goblet', build: 'moonGoblet', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><path d="M10 6 L20 6 C20 13 18 16 15 16 C12 16 10 13 10 6Z" fill="#4a3a5a"/><path d="M15 22 L15 26 M12 26 L18 26" stroke="#4a3a5a" stroke-width="2"/><path d="M16 9 C14 10.5 14 12.5 16 14 C15 12.5 15 10.5 16 9Z" fill="#dfe8ff"/></svg>' },
    { id: 'night-bloom', name: 'Night bloom', build: 'nightBloom', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><g fill="#c9b3f5"><ellipse cx="15" cy="8" rx="2.5" ry="5"/><ellipse cx="21" cy="13" rx="2.5" ry="5" transform="rotate(60 21 13)"/><ellipse cx="9" cy="13" rx="2.5" ry="5" transform="rotate(-60 9 13)"/></g><circle cx="15" cy="14" r="2.4" fill="#e0637f"/><path d="M15 17 L15 26" stroke="#4a7a3a" stroke-width="1.6"/></svg>' },
    /* Voidsignal */
    { id: 'holo-cube', name: 'Holo cube', build: 'holoCube', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><g fill="none" stroke="#38e1ff" stroke-width="1.4"><path d="M15 6 L24 11 L24 20 L15 25 L6 20 L6 11 Z"/><path d="M15 6 L15 15.5 L24 20 M15 15.5 L6 20"/></g><circle cx="15" cy="15.5" r="2.4" fill="#38e1ff"/></svg>' },
    { id: 'signal-dish', name: 'Signal dish', build: 'signalDish', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><path d="M8 12 C10 19 16 22 24 22 C18 18 14 14 12 8Z" fill="#3a4a5a"/><path d="M15 22 L15 27 M12 27 L18 27" stroke="#3a4a5a" stroke-width="2"/><circle cx="22" cy="8" r="2" fill="#38e1ff"/></svg>' },
    { id: 'data-core', name: 'Data core', build: 'dataCore', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><ellipse cx="15" cy="8" rx="7" ry="2.4" fill="none" stroke="#38e1ff" stroke-width="1.6"/><path d="M8 8 L8 22 M22 8 L22 22" stroke="#38e1ff" stroke-width="1.6"/><ellipse cx="15" cy="22" rx="7" ry="2.4" fill="#38e1ff" opacity="0.5"/></svg>' },
    /* Wisp */
    { id: 'mushroom-cottage', name: 'Mushroom cottage', build: 'mushroomCottage', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><path d="M15 3 C8 3 4 8 3 13 C7 11 11 11 15 11 C19 11 23 11 27 13 C26 8 22 3 15 3Z" fill="#e86a92"/><circle cx="11" cy="8" r="1.6" fill="#fdf6ec"/><circle cx="18" cy="7" r="2" fill="#fdf6ec"/><rect x="11" y="12" width="8" height="10" rx="1" fill="#f7ecd8"/><rect x="13.5" y="15" width="3" height="7" rx="1" fill="#8a6a4a"/></svg>' },
    { id: 'firefly-jar', name: 'Firefly jar', build: 'fireflyJar', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><rect x="10" y="7" width="10" height="16" rx="3" fill="none" stroke="#8a7a68" stroke-width="1.6"/><circle cx="14" cy="14" r="1.8" fill="#ffd76a"/><circle cx="17" cy="18" r="2.2" fill="#ffd76a"/><circle cx="15" cy="21" r="1.4" fill="#ffd76a"/></svg>' },
    { id: 'wisp-lantern', name: 'Wisp lantern', build: 'wispLantern', stock: 1, premium: true,
      svg: '<svg viewBox="0 0 30 30"><circle cx="15" cy="14" r="8" fill="#fdf6ec" stroke="#e86a92" stroke-width="1.4"/><path d="M15 22 L15 26 M12 26 L18 26" stroke="#8a7a68" stroke-width="1.6"/><path d="M15 8 l1 2.6 2.6 1 -2.6 1 -1 2.6 -1-2.6 -2.6-1 2.6-1z" fill="#e86a92"/></svg>' },
  ];

  var byId = {};
  CATALOG.forEach(function (d) { byId[d.id] = d; });

  /* Per-theme recommended sets (UI Designer fit table, Q1). */
  var SETS = {
    dark:        ['candle', 'lights', 'stack', 'mug', 'photo'],
    light:       ['plant', 'succulent', 'photo', 'stack', 'mug'],
    hearthside:  ['lantern', 'candle', 'mug', 'stack'],
    candlelight: ['candle', 'lights', 'photo'],
    twilight:    ['globe', 'lights', 'plant', 'clock'],
    verdant:     ['plant', 'succulent', 'stack', 'clover'],
    midnight:    ['stargarland', 'globe', 'candle', 'moon'],
    velvet:      ['candle', 'photo', 'stack', 'vase'],
    abyss:       ['globe', 'lights', 'candle', 'stack'],
    frost:       ['candle', 'stack', 'lights', 'snowflake', 'vase'],
    haunt:       ['pumpkin', 'web', 'candle', 'lantern'],
    yuletide:    ['lights', 'candle', 'stack', 'gifts', 'vase'],
    fete:        ['clock', 'lights', 'photo', 'stargarland'],
    amour:       ['candle', 'photo', 'lights', 'stack', 'vase'],
    shamrock:    ['plant', 'candle', 'mug', 'stack', 'coins', 'clover'],
    pastel:      ['succulent', 'lights', 'plant', 'photo', 'eggs', 'vase'],
    harvest:     ['pumpkin', 'lights', 'stack', 'mug', 'vase', 'applebowl'],
    /* v423: premium packs */
    stormrider:  ['dragon-egg', 'storm-lantern', 'rider-blade', 'candle', 'stack'],
    briarthrone: ['thorn-crown', 'moon-goblet', 'night-bloom', 'candle', 'photo'],
    voidsignal:  ['holo-cube', 'signal-dish', 'data-core', 'lights', 'globe'],
    wisp:        ['mushroom-cottage', 'firefly-jar', 'wisp-lantern', 'succulent', 'lights'],
    'wisp-night':['firefly-jar', 'wisp-lantern', 'mushroom-cottage', 'moon', 'lights'],
  };

  /* Per-theme preset arrangements. pi: 0 bottom, 1 middle, 2 top edge.
     Harvest carries the Autumn cozy north-star arrangement. */
  var PRESETS = {
    dark: [
      { deco: 'candle', pi: 1, x: 4.15 },
      { deco: 'lights', pi: 2, x: 0 },
      { deco: 'stack', pi: 0, x: 4.15 },
      { deco: 'mug', pi: 0, x: 2.9 },
      { deco: 'photo', pi: 1, x: 2.4 },
    ],
    light: [
      { deco: 'plant', pi: 1, x: -3.2 },
      { deco: 'succulent', pi: 1, x: 3.4 },
      { deco: 'photo', pi: 0, x: 2.9 },
      { deco: 'stack', pi: 0, x: -3.4 },
      { deco: 'mug', pi: 1, x: 4.1 },
    ],
    hearthside: [
      { deco: 'lantern', pi: 1, x: 3.8 },
      { deco: 'candle', pi: 1, x: -3.6 },
      { deco: 'mug', pi: 0, x: 2.9 },
      { deco: 'stack', pi: 0, x: -3.4 },
    ],
    candlelight: [
      { deco: 'candle', pi: 1, x: -2.5 },
      { deco: 'candle', pi: 1, x: 2.5, tint: '#f2d06a' },
      { deco: 'lights', pi: 2, x: 0, tint: '#ffd98a' },
      { deco: 'photo', pi: 0, x: 3.0 },
    ],
    twilight: [
      { deco: 'globe', pi: 1, x: 3.6 },
      { deco: 'lights', pi: 2, x: 0, tint: '#9aa8ff' },
      { deco: 'plant', pi: 0, x: -3.2 },
      { deco: 'clock', pi: 1, x: -3.8 },
    ],
    verdant: [
      { deco: 'plant', pi: 0, x: -3.4 },
      { deco: 'succulent', pi: 0, x: 3.4 },
      { deco: 'plant', pi: 1, x: -3.0 },
      { deco: 'clover', pi: 0, x: 0.5 },
      { deco: 'stack', pi: 1, x: 3.6 },
    ],
    midnight: [
      { deco: 'stargarland', pi: 2, x: 0 },
      { deco: 'globe', pi: 1, x: 3.6 },
      { deco: 'candle', pi: 1, x: -3.4, tint: '#bfe0e0' },
      { deco: 'moon', room: true, x: 4.2, y: 5.6 },
    ],
    velvet: [
      { deco: 'candle', pi: 1, x: 3.8, tint: '#7a1f2e' },
      { deco: 'photo', pi: 1, x: -3.2 },
      { deco: 'stack', pi: 0, x: 3.4 },
      { deco: 'vase', pi: 0, x: -3.0, variant: 'velvet' },
    ],
    abyss: [
      { deco: 'globe', pi: 0, x: 3.4 },
      { deco: 'lights', pi: 2, x: 0, tint: '#5fd0c0' },
      { deco: 'candle', pi: 1, x: -3.6, tint: '#bfe0e0' },
      { deco: 'stack', pi: 1, x: 3.8 },
    ],
    frost: [
      { deco: 'candle', pi: 1, x: 3.6, tint: '#f2f4f8' },
      { deco: 'stack', pi: 0, x: -3.2 },
      { deco: 'lights', pi: 2, x: 0, tint: '#bfe0ff' },
      { deco: 'snowflake', room: true, x: -4.2, y: 5.2 },
      { deco: 'vase', pi: 0, x: 3.2, variant: 'frost' },
    ],
    haunt: [
      { deco: 'pumpkin', room: true, x: 3.6, z: 2.4 },
      { deco: 'web', room: true, x: -4.2, y: 6.2 },
      { deco: 'candle', pi: 1, x: 3.6, tint: '#241a20', tint2: '#e0722a' },
      { deco: 'lantern', pi: 0, x: -3.2 },
    ],
    yuletide: [
      { deco: 'lights', pi: 2, x: 0, tint: '#ffc27a' },
      { deco: 'candle', pi: 1, x: 3.8, tint: '#c0392b' },
      { deco: 'stack', pi: 0, x: -3.2 },
      { deco: 'gifts', pi: 0, x: 3.2 },
      { deco: 'vase', pi: 1, x: -3.4, variant: 'yuletide' },
    ],
    fete: [
      { deco: 'clock', pi: 1, x: 0, variant: 'midnight' },
      { deco: 'stargarland', pi: 2, x: 0, tint: '#ffd98a' },
      { deco: 'photo', pi: 0, x: 3.2 },
      { deco: 'mug', pi: 0, x: -3.2 },
    ],
    amour: [
      { deco: 'candle', pi: 1, x: 3.6, tint: '#f2b8c8' },
      { deco: 'photo', pi: 1, x: -3.0 },
      { deco: 'lights', pi: 2, x: 0, tint: '#ffb8d0' },
      { deco: 'stack', pi: 0, x: 3.2 },
      { deco: 'vase', pi: 0, x: -3.2, variant: 'amour' },
    ],
    shamrock: [
      { deco: 'plant', pi: 1, x: -3.2 },
      { deco: 'candle', pi: 1, x: 3.6, tint: '#3fa055' },
      { deco: 'mug', pi: 0, x: 2.9 },
      { deco: 'stack', pi: 0, x: -3.4 },
      { deco: 'coins', pi: 1, x: 0.8 },
      { deco: 'clover', pi: 0, x: 0.6 },
    ],
    pastel: [
      { deco: 'succulent', pi: 1, x: 3.4 },
      { deco: 'lights', pi: 2, x: 0, tint: '#d8c8ff' },
      { deco: 'plant', pi: 1, x: -3.4 },
      { deco: 'photo', pi: 0, x: 2.9 },
      { deco: 'eggs', pi: 0, x: -2.9 },
      { deco: 'vase', pi: 0, x: 0.8, variant: 'pastel' },
    ],
    /* north star: the Autumn cozy arrangement, dressed for harvest */
    harvest: [
      { deco: 'lights', pi: 2, x: 0, tint: '#ffb84d' },
      { deco: 'plant', pi: 1, x: 3.0 },
      { deco: 'candle', pi: 1, x: 4.15 },
      { deco: 'mug', pi: 0, x: 2.9 },
      { deco: 'stack', pi: 0, x: 4.15 },
      { deco: 'pumpkin', room: true, x: 6.9, z: 2.0 },
      { deco: 'applebowl', pi: 1, x: -3.4 },
      { deco: 'vase', pi: 0, x: -4.0, variant: 'harvest' },
    ],
    solstice: [ // v416 (T6): bright summer day
      { deco: 'succulent', pi: 1, x: 3.4 },
      { deco: 'plant', pi: 1, x: -3.2 },
      { deco: 'globe', pi: 0, x: 4.0 },
      { deco: 'vase', pi: 0, x: -4.0 },
      { deco: 'mug', pi: 0, x: 2.9 },
      { deco: 'lights', pi: 2, x: 0, tint: '#ffe9a8' },
    ],
    /* v423: premium packs */
    stormrider: [
      { deco: 'dragon-egg', pi: 1, x: 3.6 },
      { deco: 'storm-lantern', pi: 1, x: -3.4 },
      { deco: 'rider-blade', pi: 0, x: 3.2 },
      { deco: 'candle', pi: 0, x: -3.2, tint: '#e8a94e' },
      { deco: 'stack', pi: 0, x: 0.5 },
    ],
    briarthrone: [
      { deco: 'thorn-crown', pi: 2, x: 0 },
      { deco: 'moon-goblet', pi: 1, x: 3.6 },
      { deco: 'night-bloom', pi: 1, x: -3.4 },
      { deco: 'candle', pi: 0, x: 3.2, tint: '#c9b3f5' },
      { deco: 'photo', pi: 0, x: -3.0 },
    ],
    voidsignal: [
      { deco: 'holo-cube', pi: 1, x: 0 },
      { deco: 'signal-dish', pi: 1, x: 3.6 },
      { deco: 'data-core', pi: 0, x: -3.2 },
      { deco: 'lights', pi: 2, x: 0, tint: '#38e1ff' },
      { deco: 'globe', pi: 0, x: 3.4 },
    ],
    wisp: [
      { deco: 'mushroom-cottage', pi: 0, x: -3.2 },
      { deco: 'firefly-jar', pi: 1, x: 3.6 },
      { deco: 'wisp-lantern', pi: 1, x: -3.6 },
      { deco: 'succulent', pi: 0, x: 3.2 },
      { deco: 'lights', pi: 2, x: 0, tint: '#ffd0e0' },
    ],
    'wisp-night': [
      { deco: 'firefly-jar', pi: 1, x: 0 },
      { deco: 'wisp-lantern', pi: 1, x: 3.6 },
      { deco: 'mushroom-cottage', pi: 0, x: -3.2 },
      { deco: 'moon', room: true, x: -4.2, y: 5.2 },
      { deco: 'lights', pi: 2, x: 0, tint: '#ffd76a' },
    ],
  };

  function setFor(themeKey) {
    return (SETS[themeKey] || SETS.dark).slice();
  }
  function presetFor(themeKey) {
    return (PRESETS[themeKey] || PRESETS.dark).map(function (p) {
      var c = {};
      for (var k in p) c[k] = p[k];
      return c;
    });
  }
  function get(id) { return byId[id] || null; }

  return {
    CATALOG: CATALOG,
    SETS: SETS,
    PRESETS: PRESETS,
    get: get,
    setFor: setFor,
    presetFor: presetFor,
  };
})();
