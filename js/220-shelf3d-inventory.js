/* 220-shelf3d-inventory.js — pure inventory helpers for the 3D shelf.
   Extracted from js/215-shelf3d.js (v432 code-health split).

   Classic script, no modules. Exposes:
     window.Shelf3DInventory = {
       invItemInnerHTML(item),   // pure HTML for an inventory card's contents
       filterByTab(items, tab)   // pure tab filtering (shelf vs room)
     }

   The stateful buildInventory() stays in js/215-shelf3d.js; it calls these
   helpers so the pure logic is unit-testable. */

'use strict';

(function () {

  /* Inner HTML for an inventory card: icon SVG + name + owned count.
     Pure function of the item — no DOM, no state. */
  function invItemInnerHTML(item) {
    return item.svg + '<div>' + item.name + '</div>' +
      '<span class="cnt">\u00d7' + item.owned + '</span>';
  }

  /* Filter inventory items by tab. The 'room' tab shows room-placed
     decorations; the default tab shows shelf decorations.
     Pure function — extracted from buildInventory's filter. */
  function filterByTab(items, tab) {
    return items.filter(function (item) { return (tab === 'room') === !!item.room; });
  }

  window.Shelf3DInventory = {
    invItemInnerHTML: invItemInnerHTML,
    filterByTab: filterByTab
  };

})();
