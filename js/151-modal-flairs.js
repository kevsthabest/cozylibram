'use strict';

/* ---- 151-modal-flairs.js: book-modal thematic flair catalog (v418) ----
   Single source of truth for modal flairs: catalog entries, per-theme
   selection, and injection into the book modal.

   Catalog format per entry:
     id        — stable key, matches Asset/flairs/<id>.svg
     name      — display name
     motif     — motif key
     placement — 'vine' | 'corners' | 'divider' | 'garland' | 'watermark'
     themes    — theme keys this flair matches; '*' = every theme (fallback)
     file      — production SVG path (Asset/flairs/)
     svg       — inline SVG string (mirrors file; inlined so currentColor
                 tinting works — <img> can't inherit the page's currentColor)
     seasonal  — seasonal-theme flair (garlands)
     premium   — premium-tier flag. INTERNAL ONLY during alpha: everything
                 stays unlocked and usable; no paywall enforcement yet. The
                 flag establishes the entitlement structure for later
                 (same rule as the shelf decorations).

   Selection: flairFor(placement, theme) prefers an exact theme match, then
   the '*' fallback; free entries win ties over premium. flairsForTheme()
   resolves the full theme-matched set. Themes with no vine (fete, yuletide)
   get none — their seasonal garlands carry the look.

   Placements (all divider-proof by construction — nothing spans section
   backgrounds, so the old full-height-strip slicing bug can't recur):
     vine      — anchored inside .d-hero (position:relative), right side,
                 bottom fade via CSS mask; compact on mobile
     corners   — book-plate corners at the modal bottom corners, clear of the
                 hero vine
     divider   — hairline + centered motif in normal flow, injected between
                 the Details panel's section blocks
     garland   — hangs from the modal top edge (seasonal themes only)
     watermark — huge, faint, centered, atmospheric (premium)

   Behavior contract:
   - Theme-matched flairs auto-apply when the book modal renders.
   - Refresh on theme change (applyTheme calls ModalFlairs.refresh()).
   - Containers are aria-hidden (decorative); injected SVG ids are
     namespaced per instance so duplicate title/desc ids never collide.
   - All art is static — reduced-motion safe by construction.
   - Tinting: containers use color: var(--floral-tint); every asset is
     currentColor-only, so user accent changes can't break a flair. */

window.ModalFlairs = (function () {

var CATALOG = [
    { id: 'garland-haunt', name: 'Haunt garland', motif: 'haunt', placement: 'garland', signature: true,
      themes: ['haunt'], file: 'Asset/flairs/garland-haunt.svg', seasonal: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 90" role="img" aria-labelledby="t d">
<title id="t">Haunt garland</title>
<desc id="d">A twisted swag garland with hanging bats and mini pumpkins for Halloween.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M0,12 Q300,64 600,12"/>
<path d="M0,18 Q300,70 600,18" stroke-width="1.2" opacity="0.6"/>
<path d="M150,32 L150,44"/><path d="M300,38 L300,52"/><path d="M450,30 L450,42"/>
<path d="M225,36 L225,46"/><path d="M375,36 L375,46"/>
</g>
<g fill="currentColor" stroke="none">
<g transform="translate(150,54)"><path d="M-14,2 Q-9,-10 0,-3 Q9,-10 14,2 Q8,6 0,5 Q-8,6 -14,2Z"/><circle cx="0" cy="2" r="3"/></g>
<g transform="translate(300,64)"><path d="M-16,2 Q-10,-11 0,-3 Q10,-11 16,2 Q9,7 0,6 Q-9,7 -16,2Z"/><circle cx="0" cy="3" r="3.4"/></g>
<g transform="translate(450,52)"><path d="M-13,2 Q-8,-9 0,-3 Q8,-9 13,2 Q7,6 0,5 Q-7,6 -13,2Z"/><circle cx="0" cy="2" r="2.8"/></g>
<g transform="translate(225,58)">
<ellipse cx="0" cy="4" rx="9" ry="7"/><rect x="-1.5" y="-6" width="3" height="6" rx="1"/>
<path d="M-6,-1 L-6,9 M0,-2 L0,10 M6,-1 L6,9" stroke="currentColor" stroke-width="1.2"/>
</g>
<g transform="translate(375,58)">
<ellipse cx="0" cy="4" rx="7.5" ry="6"/><rect x="-1.2" y="-5" width="2.4" height="5" rx="1"/>
<path d="M-5,-1 L-5,8 M0,-2 L0,9 M5,-1 L5,8" stroke="currentColor" stroke-width="1"/>
</g>
<circle cx="80" cy="26" r="1.8"/><circle cx="520" cy="24" r="1.8"/><circle cx="260" cy="42" r="1.5"/><circle cx="340" cy="42" r="1.5"/>
</g>
</svg>` },
    { id: 'garland-holly', name: 'Holly garland', motif: 'holly', placement: 'garland', signature: true,
      themes: ['yuletide'], file: 'Asset/flairs/garland-holly.svg', seasonal: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 90" role="img" aria-labelledby="t d">
<title id="t">Holly garland</title>
<desc id="d">A swag garland with hanging holly leaves and berry clusters for Yuletide.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M0,12 Q300,64 600,12"/>
<path d="M150,32 L150,42"/><path d="M300,38 L300,48"/><path d="M450,30 L450,40"/>
<path d="M225,36 L225,44"/><path d="M375,36 L375,44"/>
</g>
<g fill="currentColor" stroke="none">
<g transform="translate(150,60) rotate(-10)">
<path d="M0,0 C-10,-4 -16,-12 -18,-24 C-8,-21 -2,-11 0,-2Z"/>
<path d="M0,0 C10,-4 16,-12 18,-24 C8,-21 2,-11 0,-2Z"/>
<path d="M-6,-12 L-12,-16 M6,-12 L12,-16" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>
<circle cx="-8" cy="8" r="3"/><circle cx="0" cy="11" r="3"/><circle cx="8" cy="8" r="3"/>
</g>
<g transform="translate(300,70) rotate(8) scale(1.2)">
<path d="M0,0 C-10,-4 -16,-12 -18,-24 C-8,-21 -2,-11 0,-2Z"/>
<path d="M0,0 C10,-4 16,-12 18,-24 C8,-21 2,-11 0,-2Z"/>
<path d="M-6,-12 L-12,-16 M6,-12 L12,-16" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>
<circle cx="-8" cy="8" r="3"/><circle cx="0" cy="11" r="3"/><circle cx="8" cy="8" r="3"/>
</g>
<g transform="translate(450,58) rotate(-8)">
<path d="M0,0 C-10,-4 -16,-12 -18,-24 C-8,-21 -2,-11 0,-2Z"/>
<path d="M0,0 C10,-4 16,-12 18,-24 C8,-21 2,-11 0,-2Z"/>
<path d="M-6,-12 L-12,-16 M6,-12 L12,-16" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>
<circle cx="-8" cy="8" r="3"/><circle cx="0" cy="11" r="3"/><circle cx="8" cy="8" r="3"/>
</g>
<g transform="translate(225,56)"><circle cx="-5" cy="0" r="3"/><circle cx="3" cy="2" r="3"/><circle cx="0" cy="-5" r="3"/></g>
<g transform="translate(375,56)"><circle cx="-5" cy="0" r="3"/><circle cx="3" cy="2" r="3"/><circle cx="0" cy="-5" r="3"/></g>
</g>
</svg>` },
    { id: 'garland-gala', name: 'Gala star garland', motif: 'gala', placement: 'garland', signature: true,
      themes: ['fete'], file: 'Asset/flairs/garland-gala.svg', seasonal: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 90" role="img" aria-labelledby="t d">
<title id="t">Gala star garland</title>
<desc id="d">A swag garland with hanging celebration stars for the New Year fete.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M0,12 Q300,64 600,12"/>
<path d="M150,32 L150,42"/><path d="M300,38 L300,50"/><path d="M450,30 L450,40"/>
<path d="M225,36 L225,44"/><path d="M375,36 L375,44"/>
</g>
<g fill="currentColor" stroke="none">
<g transform="translate(150,54)"><path d="M0,-10 L2.4,-2.4 L10,0 L2.4,2.4 L0,10 L-2.4,2.4 L-10,0 L-2.4,-2.4Z"/></g>
<g transform="translate(300,64)"><path d="M0,-12 L2.8,-2.8 L12,0 L2.8,2.8 L0,12 L-2.8,2.8 L-12,0 L-2.8,-2.8Z"/></g>
<g transform="translate(450,52)"><path d="M0,-10 L2.4,-2.4 L10,0 L2.4,2.4 L0,10 L-2.4,2.4 L-10,0 L-2.4,-2.4Z"/></g>
<g transform="translate(225,54)"><path d="M0,-7 L1.7,-1.7 L7,0 L1.7,1.7 L0,7 L-1.7,1.7 L-7,0 L-1.7,-1.7Z"/></g>
<g transform="translate(375,54)"><path d="M0,-7 L1.7,-1.7 L7,0 L1.7,1.7 L0,7 L-1.7,1.7 L-7,0 L-1.7,-1.7Z"/></g>
<circle cx="80" cy="26" r="2"/><circle cx="520" cy="24" r="2"/><circle cx="190" cy="40" r="1.6"/><circle cx="410" cy="40" r="1.6"/><circle cx="260" cy="46" r="1.6"/><circle cx="340" cy="46" r="1.6"/>
</g>
</svg>` },
    { id: 'garland-rose', name: 'Rose garland', motif: 'rose', placement: 'garland', signature: true,
      themes: ['amour'], file: 'Asset/flairs/garland-rose.svg', seasonal: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 90" role="img" aria-labelledby="t d">
<title id="t">Rose garland</title>
<desc id="d">A swag garland with hanging rosebuds and leaves for Amour.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M0,12 Q300,64 600,12"/>
<path d="M150,32 L150,42"/><path d="M300,38 L300,50"/><path d="M450,30 L450,40"/>
<path d="M225,36 L225,44"/><path d="M375,36 L375,44"/>
</g>
<g fill="currentColor" stroke="none">
<g transform="translate(150,56)">
<path d="M0,-11 C6,-7 8,0 4,6 C1,10 -3,10 -6,6 C-9,1 -7,-7 0,-11Z" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M0,-5 C2.5,-3 3,1 1.5,4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
<ellipse cx="-10" cy="6" rx="6" ry="2.6" transform="rotate(-30 -10 6)"/>
</g>
<g transform="translate(300,66)">
<path d="M0,-13 C7,-8 9,1 5,8 C2,13 -3,13 -6,8 C-10,1 -8,-8 0,-13Z" fill="none" stroke="currentColor" stroke-width="2"/>
<path d="M0,-6 C3,-3 4,2 2,6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
<ellipse cx="-12" cy="8" rx="7" ry="3" transform="rotate(-30 -12 8)"/>
<ellipse cx="12" cy="8" rx="7" ry="3" transform="rotate(30 12 8)"/>
</g>
<g transform="translate(450,54)">
<path d="M0,-11 C6,-7 8,0 4,6 C1,10 -3,10 -6,6 C-9,1 -7,-7 0,-11Z" fill="none" stroke="currentColor" stroke-width="1.8"/>
<path d="M0,-5 C2.5,-3 3,1 1.5,4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
<ellipse cx="10" cy="6" rx="6" ry="2.6" transform="rotate(30 10 6)"/>
</g>
<g transform="translate(225,52)"><ellipse cx="0" cy="0" rx="6" ry="2.6" transform="rotate(-25 0 0)"/></g>
<g transform="translate(375,52)"><ellipse cx="0" cy="0" rx="6" ry="2.6" transform="rotate(25 0 0)"/></g>
</g>
</svg>` },
    { id: 'garland-clover', name: 'Clover garland', motif: 'clover', placement: 'garland', signature: true,
      themes: ['shamrock'], file: 'Asset/flairs/garland-clover.svg', seasonal: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 90" role="img" aria-labelledby="t d">
<title id="t">Clover garland</title>
<desc id="d">A swag garland with hanging clover clusters for Shamrock.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M0,12 Q300,64 600,12"/>
<path d="M150,32 L150,42"/><path d="M300,38 L300,50"/><path d="M450,30 L450,40"/>
<path d="M225,36 L225,44"/><path d="M375,36 L375,44"/>
</g>
<g fill="currentColor" stroke="none">
<g transform="translate(150,58)">
<circle cx="-7" cy="0" r="6"/><circle cx="7" cy="0" r="6"/><circle cx="0" cy="-7" r="6"/>
<path d="M0,6 L0,14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>
</g>
<g transform="translate(300,68) scale(1.25)">
<circle cx="-7" cy="0" r="6"/><circle cx="7" cy="0" r="6"/><circle cx="0" cy="-7" r="6"/>
<path d="M0,6 L0,14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>
</g>
<g transform="translate(450,56)">
<circle cx="-7" cy="0" r="6"/><circle cx="7" cy="0" r="6"/><circle cx="0" cy="-7" r="6"/>
<path d="M0,6 L0,14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>
</g>
<g transform="translate(225,52)"><circle cx="0" cy="0" r="4"/></g>
<g transform="translate(375,52)"><circle cx="0" cy="0" r="4"/></g>
<circle cx="80" cy="26" r="1.8"/><circle cx="520" cy="24" r="1.8"/>
</g>
</svg>` },
    { id: 'garland-blossom', name: 'Blossom garland', motif: 'blossom', placement: 'garland', signature: true,
      themes: ['pastel'], file: 'Asset/flairs/garland-blossom.svg', seasonal: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 90" role="img" aria-labelledby="t d">
<title id="t">Blossom garland</title>
<desc id="d">A swag garland with hanging spring blossoms and buds for Pastel.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M0,12 Q300,64 600,12"/>
<path d="M150,32 L150,42"/><path d="M300,38 L300,50"/><path d="M450,30 L450,40"/>
<path d="M225,36 L225,44"/><path d="M375,36 L375,44"/>
</g>
<g fill="currentColor" stroke="none">
<g transform="translate(150,56)">
<g><ellipse cx="0" cy="-7" rx="4.5" ry="6"/><ellipse cx="6.7" cy="-2.2" rx="4.5" ry="6" transform="rotate(72 6.7 -2.2)"/><ellipse cx="4.1" cy="5.7" rx="4.5" ry="6" transform="rotate(144 4.1 5.7)"/><ellipse cx="-4.1" cy="5.7" rx="4.5" ry="6" transform="rotate(216 -4.1 5.7)"/><ellipse cx="-6.7" cy="-2.2" rx="4.5" ry="6" transform="rotate(288 -6.7 -2.2)"/></g>
<circle cx="0" cy="0" r="2.6"/>
</g>
<g transform="translate(300,66) scale(1.2)">
<g><ellipse cx="0" cy="-7" rx="4.5" ry="6"/><ellipse cx="6.7" cy="-2.2" rx="4.5" ry="6" transform="rotate(72 6.7 -2.2)"/><ellipse cx="4.1" cy="5.7" rx="4.5" ry="6" transform="rotate(144 4.1 5.7)"/><ellipse cx="-4.1" cy="5.7" rx="4.5" ry="6" transform="rotate(216 -4.1 5.7)"/><ellipse cx="-6.7" cy="-2.2" rx="4.5" ry="6" transform="rotate(288 -6.7 -2.2)"/></g>
<circle cx="0" cy="0" r="2.6"/>
</g>
<g transform="translate(450,54)">
<g><ellipse cx="0" cy="-7" rx="4.5" ry="6"/><ellipse cx="6.7" cy="-2.2" rx="4.5" ry="6" transform="rotate(72 6.7 -2.2)"/><ellipse cx="4.1" cy="5.7" rx="4.5" ry="6" transform="rotate(144 4.1 5.7)"/><ellipse cx="-4.1" cy="5.7" rx="4.5" ry="6" transform="rotate(216 -4.1 5.7)"/><ellipse cx="-6.7" cy="-2.2" rx="4.5" ry="6" transform="rotate(288 -6.7 -2.2)"/></g>
<circle cx="0" cy="0" r="2.6"/>
</g>
<g transform="translate(225,52)"><circle cx="0" cy="0" r="3.4"/></g>
<g transform="translate(375,52)"><circle cx="0" cy="0" r="3.4"/></g>
</g>
</svg>` },
    { id: 'garland-wheat', name: 'Wheat garland', motif: 'wheat', placement: 'garland', signature: true,
      themes: ['harvest'], file: 'Asset/flairs/garland-wheat.svg', seasonal: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 90" role="img" aria-labelledby="t d">
<title id="t">Wheat garland</title>
<desc id="d">A swag garland with hanging wheat sprigs and leaves for Harvest.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M0,12 Q300,64 600,12"/>
<path d="M150,32 L150,42"/><path d="M300,38 L300,50"/><path d="M450,30 L450,40"/>
</g>
<g fill="currentColor" stroke="none">
<g transform="translate(150,54) scale(1.25)">
<path d="M0,0 L0,18" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>
<ellipse cx="-5" cy="6" rx="4.5" ry="2" transform="rotate(-55 -5 6)"/><ellipse cx="5" cy="6" rx="4.5" ry="2" transform="rotate(55 5 6)"/>
<ellipse cx="-5" cy="12" rx="4.2" ry="1.9" transform="rotate(-55 -5 12)"/><ellipse cx="5" cy="12" rx="4.2" ry="1.9" transform="rotate(55 5 12)"/>
<ellipse cx="0" cy="20" rx="4" ry="2"/>
</g>
<g transform="translate(300,62) scale(1.2)">
<path d="M0,0 L0,18" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>
<ellipse cx="-5" cy="6" rx="4.5" ry="2" transform="rotate(-55 -5 6)"/><ellipse cx="5" cy="6" rx="4.5" ry="2" transform="rotate(55 5 6)"/>
<ellipse cx="-5" cy="12" rx="4.2" ry="1.9" transform="rotate(-55 -5 12)"/><ellipse cx="5" cy="12" rx="4.2" ry="1.9" transform="rotate(55 5 12)"/>
<ellipse cx="0" cy="20" rx="4" ry="2"/>
</g>
<g transform="translate(450,52) scale(1.25)">
<path d="M0,0 L0,18" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>
<ellipse cx="-5" cy="6" rx="4.5" ry="2" transform="rotate(-55 -5 6)"/><ellipse cx="5" cy="6" rx="4.5" ry="2" transform="rotate(55 5 6)"/>
<ellipse cx="-5" cy="12" rx="4.2" ry="1.9" transform="rotate(-55 -5 12)"/><ellipse cx="5" cy="12" rx="4.2" ry="1.9" transform="rotate(55 5 12)"/>
<ellipse cx="0" cy="20" rx="4" ry="2"/>
</g>
<g transform="translate(225,48)"><ellipse cx="0" cy="0" rx="7" ry="3" transform="rotate(-25 0 0)"/></g>
<g transform="translate(375,48)"><ellipse cx="0" cy="0" rx="7" ry="3" transform="rotate(25 0 0)"/></g>
</g>
</svg>` },
    { id: 'garland-solstice', name: 'Solstice sun garland', motif: 'solstice', placement: 'garland', signature: true, seasonal: true,
      themes: ['solstice'], file: 'Asset/flairs/garland-solstice.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 600 90\" role=\"img\" aria-labelledby=\"t d\">
<title id=\"t\">Solstice sun garland</title>
<desc id=\"d\">A summer swag garland with a radiant sun centerpiece, hanging wheat sprigs and leaves — the seasonal banner for Solstice.</desc>
<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\">
<path d=\"M0,14 Q300,66 600,14\"/>
<!-- sun rays (no south ray — the sun rests on the swag line) -->
<g>
<path d=\"M300,10 L300,4\"/>
<path d=\"M310,14 L314,10\"/><path d=\"M290,14 L286,10\"/>
<path d=\"M314,24 L320,24\"/><path d=\"M286,24 L280,24\"/>
<path d=\"M310,34 L314,38\"/><path d=\"M290,34 L286,38\"/>
</g>
<!-- hanging stems -->
<path d=\"M150,34 L150,44\"/><path d=\"M450,34 L450,44\"/>
</g>
<g fill=\"currentColor\" stroke=\"none\">
<!-- sun: smaller, resting on the swag line like a sunrise -->
<circle cx=\"300\" cy=\"24\" r=\"11\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\"/>
<circle cx=\"300\" cy=\"24\" r=\"5\"/>
<!-- wheat sprigs hanging left and right -->
<g transform=\"translate(150,56) scale(1.2)\">
<path d=\"M0,0 L0,16\" stroke=\"currentColor\" stroke-width=\"1.8\" fill=\"none\" stroke-linecap=\"round\"/>
<ellipse cx=\"-5\" cy=\"5\" rx=\"4.5\" ry=\"2\" transform=\"rotate(-55 -5 5)\"/><ellipse cx=\"5\" cy=\"5\" rx=\"4.5\" ry=\"2\" transform=\"rotate(55 5 5)\"/>
<ellipse cx=\"-5\" cy=\"11\" rx=\"4.2\" ry=\"1.9\" transform=\"rotate(-55 -5 11)\"/><ellipse cx=\"5\" cy=\"11\" rx=\"4.2\" ry=\"1.9\" transform=\"rotate(55 5 11)\"/>
<ellipse cx=\"0\" cy=\"18\" rx=\"4\" ry=\"2\"/>
</g>
<g transform=\"translate(450,56) scale(1.2)\">
<path d=\"M0,0 L0,16\" stroke=\"currentColor\" stroke-width=\"1.8\" fill=\"none\" stroke-linecap=\"round\"/>
<ellipse cx=\"-5\" cy=\"5\" rx=\"4.5\" ry=\"2\" transform=\"rotate(-55 -5 5)\"/><ellipse cx=\"5\" cy=\"5\" rx=\"4.5\" ry=\"2\" transform=\"rotate(55 5 5)\"/>
<ellipse cx=\"-5\" cy=\"11\" rx=\"4.2\" ry=\"1.9\" transform=\"rotate(-55 -5 11)\"/><ellipse cx=\"5\" cy=\"11\" rx=\"4.2\" ry=\"1.9\" transform=\"rotate(55 5 11)\"/>
<ellipse cx=\"0\" cy=\"18\" rx=\"4\" ry=\"2\"/>
</g>
<!-- leaves along the swag -->
<g transform=\"translate(225,50)\"><ellipse cx=\"0\" cy=\"0\" rx=\"7\" ry=\"3\" transform=\"rotate(-25 0 0)\"/></g>
<g transform=\"translate(375,50)\"><ellipse cx=\"0\" cy=\"0\" rx=\"7\" ry=\"3\" transform=\"rotate(25 0 0)\"/></g>
<!-- small sparkles for summer light -->
<path d=\"M220,20 l1.6,4 4,1.6 -4,1.6 -1.6,4 -1.6,-4 -4,-1.6 4,-1.6z\" opacity=\"0.7\"/>
<path d=\"M380,20 l1.6,4 4,1.6 -4,1.6 -1.6,4 -1.6,-4 -4,-1.6 4,-1.6z\" opacity=\"0.7\"/>
</g>
</svg>` },
    { id: 'watermark-moon', name: 'Moon phases watermark', motif: 'moon', placement: 'watermark', signature: true,
      themes: ['twilight'], file: 'Asset/flairs/watermark-moon.svg', premium: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-labelledby="t d">
<title id="t">Moon phases watermark</title>
<desc id="d">An arc of moon phases, from crescent to full, for atmospheric backgrounds.</desc>
<g fill="currentColor" stroke="none">
<circle cx="60" cy="320" r="26"/>
<path d="M132,268 C109,285.9 109,302.1 132,320 C123,307.7 123,280.3 132,268Z"/>
<path d="M208,232 C185,249.9 185,266.1 208,284 C199,271.7 199,244.3 208,232Z"/>
<circle cx="280" cy="200" r="26"/>
<path d="M348,148 C371,165.9 371,182.1 348,200 C357,187.7 357,160.3 348,148Z"/>
<path d="M96,120 C79,133.9 79,146.1 96,160 C89.5,150.7 89.5,129.3 96,120Z"/>
<circle cx="170" cy="90" r="20"/>
<g opacity="0.7">
<path d="M250,60 l2,5.2 5.2,2 -5.2,2 -2,5.2 -2,-5.2 -5.2,-2 5.2,-2z"/>
<path d="M310,110 l1.6,4 4,1.6 -4,1.6 -1.6,4 -1.6,-4 -4,-1.6 4,-1.6z"/>
<circle cx="120" cy="220" r="2.4"/><circle cx="230" cy="320" r="2.4"/><circle cx="340" cy="260" r="2"/>
</g>
</g>
</svg>` },
    { id: 'watermark-constellation', name: 'Constellation watermark', motif: 'constellation', placement: 'watermark',
      themes: ['midnight'], file: 'Asset/flairs/watermark-constellation.svg', premium: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" role="img" aria-labelledby="t d">
<title id="t">Constellation watermark</title>
<desc id="d">A hand-drawn star chart with connecting lines, for atmospheric backgrounds.</desc>
<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.8">
<path d="M80,300 L130,240 L190,250 L230,180 L290,190 L320,120"/>
<path d="M130,240 L150,300"/>
<path d="M230,180 L260,240"/>
</g>
<g fill="currentColor" stroke="none">
<path d="M80,300 l3,7.8 7.8,3 -7.8,3 -3,7.8 -3,-7.8 -7.8,-3 7.8,-3z"/>
<path d="M130,240 l2.4,6.2 6.2,2.4 -6.2,2.4 -2.4,6.2 -2.4,-6.2 -6.2,-2.4 6.2,-2.4z"/>
<path d="M190,250 l2.4,6.2 6.2,2.4 -6.2,2.4 -2.4,6.2 -2.4,-6.2 -6.2,-2.4 6.2,-2.4z"/>
<path d="M230,180 l2.8,7 7,2.8 -7,2.8 -2.8,7 -2.8,-7 -7,-2.8 7,-2.8z"/>
<path d="M290,190 l2.2,5.6 5.6,2.2 -5.6,2.2 -2.2,5.6 -2.2,-5.6 -5.6,-2.2 5.6,-2.2z"/>
<path d="M320,120 l3,7.8 7.8,3 -7.8,3 -3,7.8 -3,-7.8 -7.8,-3 7.8,-3z"/>
<circle cx="150" cy="300" r="2.4"/><circle cx="260" cy="240" r="2.4"/>
<circle cx="110" cy="180" r="2"/><circle cx="200" cy="120" r="2"/><circle cx="270" cy="90" r="2"/>
<circle cx="90" cy="120" r="1.8"/><circle cx="350" cy="220" r="1.8"/>
</g>
</svg>` },
    /* ---- v423: premium theme packs (all premium:true, unlocked in alpha) ---- */
    { id: 'stormrider-vine', name: 'Stormrider emblem vine', motif: 'dragon', placement: 'vine', signature: true,
      themes: ["stormrider"], file: 'Asset/packs/stormrider-vine.png', premium: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 128" role="img" aria-labelledby="t d">
<title id="t">Stormrider emblem vine</title>
<desc id="d">Kevin's Stormrider emblem: black dragon with gold winged sword.</desc>
<image href="Asset/packs/stormrider-vine.png" x="2" y="2" width="116" height="124" preserveAspectRatio="xMidYMid meet"/>
</svg>` },
    { id: 'stormrider-garland', name: 'Stormrider storm garland', motif: 'storm', placement: 'garland',
      themes: ["stormrider"], file: 'Asset/packs/stormrider-garland.svg', premium: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 90" role="img" aria-labelledby="t d">
<title id="t">Stormrider garland</title>
<desc id="d">A storm garland with hanging cloud puffs and lightning bolts. Stormrider pack.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M0,12 Q300,64 600,12"/>
<path d="M150,32 L150,42"/><path d="M300,38 L300,50"/><path d="M450,30 L450,40"/>
<path d="M225,36 L225,44"/><path d="M375,36 L375,44"/>
</g>
<g fill="currentColor" stroke="none">
<g transform="translate(150,56)">
<circle cx="-10" cy="0" r="8"/><circle cx="0" cy="-4" r="10"/><circle cx="10" cy="0" r="8"/><rect x="-14" y="-2" width="28" height="10" rx="5"/>
<path d="M-2,8 L-8,20 L-4,20 L-6,30 L4,16 L0,16 Z"/>
</g>
<g transform="translate(300,66) scale(1.2)">
<circle cx="-10" cy="0" r="8"/><circle cx="0" cy="-4" r="10"/><circle cx="10" cy="0" r="8"/><rect x="-14" y="-2" width="28" height="10" rx="5"/>
<path d="M-2,8 L-8,20 L-4,20 L-6,30 L4,16 L0,16 Z"/>
</g>
<g transform="translate(450,54)">
<circle cx="-10" cy="0" r="8"/><circle cx="0" cy="-4" r="10"/><circle cx="10" cy="0" r="8"/><rect x="-14" y="-2" width="28" height="10" rx="5"/>
<path d="M-2,8 L-8,20 L-4,20 L-6,30 L4,16 L0,16 Z"/>
</g>
<g transform="translate(225,54)"><path d="M3,-10 L-5,2 L-1,2 L-3,10 L5,-4 L1,-4 Z"/></g>
<g transform="translate(375,54)"><path d="M3,-10 L-5,2 L-1,2 L-3,10 L5,-4 L1,-4 Z"/></g>
<circle cx="80" cy="26" r="1.8"/><circle cx="520" cy="24" r="1.8"/>
</g>
</svg>` },
    { id: 'briarthrone-vine', name: 'Briarthrone thorn vine', motif: 'thorn', placement: 'vine', signature: true,
      themes: ["briarthrone"], file: 'Asset/packs/briarthrone-vine.svg', premium: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 360" role="img" aria-labelledby="t d">
<title id="t">Briarthrone vine</title>
<desc id="d">A gnarled thorn vine with night-bloom buds and scattered stars. Briarthrone pack.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M60,352 C38,310 82,276 60,228 C42,190 78,156 60,112 C48,82 66,52 58,24"/>
<path d="M60,228 C46,220 38,208 36,192" stroke-width="1.4"/>
<path d="M60,150 C74,142 82,130 84,114" stroke-width="1.4"/>
</g>
<g fill="currentColor" stroke="none">
<path d="M52,290 l-8,-2 7,-5z"/><path d="M64,262 l8,-2 -7,-5z"/>
<path d="M50,200 l-8,-2 7,-5z"/><path d="M66,170 l8,-2 -7,-5z"/>
<path d="M52,120 l-7,-2 6,-5z"/><path d="M62,80 l7,-2 -6,-5z"/>
</g>
<g fill="currentColor" stroke="none">
<!-- night blooms: 6-petal star flowers -->
<g transform="translate(58,24)">
<ellipse cx="0" cy="-8" rx="3.4" ry="6"/><ellipse cx="7" cy="-4" rx="3.4" ry="6" transform="rotate(60 7 -4)"/><ellipse cx="7" cy="4" rx="3.4" ry="6" transform="rotate(120 7 4)"/><ellipse cx="0" cy="8" rx="3.4" ry="6"/><ellipse cx="-7" cy="4" rx="3.4" ry="6" transform="rotate(120 -7 4)"/><ellipse cx="-7" cy="-4" rx="3.4" ry="6" transform="rotate(60 -7 -4)"/>
<circle r="2.6"/>
</g>
<g transform="translate(36,192) scale(.75)">
<ellipse cx="0" cy="-8" rx="3.4" ry="6"/><ellipse cx="7" cy="-4" rx="3.4" ry="6" transform="rotate(60 7 -4)"/><ellipse cx="7" cy="4" rx="3.4" ry="6" transform="rotate(120 7 4)"/><ellipse cx="0" cy="8" rx="3.4" ry="6"/><ellipse cx="-7" cy="4" rx="3.4" ry="6" transform="rotate(120 -7 4)"/><ellipse cx="-7" cy="-4" rx="3.4" ry="6" transform="rotate(60 -7 -4)"/>
<circle r="2.6"/>
</g>
<g transform="translate(84,114) scale(.65)">
<ellipse cx="0" cy="-8" rx="3.4" ry="6"/><ellipse cx="7" cy="-4" rx="3.4" ry="6" transform="rotate(60 7 -4)"/><ellipse cx="7" cy="4" rx="3.4" ry="6" transform="rotate(120 7 4)"/><ellipse cx="0" cy="8" rx="3.4" ry="6"/><ellipse cx="-7" cy="4" rx="3.4" ry="6" transform="rotate(120 -7 4)"/><ellipse cx="-7" cy="-4" rx="3.4" ry="6" transform="rotate(60 -7 -4)"/>
<circle r="2.6"/>
</g>
<!-- leaves -->
<g transform="rotate(-40 46 320)"><ellipse cx="37" cy="317" rx="10" ry="4" transform="rotate(0)"/></g>
<g transform="rotate(40 68 270)"><ellipse cx="77" cy="267" rx="10" ry="4"/></g>
<g transform="rotate(-38 50 130)"><ellipse cx="42" cy="127" rx="8" ry="3.4"/></g>
<!-- stars -->
<path d="M86,60 l1.8,4.6 4.6,1.8 -4.6,1.8 -1.8,4.6 -1.8,-4.6 -4.6,-1.8 4.6,-1.8z"/>
<path d="M30,250 l1.5,3.8 3.8,1.5 -3.8,1.5 -1.5,3.8 -1.5,-3.8 -3.8,-1.5 3.8,-1.5z"/>
<circle cx="76" cy="300" r="1.8"/><circle cx="44" cy="90" r="1.8"/>
</g>
</svg>` },
    { id: 'voidsignal-vine', name: 'Voidsignal circuit vine', motif: 'circuit', placement: 'vine', signature: true,
      themes: ["voidsignal"], file: 'Asset/packs/voidsignal-vine.svg', premium: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 360" role="img" aria-labelledby="t d">
<title id="t">Voidsignal circuit vine</title>
<desc id="d">An angular circuit-trace vine with node points. Voidsignal pack.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<path d="M60,352 L60,300 L40,280 L40,230 L62,208 L62,160 L42,140 L42,100 L60,82 L60,40"/>
<path d="M40,280 L24,264 L24,240" stroke-width="1.4"/>
<path d="M62,208 L84,186 L84,160" stroke-width="1.4"/>
<path d="M42,140 L26,124" stroke-width="1.4"/>
</g>
<g fill="currentColor" stroke="none">
<circle cx="60" cy="352" r="3.4"/><circle cx="60" cy="300" r="3"/>
<circle cx="40" cy="280" r="3"/><circle cx="40" cy="230" r="3"/>
<circle cx="62" cy="208" r="3"/><circle cx="62" cy="160" r="3"/>
<circle cx="42" cy="140" r="3"/><circle cx="42" cy="100" r="3"/>
<circle cx="60" cy="82" r="3"/><circle cx="60" cy="40" r="3.4"/>
<circle cx="24" cy="240" r="2.4"/><circle cx="84" cy="160" r="2.4"/><circle cx="26" cy="124" r="2.2"/>
</g>
<g fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.55" stroke-linecap="round">
<circle cx="60" cy="300" r="7"/><circle cx="62" cy="160" r="7"/><circle cx="42" cy="100" r="7"/>
</g>
</svg>` },
    { id: 'wisp-vine', name: 'Wisp firefly vine', motif: 'firefly', placement: 'vine', signature: true,
      themes: ["wisp","wisp-night"], file: 'Asset/packs/wisp-vine.svg', premium: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 360" role="img" aria-labelledby="t d">
<title id="t">Wisp firefly vine</title>
<desc id="d">A wandering dotted trail with glowing firefly orbs. Wisp pack.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 9">
<path d="M60,352 C40,310 80,280 60,235 C44,198 76,168 60,128 C48,98 70,70 60,40"/>
</g>
<g fill="currentColor" stroke="none">
<circle cx="60" cy="352" r="5"/><circle cx="60" cy="352" r="9" opacity="0.25"/>
<circle cx="66" cy="280" r="4.4"/><circle cx="66" cy="280" r="8" opacity="0.25"/>
<circle cx="52" cy="210" r="5"/><circle cx="52" cy="210" r="9" opacity="0.25"/>
<circle cx="64" cy="140" r="4"/><circle cx="64" cy="140" r="7.4" opacity="0.25"/>
<circle cx="58" cy="72" r="4.6"/><circle cx="58" cy="72" r="8.4" opacity="0.25"/>
<circle cx="60" cy="40" r="3.6"/><circle cx="60" cy="40" r="6.6" opacity="0.25"/>
<g opacity="0.7">
<path d="M84,180 l1.8,4.6 4.6,1.8 -4.6,1.8 -1.8,4.6 -1.8,-4.6 -4.6,-1.8 4.6,-1.8z"/>
<path d="M36,110 l1.5,3.8 3.8,1.5 -3.8,1.5 -1.5,3.8 -1.5,-3.8 -3.8,-1.5 3.8,-1.5z"/>
</g>
</g>
</svg>` },
    { id: 'wisp-garland', name: 'Wisp pastel garland', motif: 'pastel', placement: 'garland',
      themes: ["wisp","wisp-night"], file: 'Asset/packs/wisp-garland.svg', premium: true,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 90" role="img" aria-labelledby="t d">
<title id="t">Wisp garland</title>
<desc id="d">A pastel garland with hanging stars, moons and dots. Wisp pack.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M0,12 Q300,64 600,12"/>
<path d="M150,32 L150,42"/><path d="M300,38 L300,50"/><path d="M450,30 L450,40"/>
<path d="M225,36 L225,44"/><path d="M375,36 L375,44"/>
</g>
<g fill="currentColor" stroke="none">
<g transform="translate(150,56)"><path d="M0,-9 L2.1,-2.1 L9,0 L2.1,2.1 L0,9 L-2.1,2.1 L-9,0 L-2.1,-2.1Z"/></g>
<g transform="translate(300,66)"><path d="M0,-11 C-11,-5.6 -11,5.6 0,11 C-3.8,6 -3.8,-6 0,-11Z"/></g>
<g transform="translate(450,54)"><path d="M0,-9 L2.1,-2.1 L9,0 L2.1,2.1 L0,9 L-2.1,2.1 L-9,0 L-2.1,-2.1Z"/></g>
<g transform="translate(225,52)"><circle cx="0" cy="0" r="4"/></g>
<g transform="translate(375,52)"><circle cx="0" cy="0" r="4"/></g>
<g opacity="0.7">
<path d="M80,30 l1.5,3.8 3.8,1.5 -3.8,1.5 -1.5,3.8 -1.5,-3.8 -3.8,-1.5 3.8,-1.5z"/>
<path d="M520,28 l1.5,3.8 3.8,1.5 -3.8,1.5 -1.5,3.8 -1.5,-3.8 -3.8,-1.5 3.8,-1.5z"/>
</g>
</g>
</svg>` },    { id: 'vine-nightshade', name: 'Nightshade sprig', motif: 'nightshade', placement: 'vine', signature: true,
      themes: ['dark'], file: 'Asset/flairs/vine-nightshade.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Nightshade sprig</title><desc id=\"d\">A sinuous nightshade vine with berries and small stars, the signature for Dark.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\"><path d=\"M60,354 C57.7,345 43.7,317.7 46,300 C48.3,282.3 73.7,265.3 74,248 C74.3,230.7 48.3,213.3 48,196 C47.7,178.7 71.3,161.3 72,144 C72.7,126.7 53.7,109.3 52,92 C50.3,74.7 61,53 62,40 C63,27 58.7,18.3 58,14\"/></g><g fill=\"currentColor\" fill-opacity=\".85\"><path d=\"M0,0 C7.5,-9.5 21,-8.1 30,0 C21,8.1 7.5,9.5 0,0Z\" transform=\"translate(50,326.5) rotate(-52.7)\"/><path d=\"M0,0 C7,-8.8 19.6,-7.5 28,0 C19.6,7.5 7,8.8 0,0Z\" transform=\"translate(56.8,279.1) rotate(-108)\"/><path d=\"M0,0 C6.5,-8.1 18.2,-6.9 26,0 C18.2,6.9 6.5,8.1 0,0Z\" transform=\"translate(68.3,231.9) rotate(-67.4)\"/><path d=\"M0,0 C6,-7.4 16.8,-6.3 24,0 C16.8,6.3 6,7.4 0,0Z\" transform=\"translate(50.8,184.6) rotate(-120.4)\"/><path d=\"M0,0 C5.5,-6.7 15.4,-5.7 22,0 C15.4,5.7 5.5,6.7 0,0Z\" transform=\"translate(70.3,133.6) rotate(-53.3)\"/><path d=\"M0,0 C5,-6 14,-5.1 20,0 C14,5.1 5,6 0,0Z\" transform=\"translate(52.2,82.3) rotate(-138.6)\"/><path d=\"M0,0 C4.5,-5.3 12.6,-4.5 18,0 C12.6,4.5 4.5,5.3 0,0Z\" transform=\"translate(62.1,39.2) rotate(-31.5)\"/></g><g fill=\"currentColor\"><path d=\"M73,253.7 Q59,257.7 49,265.7\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/><circle cx=\"49\" cy=\"273.7\" r=\"8.5\"/><circle cx=\"43\" cy=\"282.7\" r=\"6.5\" fill-opacity=\".8\"/><path d=\"M64.5,162.7 Q78.5,166.7 88.5,174.7\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/><circle cx=\"88.5\" cy=\"182.7\" r=\"8.5\"/><circle cx=\"94.5\" cy=\"191.7\" r=\"6.5\" fill-opacity=\".8\"/><path d=\"M57.4,108.1 Q43.4,112.1 33.4,120.1\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/><circle cx=\"33.4\" cy=\"128.1\" r=\"8.5\"/><circle cx=\"27.4\" cy=\"137.1\" r=\"6.5\" fill-opacity=\".8\"/><path d=\"M50.9,206.4 Q64.9,210.4 74.9,218.4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/><circle cx=\"74.9\" cy=\"226.4\" r=\"8.5\"/><circle cx=\"80.9\" cy=\"235.4\" r=\"6.5\" fill-opacity=\".8\"/></g><g fill=\"currentColor\"><path d=\"M0,-9 Q0,0 9,0 Q0,0 0,9 Q0,0 -9,0 Q0,0 0,-9Z\" transform=\"translate(58,14)\"/><path d=\"M0,-6 Q0,0 6,0 Q0,0 0,6 Q0,0 -6,0 Q0,0 0,-6Z\" transform=\"translate(84,60)\" fill-opacity=\".8\"/><path d=\"M0,-5 Q0,0 5,0 Q0,0 0,5 Q0,0 -5,0 Q0,0 0,-5Z\" transform=\"translate(30,120)\" fill-opacity=\".7\"/></g></svg>` },
    { id: 'vine-bookrose', name: 'Wild rose vine', motif: 'bookrose', placement: 'vine', signature: true,
      themes: ['light'], file: 'Asset/flairs/vine-bookrose.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Wild rose vine</title><desc id=\"d\">A climbing wild rose with blossoms, leaves and a bud, the signature for Light.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\"><path d=\"M40,354 C44.7,345 67,318 68,300 C69,282 45,264.3 46,246 C47,227.7 73,208.7 74,190 C75,171.3 52.7,152.3 52,134 C51.3,115.7 69.3,97.3 70,80 C70.7,62.7 58.3,38.3 56,30\"/></g><g fill=\"currentColor\" fill-opacity=\".82\"><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(59.1,324.2) rotate(-10.5)\"/><path d=\"M0,0 C5,-6.5 14,-5.5 20,0 C14,5.5 5,6.5 0,0Z\" transform=\"translate(59.1,324.2) rotate(29.5)\"/><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(59.1,276.3) rotate(-172.3)\"/><path d=\"M0,0 C5,-6.5 14,-5.5 20,0 C14,5.5 5,6.5 0,0Z\" transform=\"translate(59.1,276.3) rotate(-212.3)\"/><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(51.6,230.5) rotate(-9.3)\"/><path d=\"M0,0 C5,-6.5 14,-5.5 20,0 C14,5.5 5,6.5 0,0Z\" transform=\"translate(51.6,230.5) rotate(30.7)\"/><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(73.4,183.3) rotate(-151.9)\"/><path d=\"M0,0 C5,-6.5 14,-5.5 20,0 C14,5.5 5,6.5 0,0Z\" transform=\"translate(73.4,183.3) rotate(-191.9)\"/><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(52.2,136.2) rotate(-47.2)\"/><path d=\"M0,0 C5,-6.5 14,-5.5 20,0 C14,5.5 5,6.5 0,0Z\" transform=\"translate(52.2,136.2) rotate(-7.2)\"/><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(67.8,90.5) rotate(-120.8)\"/><path d=\"M0,0 C5,-6.5 14,-5.5 20,0 C14,5.5 5,6.5 0,0Z\" transform=\"translate(67.8,90.5) rotate(-160.8)\"/></g><g fill=\"currentColor\" fill-opacity=\".7\"><path d=\"M67.8,295.7 l7,-9 l-2,10Z\"/><path d=\"M67.7,206.9 l7,-9 l-2,10Z\"/><path d=\"M53.6,123 l7,-9 l-2,10Z\"/></g><g fill=\"currentColor\"><ellipse cx=\"81.7\" cy=\"235.4\" rx=\"12.1\" ry=\"10.6\" transform=\"rotate(-10 81.7 235.4)\" fill=\"currentColor\"/><ellipse cx=\"74.6\" cy=\"249.8\" rx=\"12.1\" ry=\"10.6\" transform=\"rotate(62 74.6 249.8)\" fill=\"currentColor\"/><ellipse cx=\"58.8\" cy=\"247.6\" rx=\"12.1\" ry=\"10.6\" transform=\"rotate(134 58.8 247.6)\" fill=\"currentColor\"/><ellipse cx=\"56\" cy=\"231.8\" rx=\"12.1\" ry=\"10.6\" transform=\"rotate(206 56 231.8)\" fill=\"currentColor\"/><ellipse cx=\"70.1\" cy=\"224.3\" rx=\"12.1\" ry=\"10.6\" transform=\"rotate(278 70.1 224.3)\" fill=\"currentColor\"/><circle cx=\"68.2\" cy=\"237.8\" r=\"5.7\" fill=\"currentColor\"/></g><g fill=\"currentColor\"><ellipse cx=\"46.3\" cy=\"151.2\" rx=\"10.5\" ry=\"9.1\" transform=\"rotate(8 46.3 151.2)\" fill=\"currentColor\"/><ellipse cx=\"36.7\" cy=\"161.1\" rx=\"10.5\" ry=\"9.1\" transform=\"rotate(80 36.7 161.1)\" fill=\"currentColor\"/><ellipse cx=\"24.3\" cy=\"155.1\" rx=\"10.5\" ry=\"9.1\" transform=\"rotate(152 24.3 155.1)\" fill=\"currentColor\"/><ellipse cx=\"26.2\" cy=\"141.4\" rx=\"10.5\" ry=\"9.1\" transform=\"rotate(224 26.2 141.4)\" fill=\"currentColor\"/><ellipse cx=\"39.8\" cy=\"138.9\" rx=\"10.5\" ry=\"9.1\" transform=\"rotate(296 39.8 138.9)\" fill=\"currentColor\"/><circle cx=\"34.7\" cy=\"149.5\" r=\"4.9\" fill=\"currentColor\"/></g><g fill=\"currentColor\"><circle cx=\"62.5\" cy=\"41.3\" r=\"6\"/></g></svg>` },
    { id: 'vine-fireoak', name: 'Oak branch with acorns', motif: 'fireoak', placement: 'vine', signature: true,
      themes: ['hearthside'], file: 'Asset/flairs/vine-fireoak.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Oak branch with acorns</title><desc id=\"d\">A winding oak branch with lobed leaves and acorns, the signature for Hearthside.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"3\" stroke-linecap=\"round\"><path d=\"M60,354 C57,345 39.3,318 42,300 C44.7,282 75.3,264.3 76,246 C76.7,227.7 46.3,208.7 46,190 C45.7,171.3 73.3,152.3 74,134 C74.7,115.7 52,98 50,80 C48,62 60,35 62,26\"/></g><g transform=\"translate(46.3,324.2) rotate(-49)\" fill-opacity=\".85\"><ellipse cx=\"8.8\" cy=\"-6.8\" rx=\"6.2\" ry=\"5.8\" transform=\"rotate(12 8.8 -6.8)\" fill=\"currentColor\"/><ellipse cx=\"8.8\" cy=\"6.8\" rx=\"6.2\" ry=\"5.8\" transform=\"rotate(-12 8.8 6.8)\" fill=\"currentColor\"/><ellipse cx=\"16.8\" cy=\"-8.8\" rx=\"7.8\" ry=\"7.6\" transform=\"rotate(12 16.8 -8.8)\" fill=\"currentColor\"/><ellipse cx=\"16.8\" cy=\"8.8\" rx=\"7.8\" ry=\"7.6\" transform=\"rotate(-12 16.8 8.8)\" fill=\"currentColor\"/><ellipse cx=\"24.8\" cy=\"-7.2\" rx=\"6.2\" ry=\"6.2\" transform=\"rotate(12 24.8 -7.2)\" fill=\"currentColor\"/><ellipse cx=\"24.8\" cy=\"7.2\" rx=\"6.2\" ry=\"6.2\" transform=\"rotate(-12 24.8 7.2)\" fill=\"currentColor\"/><ellipse cx=\"32\" cy=\"-4.4\" rx=\"4.7\" ry=\"3.8\" transform=\"rotate(12 32 -4.4)\" fill=\"currentColor\"/><ellipse cx=\"32\" cy=\"4.4\" rx=\"4.7\" ry=\"3.8\" transform=\"rotate(-12 32 4.4)\" fill=\"currentColor\"/><ellipse cx=\"20\" cy=\"0\" rx=\"20\" ry=\"5.2\" fill=\"currentColor\"/><circle cx=\"39.2\" cy=\"0\" r=\"2.4\" fill=\"currentColor\"/><path d=\"M-4.8,0 L4.8,0\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/></g><g transform=\"translate(68,263.4) rotate(-114.3)\" fill-opacity=\".85\"><ellipse cx=\"8.1\" cy=\"-6.3\" rx=\"5.8\" ry=\"5.4\" transform=\"rotate(12 8.1 -6.3)\" fill=\"currentColor\"/><ellipse cx=\"8.1\" cy=\"6.3\" rx=\"5.8\" ry=\"5.4\" transform=\"rotate(-12 8.1 6.3)\" fill=\"currentColor\"/><ellipse cx=\"15.5\" cy=\"-8.1\" rx=\"7.2\" ry=\"7\" transform=\"rotate(12 15.5 -8.1)\" fill=\"currentColor\"/><ellipse cx=\"15.5\" cy=\"8.1\" rx=\"7.2\" ry=\"7\" transform=\"rotate(-12 15.5 8.1)\" fill=\"currentColor\"/><ellipse cx=\"22.9\" cy=\"-6.7\" rx=\"5.8\" ry=\"5.7\" transform=\"rotate(12 22.9 -6.7)\" fill=\"currentColor\"/><ellipse cx=\"22.9\" cy=\"6.7\" rx=\"5.8\" ry=\"5.7\" transform=\"rotate(-12 22.9 6.7)\" fill=\"currentColor\"/><ellipse cx=\"29.6\" cy=\"-4.1\" rx=\"4.3\" ry=\"3.5\" transform=\"rotate(12 29.6 -4.1)\" fill=\"currentColor\"/><ellipse cx=\"29.6\" cy=\"4.1\" rx=\"4.3\" ry=\"3.5\" transform=\"rotate(-12 29.6 4.1)\" fill=\"currentColor\"/><ellipse cx=\"18.5\" cy=\"0\" rx=\"18.5\" ry=\"4.8\" fill=\"currentColor\"/><circle cx=\"36.3\" cy=\"0\" r=\"2.2\" fill=\"currentColor\"/><path d=\"M-4.4,0 L4.4,0\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\"/></g><g transform=\"translate(50.6,203.5) rotate(-58.9)\" fill-opacity=\".85\"><ellipse cx=\"7.5\" cy=\"-5.8\" rx=\"5.3\" ry=\"5\" transform=\"rotate(12 7.5 -5.8)\" fill=\"currentColor\"/><ellipse cx=\"7.5\" cy=\"5.8\" rx=\"5.3\" ry=\"5\" transform=\"rotate(-12 7.5 5.8)\" fill=\"currentColor\"/><ellipse cx=\"14.3\" cy=\"-7.5\" rx=\"6.6\" ry=\"6.4\" transform=\"rotate(12 14.3 -7.5)\" fill=\"currentColor\"/><ellipse cx=\"14.3\" cy=\"7.5\" rx=\"6.6\" ry=\"6.4\" transform=\"rotate(-12 14.3 7.5)\" fill=\"currentColor\"/><ellipse cx=\"21.1\" cy=\"-6.1\" rx=\"5.3\" ry=\"5.3\" transform=\"rotate(12 21.1 -6.1)\" fill=\"currentColor\"/><ellipse cx=\"21.1\" cy=\"6.1\" rx=\"5.3\" ry=\"5.3\" transform=\"rotate(-12 21.1 6.1)\" fill=\"currentColor\"/><ellipse cx=\"27.2\" cy=\"-3.7\" rx=\"4\" ry=\"3.2\" transform=\"rotate(12 27.2 -3.7)\" fill=\"currentColor\"/><ellipse cx=\"27.2\" cy=\"3.7\" rx=\"4\" ry=\"3.2\" transform=\"rotate(-12 27.2 3.7)\" fill=\"currentColor\"/><ellipse cx=\"17\" cy=\"0\" rx=\"17\" ry=\"4.4\" fill=\"currentColor\"/><circle cx=\"33.3\" cy=\"0\" r=\"2\" fill=\"currentColor\"/><path d=\"M-4.1,0 L4.1,0\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\"/></g><g transform=\"translate(71.8,142.8) rotate(-128.9)\" fill-opacity=\".85\"><ellipse cx=\"6.8\" cy=\"-5.3\" rx=\"4.8\" ry=\"4.5\" transform=\"rotate(12 6.8 -5.3)\" fill=\"currentColor\"/><ellipse cx=\"6.8\" cy=\"5.3\" rx=\"4.8\" ry=\"4.5\" transform=\"rotate(-12 6.8 5.3)\" fill=\"currentColor\"/><ellipse cx=\"13\" cy=\"-6.8\" rx=\"6\" ry=\"5.9\" transform=\"rotate(12 13 -6.8)\" fill=\"currentColor\"/><ellipse cx=\"13\" cy=\"6.8\" rx=\"6\" ry=\"5.9\" transform=\"rotate(-12 13 6.8)\" fill=\"currentColor\"/><ellipse cx=\"19.2\" cy=\"-5.6\" rx=\"4.8\" ry=\"4.8\" transform=\"rotate(12 19.2 -5.6)\" fill=\"currentColor\"/><ellipse cx=\"19.2\" cy=\"5.6\" rx=\"4.8\" ry=\"4.8\" transform=\"rotate(-12 19.2 5.6)\" fill=\"currentColor\"/><ellipse cx=\"24.8\" cy=\"-3.4\" rx=\"3.6\" ry=\"2.9\" transform=\"rotate(12 24.8 -3.4)\" fill=\"currentColor\"/><ellipse cx=\"24.8\" cy=\"3.4\" rx=\"3.6\" ry=\"2.9\" transform=\"rotate(-12 24.8 3.4)\" fill=\"currentColor\"/><ellipse cx=\"15.5\" cy=\"0\" rx=\"15.5\" ry=\"4\" fill=\"currentColor\"/><circle cx=\"30.4\" cy=\"0\" r=\"1.9\" fill=\"currentColor\"/><path d=\"M-3.7,0 L3.7,0\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/></g><g transform=\"translate(50.9,84.3) rotate(-43.6)\" fill-opacity=\".85\"><ellipse cx=\"6.2\" cy=\"-4.8\" rx=\"4.4\" ry=\"4.1\" transform=\"rotate(12 6.2 -4.8)\" fill=\"currentColor\"/><ellipse cx=\"6.2\" cy=\"4.8\" rx=\"4.4\" ry=\"4.1\" transform=\"rotate(-12 6.2 4.8)\" fill=\"currentColor\"/><ellipse cx=\"11.8\" cy=\"-6.2\" rx=\"5.5\" ry=\"5.3\" transform=\"rotate(12 11.8 -6.2)\" fill=\"currentColor\"/><ellipse cx=\"11.8\" cy=\"6.2\" rx=\"5.5\" ry=\"5.3\" transform=\"rotate(-12 11.8 6.2)\" fill=\"currentColor\"/><ellipse cx=\"17.4\" cy=\"-5\" rx=\"4.4\" ry=\"4.3\" transform=\"rotate(12 17.4 -5)\" fill=\"currentColor\"/><ellipse cx=\"17.4\" cy=\"5\" rx=\"4.4\" ry=\"4.3\" transform=\"rotate(-12 17.4 5)\" fill=\"currentColor\"/><ellipse cx=\"22.4\" cy=\"-3.1\" rx=\"3.3\" ry=\"2.6\" transform=\"rotate(12 22.4 -3.1)\" fill=\"currentColor\"/><ellipse cx=\"22.4\" cy=\"3.1\" rx=\"3.3\" ry=\"2.6\" transform=\"rotate(-12 22.4 3.1)\" fill=\"currentColor\"/><ellipse cx=\"14\" cy=\"0\" rx=\"14\" ry=\"3.6\" fill=\"currentColor\"/><circle cx=\"27.4\" cy=\"0\" r=\"1.7\" fill=\"currentColor\"/><path d=\"M-3.4,0 L3.4,0\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\"/></g><g fill=\"currentColor\"><g transform=\"translate(28.5,307.2)\"><ellipse cx=\"0\" cy=\"3.1\" rx=\"5.6\" ry=\"7.6\" fill=\"currentColor\"/><path d=\"M-7.6,-1.6 C-7.6,-8.5 7.6,-8.5 7.6,-1.6 C3.6,-0.2 -3.6,-0.2 -7.6,-1.6Z\" fill=\"currentColor\"/><path d=\"M0,-8.5 L0,-12.2\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\"/></g><g transform=\"translate(69.8,191.1)\"><ellipse cx=\"0\" cy=\"3.1\" rx=\"5.6\" ry=\"7.6\" fill=\"currentColor\"/><path d=\"M-7.6,-1.6 C-7.6,-8.5 7.6,-8.5 7.6,-1.6 C3.6,-0.2 -3.6,-0.2 -7.6,-1.6Z\" fill=\"currentColor\"/><path d=\"M0,-8.5 L0,-12.2\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\"/></g><g transform=\"translate(49.1,131.3)\"><ellipse cx=\"0\" cy=\"3.1\" rx=\"5.6\" ry=\"7.6\" fill=\"currentColor\"/><path d=\"M-7.6,-1.6 C-7.6,-8.5 7.6,-8.5 7.6,-1.6 C3.6,-0.2 -3.6,-0.2 -7.6,-1.6Z\" fill=\"currentColor\"/><path d=\"M0,-8.5 L0,-12.2\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\"/></g><path d=\"M0,0 C-13.3,-3.6 -11.9,-16.5 -1.7,-30 C0.7,-20.4 13.3,-15.6 11.2,-7.8 C9.8,-2.4 4.2,0 0,0Z\" transform=\"translate(62,40)\" fill-opacity=\".9\"/></g></svg>` },
    { id: 'vine-taper', name: 'Gilded candelabra', motif: 'taper', placement: 'vine', signature: true,
      themes: ['candlelight'], file: 'Asset/flairs/vine-taper.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Gilded candelabra</title><desc id=\"d\">A scrolling candelabra with five small flames, the signature for Candlelight.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.8\" stroke-linecap=\"round\"><path d=\"M60,356 C60,300 58,250 60,196 C62,150 60,120 60,84\"/><path d=\"M60,196 C34,196 22,176 28,152 C32,138 46,138 48,150\"/><path d=\"M60,196 C86,196 98,176 92,152 C88,138 74,138 72,150\"/><path d=\"M60,120 C42,120 30,106 34,88 C38,76 50,80 50,90\"/><path d=\"M60,120 C78,120 90,106 86,88 C82,76 70,80 70,90\"/><path d=\"M34,88 L34,70 M86,88 L86,70 M60,84 L60,64 M28,152 L28,134 M92,152 L92,134\"/></g><g fill=\"currentColor\" fill-opacity=\".9\"><rect x=\"29\" y=\"66\" width=\"10\" height=\"4\" rx=\"1.5\"/><rect x=\"81\" y=\"66\" width=\"10\" height=\"4\" rx=\"1.5\"/><rect x=\"55\" y=\"60\" width=\"10\" height=\"4\" rx=\"1.5\"/><rect x=\"23\" y=\"130\" width=\"10\" height=\"4\" rx=\"1.5\"/><rect x=\"87\" y=\"130\" width=\"10\" height=\"4\" rx=\"1.5\"/></g><g fill=\"currentColor\"><path d=\"M0,0 C-5.2,-1.7 -4.7,-7.7 -0.7,-14 C0.3,-9.5 5.2,-7.3 4.4,-3.6 C3.8,-1.1 1.6,0 0,0Z\" transform=\"translate(34,62)\"/><path d=\"M0,0 C-5.2,-1.7 -4.7,-7.7 -0.7,-14 C0.3,-9.5 5.2,-7.3 4.4,-3.6 C3.8,-1.1 1.6,0 0,0Z\" transform=\"translate(86,62)\"/><path d=\"M0,0 C-6.5,-2.1 -5.8,-9.6 -0.8,-17.5 C0.3,-11.9 6.5,-9.1 5.5,-4.5 C4.8,-1.4 2.1,0 0,0Z\" transform=\"translate(60,54)\"/><path d=\"M0,0 C-4.2,-1.3 -3.7,-6.2 -0.5,-11.2 C0.2,-7.6 4.2,-5.8 3.5,-2.9 C3.1,-0.9 1.3,0 0,0Z\" transform=\"translate(28,126)\"/><path d=\"M0,0 C-4.2,-1.3 -3.7,-6.2 -0.5,-11.2 C0.2,-7.6 4.2,-5.8 3.5,-2.9 C3.1,-0.9 1.3,0 0,0Z\" transform=\"translate(92,126)\"/><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(60,260) rotate(-60)\"/><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(60,260) rotate(-120)\"/><path d=\"M0,0 C6,-7 16.8,-6 24,0 C16.8,6 6,7 0,0Z\" transform=\"translate(60,300) rotate(-55)\"/><path d=\"M0,0 C6,-7 16.8,-6 24,0 C16.8,6 6,7 0,0Z\" transform=\"translate(60,300) rotate(-125)\"/><circle cx=\"60\" cy=\"196\" r=\"5\"/><circle cx=\"60\" cy=\"120\" r=\"4\"/></g></svg>` },
    { id: 'vine-starcompass', name: 'Constellation vine', motif: 'starcompass', placement: 'vine', signature: true,
      themes: ['twilight'], file: 'Asset/flairs/vine-starcompass.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Constellation vine</title><desc id=\"d\">A vertical constellation of stars joined by fine lines.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-opacity=\".7\"><path d=\"M62,346 L40,292 L80,240 L46,186 L84,132 L52,84 L66,30\"/></g><g fill=\"currentColor\"><path d=\"M62,339 L63.9,343.5 L68.7,343.8 L65,347 L66.1,351.7 L62,349.1 L57.9,351.7 L59,347 L55.3,343.8 L60.1,343.5Z\"/><path d=\"M40,282 L42.6,288.4 L49.5,288.9 L44.3,293.4 L45.9,300.1 L40,296.5 L34.1,300.1 L35.7,293.4 L30.5,288.9 L37.4,288.4Z\"/><path d=\"M80,232 L82.1,237.1 L87.6,237.5 L83.4,241.1 L84.7,246.5 L80,243.6 L75.3,246.5 L76.6,241.1 L72.4,237.5 L77.9,237.1Z\"/><path d=\"M46,174 L49.2,181.6 L57.4,182.3 L51.1,187.7 L53.1,195.7 L46,191.4 L38.9,195.7 L40.9,187.7 L34.6,182.3 L42.8,181.6Z\"/><path d=\"M84,123 L86.4,128.7 L92.6,129.2 L87.9,133.3 L89.3,139.3 L84,136.1 L78.7,139.3 L80.1,133.3 L75.4,129.2 L81.6,128.7Z\"/><path d=\"M52,73 L54.9,80 L62.5,80.6 L56.7,85.5 L58.5,92.9 L52,89 L45.5,92.9 L47.3,85.5 L41.5,80.6 L49.1,80Z\"/><path d=\"M66,16 L69.7,24.9 L79.3,25.7 L72,31.9 L74.2,41.3 L66,36.3 L57.8,41.3 L60,31.9 L52.7,25.7 L62.3,24.9Z\"/><path d=\"M0,-8 Q0,0 8,0 Q0,0 0,8 Q0,0 -8,0 Q0,0 0,-8Z\" transform=\"translate(100,200)\" fill-opacity=\".8\"/><path d=\"M0,-7 Q0,0 7,0 Q0,0 0,7 Q0,0 -7,0 Q0,0 0,-7Z\" transform=\"translate(22,118)\" fill-opacity=\".8\"/><path d=\"M0,-6 Q0,0 6,0 Q0,0 0,6 Q0,0 -6,0 Q0,0 0,-6Z\" transform=\"translate(98,60)\" fill-opacity=\".7\"/><path d=\"M0,-6 Q0,0 6,0 Q0,0 0,6 Q0,0 -6,0 Q0,0 0,-6Z\" transform=\"translate(24,280)\" fill-opacity=\".7\"/><circle cx=\"98\" cy=\"300\" r=\"2.4\" fill-opacity=\".7\"/><circle cx=\"18\" cy=\"220\" r=\"2.4\" fill-opacity=\".7\"/><circle cx=\"100\" cy=\"112\" r=\"2.4\" fill-opacity=\".7\"/><path d=\"M4.2,-6.8 A8,8 0 1 0 4.2,6.8 A7.3,7.3 0 1 1 4.2,-6.8Z\" transform=\"translate(70,12) rotate(-35)\"/></g></svg>` },
    { id: 'vine-fernshroom', name: 'Fern vine', motif: 'fernshroom', placement: 'vine', signature: true,
      themes: ['verdant'], file: 'Asset/flairs/vine-fernshroom.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Fern vine</title><desc id=\"d\">A climbing stem with small fern fronds and a mushroom.</desc><path d=\"M60,354 C58,343.3 46.3,311.3 48,290 C49.7,268.7 69.7,247.7 70,226 C70.3,204.3 50.3,181.7 50,160 C49.7,138.3 67,117.7 68,96 C69,74.3 58,41 56,30\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\"/><path d=\"M52.6,326 C54.9,323 60.6,313.9 66.2,307.8 C71.9,301.7 85.5,295.2 86.6,289.6 C87.8,284 75.3,276.6 73,274\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/><path d=\"M0,0 C2.8,-2.9 7.9,-2.5 11.3,0 C7.9,2.5 2.8,2.9 0,0Z\" transform=\"translate(58.2,318) rotate(-116.8)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.8,-2.9 7.9,-2.5 11.3,0 C7.9,2.5 2.8,2.9 0,0Z\" transform=\"translate(58.2,318) rotate(7.2)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.4,-2.5 6.7,-2.1 9.6,0 C6.7,2.1 2.4,2.5 0,0Z\" transform=\"translate(66.2,307.8) rotate(-109)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.4,-2.5 6.7,-2.1 9.6,0 C6.7,2.1 2.4,2.5 0,0Z\" transform=\"translate(66.2,307.8) rotate(15)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2,-2.1 5.6,-1.8 7.9,0 C5.6,1.8 2,2.1 0,0Z\" transform=\"translate(78.1,298.5) rotate(-98)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2,-2.1 5.6,-1.8 7.9,0 C5.6,1.8 2,2.1 0,0Z\" transform=\"translate(78.1,298.5) rotate(26)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.6,-1.6 4.4,-1.4 6.2,0 C4.4,1.4 1.6,1.6 0,0Z\" transform=\"translate(86.6,289.6) rotate(-140.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.6,-1.6 4.4,-1.4 6.2,0 C4.4,1.4 1.6,1.6 0,0Z\" transform=\"translate(86.6,289.6) rotate(-16.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.1,-1.2 3.2,-1 4.5,0 C3.2,1 1.1,1.2 0,0Z\" transform=\"translate(81.1,280.7) rotate(-200.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.1,-1.2 3.2,-1 4.5,0 C3.2,1 1.1,1.2 0,0Z\" transform=\"translate(81.1,280.7) rotate(-76.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1,-1.2 2.7,-1 3.9,0 C2.7,1 1,1.2 0,0Z\" transform=\"translate(73.1,274.1) rotate(-133.1)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M56.4,264.5 C54.1,261.7 48.4,253.3 42.8,247.7 C37.1,242.1 23.5,236.1 22.4,230.9 C21.2,225.7 33.7,218.9 36,216.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/><path d=\"M0,0 C2.8,-2.9 7.9,-2.5 11.3,0 C7.9,2.5 2.8,2.9 0,0Z\" transform=\"translate(50.8,257.1) rotate(-189.4)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.8,-2.9 7.9,-2.5 11.3,0 C7.9,2.5 2.8,2.9 0,0Z\" transform=\"translate(50.8,257.1) rotate(-65.4)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.4,-2.5 6.7,-2.1 9.6,0 C6.7,2.1 2.4,2.5 0,0Z\" transform=\"translate(42.8,247.7) rotate(-197.3)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.4,-2.5 6.7,-2.1 9.6,0 C6.7,2.1 2.4,2.5 0,0Z\" transform=\"translate(42.8,247.7) rotate(-73.3)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2,-2.1 5.6,-1.8 7.9,0 C5.6,1.8 2,2.1 0,0Z\" transform=\"translate(30.9,239.1) rotate(-208.2)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2,-2.1 5.6,-1.8 7.9,0 C5.6,1.8 2,2.1 0,0Z\" transform=\"translate(30.9,239.1) rotate(-84.2)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.6,-1.6 4.4,-1.4 6.2,0 C4.4,1.4 1.6,1.6 0,0Z\" transform=\"translate(22.4,230.9) rotate(-164.3)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.6,-1.6 4.4,-1.4 6.2,0 C4.4,1.4 1.6,1.6 0,0Z\" transform=\"translate(22.4,230.9) rotate(-40.3)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.1,-1.2 3.2,-1 4.5,0 C3.2,1 1.1,1.2 0,0Z\" transform=\"translate(27.9,222.6) rotate(-101.1)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.1,-1.2 3.2,-1 4.5,0 C3.2,1 1.1,1.2 0,0Z\" transform=\"translate(27.9,222.6) rotate(22.9)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1,-1.2 2.7,-1 3.9,0 C2.7,1 1,1.2 0,0Z\" transform=\"translate(35.9,216.6) rotate(-44.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M65.9,206.3 C68.2,203.7 73.8,196 79.5,190.9 C85.2,185.8 98.8,180.3 99.9,175.5 C101,170.7 88.6,164.5 86.3,162.3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/><path d=\"M0,0 C2.8,-2.9 7.9,-2.5 11.3,0 C7.9,2.5 2.8,2.9 0,0Z\" transform=\"translate(71.4,199.5) rotate(-112.2)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.8,-2.9 7.9,-2.5 11.3,0 C7.9,2.5 2.8,2.9 0,0Z\" transform=\"translate(71.4,199.5) rotate(11.8)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.4,-2.5 6.7,-2.1 9.6,0 C6.7,2.1 2.4,2.5 0,0Z\" transform=\"translate(79.5,190.9) rotate(-104.2)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.4,-2.5 6.7,-2.1 9.6,0 C6.7,2.1 2.4,2.5 0,0Z\" transform=\"translate(79.5,190.9) rotate(19.8)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2,-2.1 5.6,-1.8 7.9,0 C5.6,1.8 2,2.1 0,0Z\" transform=\"translate(91.4,183) rotate(-93.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2,-2.1 5.6,-1.8 7.9,0 C5.6,1.8 2,2.1 0,0Z\" transform=\"translate(91.4,183) rotate(30.4)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.6,-1.6 4.4,-1.4 6.2,0 C4.4,1.4 1.6,1.6 0,0Z\" transform=\"translate(99.9,175.5) rotate(-138.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.6,-1.6 4.4,-1.4 6.2,0 C4.4,1.4 1.6,1.6 0,0Z\" transform=\"translate(99.9,175.5) rotate(-14.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.1,-1.2 3.2,-1 4.5,0 C3.2,1 1.1,1.2 0,0Z\" transform=\"translate(94.4,167.9) rotate(-205.3)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.1,-1.2 3.2,-1 4.5,0 C3.2,1 1.1,1.2 0,0Z\" transform=\"translate(94.4,167.9) rotate(-81.3)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1,-1.2 2.7,-1 3.9,0 C2.7,1 1,1.2 0,0Z\" transform=\"translate(86.4,162.4) rotate(-137.9)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M51.6,147.1 C49.4,144.8 43.7,137.8 38,133.1 C32.4,128.4 18.8,123.4 17.6,119.1 C16.5,114.8 29,109.1 31.2,107.1\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/><path d=\"M0,0 C2.8,-2.9 7.9,-2.5 11.3,0 C7.9,2.5 2.8,2.9 0,0Z\" transform=\"translate(46.1,141) rotate(-194.5)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.8,-2.9 7.9,-2.5 11.3,0 C7.9,2.5 2.8,2.9 0,0Z\" transform=\"translate(46.1,141) rotate(-70.5)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.4,-2.5 6.7,-2.1 9.6,0 C6.7,2.1 2.4,2.5 0,0Z\" transform=\"translate(38,133.1) rotate(-202.5)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.4,-2.5 6.7,-2.1 9.6,0 C6.7,2.1 2.4,2.5 0,0Z\" transform=\"translate(38,133.1) rotate(-78.5)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2,-2.1 5.6,-1.8 7.9,0 C5.6,1.8 2,2.1 0,0Z\" transform=\"translate(26.1,126) rotate(-212.8)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2,-2.1 5.6,-1.8 7.9,0 C5.6,1.8 2,2.1 0,0Z\" transform=\"translate(26.1,126) rotate(-88.8)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.6,-1.6 4.4,-1.4 6.2,0 C4.4,1.4 1.6,1.6 0,0Z\" transform=\"translate(17.6,119.1) rotate(-166.7)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.6,-1.6 4.4,-1.4 6.2,0 C4.4,1.4 1.6,1.6 0,0Z\" transform=\"translate(17.6,119.1) rotate(-42.7)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.1,-1.2 3.2,-1 4.5,0 C3.2,1 1.1,1.2 0,0Z\" transform=\"translate(23.2,112.2) rotate(-96.1)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.1,-1.2 3.2,-1 4.5,0 C3.2,1 1.1,1.2 0,0Z\" transform=\"translate(23.2,112.2) rotate(27.9)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1,-1.2 2.7,-1 3.9,0 C2.7,1 1,1.2 0,0Z\" transform=\"translate(31.1,107.2) rotate(-39.4)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M68,89.2 C70.2,87.1 75.9,80.8 81.6,76.6 C87.2,72.4 100.8,67.9 102,64 C103.1,60.1 90.6,55 88.4,53.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/><path d=\"M0,0 C2.8,-2.9 7.9,-2.5 11.3,0 C7.9,2.5 2.8,2.9 0,0Z\" transform=\"translate(73.5,83.7) rotate(-106.4)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.8,-2.9 7.9,-2.5 11.3,0 C7.9,2.5 2.8,2.9 0,0Z\" transform=\"translate(73.5,83.7) rotate(17.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.4,-2.5 6.7,-2.1 9.6,0 C6.7,2.1 2.4,2.5 0,0Z\" transform=\"translate(81.6,76.6) rotate(-98.5)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.4,-2.5 6.7,-2.1 9.6,0 C6.7,2.1 2.4,2.5 0,0Z\" transform=\"translate(81.6,76.6) rotate(25.5)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2,-2.1 5.6,-1.8 7.9,0 C5.6,1.8 2,2.1 0,0Z\" transform=\"translate(93.5,70.2) rotate(-88.7)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2,-2.1 5.6,-1.8 7.9,0 C5.6,1.8 2,2.1 0,0Z\" transform=\"translate(93.5,70.2) rotate(35.3)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.6,-1.6 4.4,-1.4 6.2,0 C4.4,1.4 1.6,1.6 0,0Z\" transform=\"translate(102,64) rotate(-135.8)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.6,-1.6 4.4,-1.4 6.2,0 C4.4,1.4 1.6,1.6 0,0Z\" transform=\"translate(102,64) rotate(-11.8)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.1,-1.2 3.2,-1 4.5,0 C3.2,1 1.1,1.2 0,0Z\" transform=\"translate(96.4,57.8) rotate(-210.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.1,-1.2 3.2,-1 4.5,0 C3.2,1 1.1,1.2 0,0Z\" transform=\"translate(96.4,57.8) rotate(-86.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1,-1.2 2.7,-1 3.9,0 C2.7,1 1,1.2 0,0Z\" transform=\"translate(88.5,53.3) rotate(-143.5)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><g fill=\"currentColor\" fill-opacity=\".9\"><g transform=\"translate(79.3,190.4)\"><path d=\"M-3.4,0 C-2.6,-8.4 -3.6,-11.2 -4.3,-14.5 L4.3,-14.5 C3.6,-11.2 2.6,-8.4 3.4,0 C1.2,1 -1.2,1 -3.4,0Z\" fill=\"currentColor\"/><path d=\"M-12,-14.1 C-12,-27.9 12,-27.9 12,-14.1 C6,-13 -6,-13 -12,-14.1Z\" fill=\"currentColor\"/><circle cx=\"-5.4\" cy=\"-18.6\" r=\"1.6\" fill=\"currentColor\"/><circle cx=\"1.8\" cy=\"-20.8\" r=\"1.9\" fill=\"currentColor\"/><circle cx=\"6.2\" cy=\"-16.7\" r=\"1.3\" fill=\"currentColor\"/><circle cx=\"-1.2\" cy=\"-16.7\" r=\"1\" fill=\"currentColor\"/></g></g></svg>` },
    { id: 'vine-moonphases', name: 'Moon-phase vine', motif: 'moonphases', placement: 'vine', signature: true,
      themes: ['midnight'], file: 'Asset/flairs/vine-moonphases.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Moon-phase vine</title><desc id=\"d\">A thin stem hung with small crescents and stars.</desc><path d=\"M60,354 C57.7,344.3 43.7,315 46,296 C48.3,277 74,258.7 74,240 C74,221.3 46,202.7 46,184 C46,165.3 73,147 74,128 C75,109 54,88 52,70 C50,52 60.3,28.3 62,20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/><g fill=\"currentColor\"><path d=\"M5.8,-9.3 A11,11 0 1 0 5.8,9.3 A10.1,10.1 0 1 1 5.8,-9.3Z\" transform=\"translate(71.2,321.8)\"/><path d=\"M0,-5 Q0,0 5,0 Q0,0 0,5 Q0,0 -5,0 Q0,0 0,-5Z\" transform=\"translate(31.2,307.8)\"/></g><g fill=\"currentColor\"><path d=\"M5.3,-8.5 A10,10 0 1 0 5.3,8.5 A9.2,9.2 0 1 1 5.3,-8.5Z\" transform=\"translate(49.3,251.2) rotate(180)\"/><path d=\"M0,-5 Q0,0 5,0 Q0,0 0,5 Q0,0 -5,0 Q0,0 0,-5Z\" transform=\"translate(89.3,237.2)\"/></g><g fill=\"currentColor\"><path d=\"M4.8,-7.6 A9,9 0 1 0 4.8,7.6 A8.3,8.3 0 1 1 4.8,-7.6Z\" transform=\"translate(68,184)\"/><path d=\"M0,-5 Q0,0 5,0 Q0,0 0,5 Q0,0 -5,0 Q0,0 0,-5Z\" transform=\"translate(28,170)\"/></g><g fill=\"currentColor\"><path d=\"M4.2,-6.8 A8,8 0 1 0 4.2,6.8 A7.3,7.3 0 1 1 4.2,-6.8Z\" transform=\"translate(50.3,116.4) rotate(180)\"/><path d=\"M0,-5 Q0,0 5,0 Q0,0 0,5 Q0,0 -5,0 Q0,0 0,-5Z\" transform=\"translate(90.3,102.4)\"/></g><g fill=\"currentColor\"><path d=\"M3.7,-5.9 A7,7 0 1 0 3.7,5.9 A6.4,6.4 0 1 1 3.7,-5.9Z\" transform=\"translate(76.2,47)\"/><path d=\"M0,-5 Q0,0 5,0 Q0,0 0,5 Q0,0 -5,0 Q0,0 0,-5Z\" transform=\"translate(36.2,33)\"/></g><g fill=\"currentColor\"><path d=\"M0,-9 Q0,0 9,0 Q0,0 0,9 Q0,0 -9,0 Q0,0 0,-9Z\" transform=\"translate(62,16)\"/><circle cx=\"40\" cy=\"330\" r=\"3\"/></g></svg>` },
    { id: 'vine-thornrose', name: 'Rose vine', motif: 'thornrose', placement: 'vine', signature: true,
      themes: ['velvet', 'amour'], file: 'Asset/flairs/vine-thornrose.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Rose vine</title><desc id=\"d\">A thorny stem with two roses and a bud.</desc><path d=\"M60,354 C57.3,345 41.3,318.3 44,300 C46.7,281.7 75.7,263 76,244 C76.3,225 46,205 46,186 C46,167 75.3,149 76,130 C76.7,111 52.3,90.3 50,72 C47.7,53.7 60,28.7 62,20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\"/><g fill=\"currentColor\" fill-opacity=\".8\"><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(47.7,324.3) rotate(-50.9)\"/><path d=\"M47.7,324.3 l-6,-10 l2,10Z\"/></g><g fill=\"currentColor\" fill-opacity=\".8\"><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(52.8,282.3) rotate(-111.2)\"/><path d=\"M52.8,282.3 l6,-10 l-2,10Z\"/></g><g fill=\"currentColor\" fill-opacity=\".8\"><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(75.9,241.7) rotate(-38.1)\"/><path d=\"M75.9,241.7 l-6,-10 l2,10Z\"/></g><g fill=\"currentColor\" fill-opacity=\".8\"><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(46,186) rotate(-148)\"/><path d=\"M46,186 l6,-10 l-2,10Z\"/></g><g fill=\"currentColor\" fill-opacity=\".8\"><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(70,145.8) rotate(1.2)\"/><path d=\"M70,145.8 l-6,-10 l2,10Z\"/></g><g fill=\"currentColor\" fill-opacity=\".8\"><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(57.5,90.2) rotate(-178.9)\"/><path d=\"M57.5,90.2 l6,-10 l-2,10Z\"/></g><g fill=\"currentColor\"><g transform=\"translate(89.6,220.8)\"><path d=\"M18,0 Q21.4,10.3 11.2,14.1 Q5.3,23.2 -4,17.5 Q-14.8,18.6 -16.2,7.8 Q-23.8,0 -16.2,-7.8 Q-14.8,-18.6 -4,-17.5 Q5.3,-23.2 11.2,-14.1 Q21.4,-10.3 18,0Z\" fill=\"currentColor\"/><circle cx=\"0\" cy=\"0\" r=\"14\" fill=\"currentColor\" fill-opacity=\"0.3\"/><circle cx=\"0\" cy=\"0\" r=\"10.1\" fill=\"currentColor\" fill-opacity=\"0.25\"/><circle cx=\"0\" cy=\"0\" r=\"6.1\" fill=\"currentColor\" fill-opacity=\"0.2\"/><path d=\"M1.2,0.8 C1.2,1 1.3,1.4 1.2,1.7 C1.1,2 1,2.3 0.7,2.6 C0.5,2.9 0.1,3.2 -0.3,3.3 C-0.7,3.5 -1.2,3.6 -1.6,3.6 C-2.1,3.6 -2.7,3.5 -3.2,3.3 C-3.7,3 -4.3,2.7 -4.7,2.2 C-5.2,1.8 -5.6,1.2 -5.8,0.5 C-6.1,-0.1 -6.3,-0.9 -6.3,-1.7 C-6.3,-2.4 -6.1,-3.3 -5.8,-4.1 C-5.5,-4.8 -5.1,-5.7 -4.4,-6.3 C-3.8,-7 -3,-7.6 -2.2,-8.1 C-1.3,-8.5 -0.3,-8.9 0.8,-9 C1.8,-9.1 3,-9 4.1,-8.7 C5.2,-8.4 6.7,-7.5 7.3,-7.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-opacity=\".9\"/></g></g><g fill=\"currentColor\"><g transform=\"translate(49.8,118.4)\"><path d=\"M18,0 Q21.4,10.3 11.2,14.1 Q5.3,23.2 -4,17.5 Q-14.8,18.6 -16.2,7.8 Q-23.8,0 -16.2,-7.8 Q-14.8,-18.6 -4,-17.5 Q5.3,-23.2 11.2,-14.1 Q21.4,-10.3 18,0Z\" fill=\"currentColor\"/><circle cx=\"0\" cy=\"0\" r=\"14\" fill=\"currentColor\" fill-opacity=\"0.3\"/><circle cx=\"0\" cy=\"0\" r=\"10.1\" fill=\"currentColor\" fill-opacity=\"0.25\"/><circle cx=\"0\" cy=\"0\" r=\"6.1\" fill=\"currentColor\" fill-opacity=\"0.2\"/><path d=\"M1.2,0.8 C1.2,1 1.3,1.4 1.2,1.7 C1.1,2 1,2.3 0.7,2.6 C0.5,2.9 0.1,3.2 -0.3,3.3 C-0.7,3.5 -1.2,3.6 -1.6,3.6 C-2.1,3.6 -2.7,3.5 -3.2,3.3 C-3.7,3 -4.3,2.7 -4.7,2.2 C-5.2,1.8 -5.6,1.2 -5.8,0.5 C-6.1,-0.1 -6.3,-0.9 -6.3,-1.7 C-6.3,-2.4 -6.1,-3.3 -5.8,-4.1 C-5.5,-4.8 -5.1,-5.7 -4.4,-6.3 C-3.8,-7 -3,-7.6 -2.2,-8.1 C-1.3,-8.5 -0.3,-8.9 0.8,-9 C1.8,-9.1 3,-9 4.1,-8.7 C5.2,-8.4 6.7,-7.5 7.3,-7.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-opacity=\".9\"/></g></g><circle cx=\"58.1\" cy=\"31.6\" r=\"6\" fill=\"currentColor\"/></svg>` },
    { id: 'vine-jellyfish', name: 'Kelp strand', motif: 'jellyfish', placement: 'vine', signature: true,
      themes: ['abyss'], file: 'Asset/flairs/vine-jellyfish.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Kelp strand</title><desc id=\"d\">A swaying kelp strand with bubbles.</desc><path d=\"M60,356 C56.7,346.7 36.7,318.7 40,300 C43.3,281.3 80,263 80,244 C80,225 40,205 40,186 C40,167 79.3,149 80,130 C80.7,111 46.7,91 44,72 C41.3,53 60.7,25.3 64,16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"3.2\" stroke-linecap=\"round\"/><g fill=\"currentColor\" fill-opacity=\".85\"><path d=\"M0,0 C7.5,-8 21,-6.8 30,0 C21,6.8 7.5,8 0,0Z\" transform=\"translate(44.6,325.1) rotate(-42.4)\"/></g><g fill=\"currentColor\" fill-opacity=\".85\"><path d=\"M0,0 C7,-8 19.6,-6.8 28,0 C19.6,6.8 7,8 0,0Z\" transform=\"translate(57.8,275.5) rotate(-114.2)\"/></g><g fill=\"currentColor\" fill-opacity=\".85\"><path d=\"M0,0 C6.5,-8 18.2,-6.8 26,0 C18.2,6.8 6.5,8 0,0Z\" transform=\"translate(72.3,227.8) rotate(-59.7)\"/></g><g fill=\"currentColor\" fill-opacity=\".85\"><path d=\"M0,0 C6,-8 16.8,-6.8 24,0 C16.8,6.8 6,8 0,0Z\" transform=\"translate(41.6,179.2) rotate(-136.1)\"/></g><g fill=\"currentColor\" fill-opacity=\".85\"><path d=\"M0,0 C5.5,-8 15.4,-6.8 22,0 C15.4,6.8 5.5,8 0,0Z\" transform=\"translate(79.7,132.3) rotate(-9.1)\"/></g><g fill=\"currentColor\" fill-opacity=\".85\"><path d=\"M0,0 C5,-8 14,-6.8 20,0 C14,6.8 5,8 0,0Z\" transform=\"translate(48.8,83.5) rotate(-193)\"/></g><g fill=\"currentColor\" fill-opacity=\".7\"><circle cx=\"96\" cy=\"60\" r=\"5\"/><circle cx=\"104\" cy=\"96\" r=\"3.5\"/><circle cx=\"22\" cy=\"150\" r=\"4\"/><circle cx=\"98\" cy=\"220\" r=\"5\"/><circle cx=\"20\" cy=\"300\" r=\"4\"/></g></svg>` },
    { id: 'vine-frostbranch', name: 'Frosted branch', motif: 'frostbranch', placement: 'vine', signature: true,
      themes: ['frost'], file: 'Asset/flairs/vine-frostbranch.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Frosted branch</title><desc id=\"d\">A frosted branch with icicles and snowflakes.</desc><path d=\"M60,354 C58.3,343.3 48.3,311.3 50,290 C51.7,268.7 70,247.7 70,226 C70,204.3 50.3,181.7 50,160 C49.7,138.3 67,117.7 68,96 C69,74.3 58,41 56,30\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\"/><path d=\"M52.3,318.7 l34,-14 M70.3,311.7 l6,-14 M70.3,311.7 l10,6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/><path d=\"M46.3,322.7 l-2,22\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" fill=\"none\"/><path d=\"M60.6,258.1 l-34,-14 M42.6,251.1 l-6,-14 M42.6,251.1 l-10,6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/><path d=\"M66.6,262.1 l2,22\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" fill=\"none\"/><path d=\"M63.1,199.6 l34,-14 M81.1,192.6 l6,-14 M81.1,192.6 l10,6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/><path d=\"M57.1,203.6 l-2,22\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" fill=\"none\"/><path d=\"M53.6,140.7 l-34,-14 M35.6,133.7 l-6,-14 M35.6,133.7 l-10,6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/><path d=\"M59.6,144.7 l2,22\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" fill=\"none\"/><path d=\"M67.3,81.9 l34,-14 M85.3,74.9 l6,-14 M85.3,74.9 l10,6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/><path d=\"M61.3,85.9 l-2,22\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" fill=\"none\"/><g transform=\"translate(30,330)\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"><path d=\"M0,0 L0,-12 M0,-4.6 L-3.1,-6.4 M0,-4.6 L3.1,-6.4 M0,-7.4 L-2.3,-8.8 M0,-7.4 L2.3,-8.8 M-1.2,-10.3 L0,-12 L1.2,-10.3\" transform=\"rotate(0)\"/><path d=\"M0,0 L0,-12 M0,-4.6 L-3.1,-6.4 M0,-4.6 L3.1,-6.4 M0,-7.4 L-2.3,-8.8 M0,-7.4 L2.3,-8.8 M-1.2,-10.3 L0,-12 L1.2,-10.3\" transform=\"rotate(60)\"/><path d=\"M0,0 L0,-12 M0,-4.6 L-3.1,-6.4 M0,-4.6 L3.1,-6.4 M0,-7.4 L-2.3,-8.8 M0,-7.4 L2.3,-8.8 M-1.2,-10.3 L0,-12 L1.2,-10.3\" transform=\"rotate(120)\"/><path d=\"M0,0 L0,-12 M0,-4.6 L-3.1,-6.4 M0,-4.6 L3.1,-6.4 M0,-7.4 L-2.3,-8.8 M0,-7.4 L2.3,-8.8 M-1.2,-10.3 L0,-12 L1.2,-10.3\" transform=\"rotate(180)\"/><path d=\"M0,0 L0,-12 M0,-4.6 L-3.1,-6.4 M0,-4.6 L3.1,-6.4 M0,-7.4 L-2.3,-8.8 M0,-7.4 L2.3,-8.8 M-1.2,-10.3 L0,-12 L1.2,-10.3\" transform=\"rotate(240)\"/><path d=\"M0,0 L0,-12 M0,-4.6 L-3.1,-6.4 M0,-4.6 L3.1,-6.4 M0,-7.4 L-2.3,-8.8 M0,-7.4 L2.3,-8.8 M-1.2,-10.3 L0,-12 L1.2,-10.3\" transform=\"rotate(300)\"/></g><g transform=\"translate(90,110)\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"><path d=\"M0,0 L0,-11 M0,-4.2 L-2.9,-5.8 M0,-4.2 L2.9,-5.8 M0,-6.8 L-2.1,-8 M0,-6.8 L2.1,-8 M-1.1,-9.5 L0,-11 L1.1,-9.5\" transform=\"rotate(0)\"/><path d=\"M0,0 L0,-11 M0,-4.2 L-2.9,-5.8 M0,-4.2 L2.9,-5.8 M0,-6.8 L-2.1,-8 M0,-6.8 L2.1,-8 M-1.1,-9.5 L0,-11 L1.1,-9.5\" transform=\"rotate(60)\"/><path d=\"M0,0 L0,-11 M0,-4.2 L-2.9,-5.8 M0,-4.2 L2.9,-5.8 M0,-6.8 L-2.1,-8 M0,-6.8 L2.1,-8 M-1.1,-9.5 L0,-11 L1.1,-9.5\" transform=\"rotate(120)\"/><path d=\"M0,0 L0,-11 M0,-4.2 L-2.9,-5.8 M0,-4.2 L2.9,-5.8 M0,-6.8 L-2.1,-8 M0,-6.8 L2.1,-8 M-1.1,-9.5 L0,-11 L1.1,-9.5\" transform=\"rotate(180)\"/><path d=\"M0,0 L0,-11 M0,-4.2 L-2.9,-5.8 M0,-4.2 L2.9,-5.8 M0,-6.8 L-2.1,-8 M0,-6.8 L2.1,-8 M-1.1,-9.5 L0,-11 L1.1,-9.5\" transform=\"rotate(240)\"/><path d=\"M0,0 L0,-11 M0,-4.2 L-2.9,-5.8 M0,-4.2 L2.9,-5.8 M0,-6.8 L-2.1,-8 M0,-6.8 L2.1,-8 M-1.1,-9.5 L0,-11 L1.1,-9.5\" transform=\"rotate(300)\"/></g></svg>` },
    { id: 'corner-nightshade', name: 'Crescent corner', motif: 'nightshade', placement: 'corners',
      themes: ['dark'], file: 'Asset/flairs/corner-nightshade.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Crescent corner</title><desc id=\"d\">A book-plate corner with a crescent moon and small stars.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M10,86 C10,48 40,18 86,10\" stroke-width=\"2.4\"/><path d=\"M22,86 C22,58 46,32 86,24\" stroke-width=\"1.2\" stroke-opacity=\".6\"/></g><g fill=\"currentColor\"><path d=\"M7.4,-11.9 A14,14 0 1 0 7.4,11.9 A12.8,12.8 0 1 1 7.4,-11.9Z\" transform=\"translate(32,32) rotate(-45)\"/><path d=\"M0,-6 Q0,0 6,0 Q0,0 0,6 Q0,0 -6,0 Q0,0 0,-6Z\" transform=\"translate(58,20)\"/><path d=\"M0,-6 Q0,0 6,0 Q0,0 0,6 Q0,0 -6,0 Q0,0 0,-6Z\" transform=\"translate(20,58)\"/><circle cx=\"86\" cy=\"10\" r=\"3.2\"/><circle cx=\"10\" cy=\"86\" r=\"3.2\"/><circle cx=\"46\" cy=\"46\" r=\"2.2\" fill-opacity=\".7\"/></g><g fill=\"currentColor\" fill-opacity=\".8\"><path d=\"M0,0 C4,-5 11.2,-4.2 16,0 C11.2,4.2 4,5 0,0Z\" transform=\"translate(30,62) rotate(70)\"/><path d=\"M0,0 C4,-5 11.2,-4.2 16,0 C11.2,4.2 4,5 0,0Z\" transform=\"translate(62,30) rotate(20)\"/></g></svg>` },
    { id: 'corner-bookrose', name: 'Wild rose corner', motif: 'bookrose', placement: 'corners',
      themes: ['light'], file: 'Asset/flairs/corner-bookrose.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Wild rose corner</title><desc id=\"d\">A book-plate corner with a wild rose and leaves.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M10,86 C10,48 40,18 86,10\" stroke-width=\"2.4\"/><path d=\"M22,86 C22,58 46,32 86,24\" stroke-width=\"1.2\" stroke-opacity=\".6\"/></g><g fill=\"currentColor\" fill-opacity=\".85\"><path d=\"M0,0 C5,-6 14,-5.1 20,0 C14,5.1 5,6 0,0Z\" transform=\"translate(22,60) rotate(75)\"/><path d=\"M0,0 C5,-6 14,-5.1 20,0 C14,5.1 5,6 0,0Z\" transform=\"translate(60,22) rotate(15)\"/><path d=\"M0,0 C3.5,-5 9.8,-4.2 14,0 C9.8,4.2 3.5,5 0,0Z\" transform=\"translate(40,40) rotate(45)\"/></g><g fill=\"currentColor\"><ellipse cx=\"40\" cy=\"26.7\" rx=\"9.4\" ry=\"8.2\" transform=\"rotate(-18 40 26.7)\" fill=\"currentColor\"/><ellipse cx=\"36.2\" cy=\"38.5\" rx=\"9.4\" ry=\"8.2\" transform=\"rotate(54 36.2 38.5)\" fill=\"currentColor\"/><ellipse cx=\"23.8\" cy=\"38.5\" rx=\"9.4\" ry=\"8.2\" transform=\"rotate(126 23.8 38.5)\" fill=\"currentColor\"/><ellipse cx=\"20\" cy=\"26.7\" rx=\"9.4\" ry=\"8.2\" transform=\"rotate(198 20 26.7)\" fill=\"currentColor\"/><ellipse cx=\"30\" cy=\"19.5\" rx=\"9.4\" ry=\"8.2\" transform=\"rotate(270 30 19.5)\" fill=\"currentColor\"/><circle cx=\"30\" cy=\"30\" r=\"4.4\" fill=\"currentColor\"/><circle cx=\"86\" cy=\"10\" r=\"3\"/><circle cx=\"10\" cy=\"86\" r=\"3\"/></g></svg>` },
    { id: 'corner-fireoak', name: 'Oak leaf corner', motif: 'fireoak', placement: 'corners',
      themes: ['hearthside'], file: 'Asset/flairs/corner-fireoak.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Oak leaf corner</title><desc id=\"d\">A book-plate corner with oak leaves and an acorn.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M10,86 C10,48 40,18 86,10\" stroke-width=\"2.4\"/><path d=\"M22,86 C22,58 46,32 86,24\" stroke-width=\"1.2\" stroke-opacity=\".6\"/></g><g transform=\"translate(14,66) rotate(-62)\" fill-opacity=\".9\"><ellipse cx=\"5.3\" cy=\"-4.1\" rx=\"3.7\" ry=\"3.5\" transform=\"rotate(12 5.3 -4.1)\" fill=\"currentColor\"/><ellipse cx=\"5.3\" cy=\"4.1\" rx=\"3.7\" ry=\"3.5\" transform=\"rotate(-12 5.3 4.1)\" fill=\"currentColor\"/><ellipse cx=\"10.1\" cy=\"-5.3\" rx=\"4.7\" ry=\"4.5\" transform=\"rotate(12 10.1 -5.3)\" fill=\"currentColor\"/><ellipse cx=\"10.1\" cy=\"5.3\" rx=\"4.7\" ry=\"4.5\" transform=\"rotate(-12 10.1 5.3)\" fill=\"currentColor\"/><ellipse cx=\"14.9\" cy=\"-4.3\" rx=\"3.7\" ry=\"3.7\" transform=\"rotate(12 14.9 -4.3)\" fill=\"currentColor\"/><ellipse cx=\"14.9\" cy=\"4.3\" rx=\"3.7\" ry=\"3.7\" transform=\"rotate(-12 14.9 4.3)\" fill=\"currentColor\"/><ellipse cx=\"19.2\" cy=\"-2.6\" rx=\"2.8\" ry=\"2.3\" transform=\"rotate(12 19.2 -2.6)\" fill=\"currentColor\"/><ellipse cx=\"19.2\" cy=\"2.6\" rx=\"2.8\" ry=\"2.3\" transform=\"rotate(-12 19.2 2.6)\" fill=\"currentColor\"/><ellipse cx=\"12\" cy=\"0\" rx=\"12\" ry=\"3.1\" fill=\"currentColor\"/><circle cx=\"23.5\" cy=\"0\" r=\"1.4\" fill=\"currentColor\"/><path d=\"M-2.9,0 L2.9,0\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/></g><g transform=\"translate(66,14) rotate(28)\" fill-opacity=\".9\"><ellipse cx=\"5.3\" cy=\"-4.1\" rx=\"3.7\" ry=\"3.5\" transform=\"rotate(12 5.3 -4.1)\" fill=\"currentColor\"/><ellipse cx=\"5.3\" cy=\"4.1\" rx=\"3.7\" ry=\"3.5\" transform=\"rotate(-12 5.3 4.1)\" fill=\"currentColor\"/><ellipse cx=\"10.1\" cy=\"-5.3\" rx=\"4.7\" ry=\"4.5\" transform=\"rotate(12 10.1 -5.3)\" fill=\"currentColor\"/><ellipse cx=\"10.1\" cy=\"5.3\" rx=\"4.7\" ry=\"4.5\" transform=\"rotate(-12 10.1 5.3)\" fill=\"currentColor\"/><ellipse cx=\"14.9\" cy=\"-4.3\" rx=\"3.7\" ry=\"3.7\" transform=\"rotate(12 14.9 -4.3)\" fill=\"currentColor\"/><ellipse cx=\"14.9\" cy=\"4.3\" rx=\"3.7\" ry=\"3.7\" transform=\"rotate(-12 14.9 4.3)\" fill=\"currentColor\"/><ellipse cx=\"19.2\" cy=\"-2.6\" rx=\"2.8\" ry=\"2.3\" transform=\"rotate(12 19.2 -2.6)\" fill=\"currentColor\"/><ellipse cx=\"19.2\" cy=\"2.6\" rx=\"2.8\" ry=\"2.3\" transform=\"rotate(-12 19.2 2.6)\" fill=\"currentColor\"/><ellipse cx=\"12\" cy=\"0\" rx=\"12\" ry=\"3.1\" fill=\"currentColor\"/><circle cx=\"23.5\" cy=\"0\" r=\"1.4\" fill=\"currentColor\"/><path d=\"M-2.9,0 L2.9,0\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/></g><g transform=\"translate(36,36) rotate(-45)\"><ellipse cx=\"0\" cy=\"3.1\" rx=\"5.6\" ry=\"7.6\" fill=\"currentColor\"/><path d=\"M-7.6,-1.6 C-7.6,-8.5 7.6,-8.5 7.6,-1.6 C3.6,-0.2 -3.6,-0.2 -7.6,-1.6Z\" fill=\"currentColor\"/><path d=\"M0,-8.5 L0,-12.2\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\"/></g><g fill=\"currentColor\"><circle cx=\"86\" cy=\"10\" r=\"3\"/><circle cx=\"10\" cy=\"86\" r=\"3\"/></g></svg>` },
    { id: 'corner-taper', name: 'Gilded flame corner', motif: 'taper', placement: 'corners',
      themes: ['candlelight'], file: 'Asset/flairs/corner-taper.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Gilded flame corner</title><desc id=\"d\">A book-plate corner with gilded scrolls and a small flame.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M10,86 C10,48 40,18 86,10\" stroke-width=\"2.4\"/><path d=\"M22,86 C22,58 46,32 86,24\" stroke-width=\"1.2\" stroke-opacity=\".6\"/><path d=\"M30,60 C20,50 24,34 38,34 C46,34 48,44 42,48\" stroke-width=\"1.6\"/></g><g fill=\"currentColor\"><path d=\"M0,0 C-6.6,-2.2 -6,-9.9 -0.8,-18 C0.4,-12.2 6.6,-9.4 5.6,-4.7 C4.9,-1.4 2.1,0 0,0Z\" transform=\"translate(40,28)\"/><circle cx=\"86\" cy=\"10\" r=\"3\"/><circle cx=\"10\" cy=\"86\" r=\"3\"/><path d=\"M0,-5 Q0,0 5,0 Q0,0 0,5 Q0,0 -5,0 Q0,0 0,-5Z\" transform=\"translate(60,52)\" fill-opacity=\".8\"/></g></svg>` },
    { id: 'corner-starcompass', name: 'Star corner', motif: 'starcompass', placement: 'corners',
      themes: ['twilight'], file: 'Asset/flairs/corner-starcompass.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Star corner</title><desc id=\"d\">A book-plate corner with a small constellation.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M10,86 L26,50 L52,40 L70,18 L86,10\" stroke-width=\"1.8\" stroke-opacity=\".7\"/><path d=\"M12,28 A24,24 0 0 1 28,12\" stroke-width=\"1.2\" stroke-opacity=\".6\"/></g><g fill=\"currentColor\"><path d=\"M26,44 L27.6,47.8 L31.7,48.1 L28.6,50.8 L29.5,54.9 L26,52.7 L22.5,54.9 L23.4,50.8 L20.3,48.1 L24.4,47.8Z\"/><path d=\"M52,35 L53.3,38.2 L56.8,38.5 L54.1,40.7 L54.9,44 L52,42.2 L49.1,44 L49.9,40.7 L47.2,38.5 L50.7,38.2Z\"/><path d=\"M70,12 L71.6,15.8 L75.7,16.1 L72.6,18.8 L73.5,22.9 L70,20.7 L66.5,22.9 L67.4,18.8 L64.3,16.1 L68.4,15.8Z\"/><circle cx=\"10\" cy=\"86\" r=\"3\"/><circle cx=\"86\" cy=\"10\" r=\"3\"/><path d=\"M0,-8 Q0,0 8,0 Q0,0 0,8 Q0,0 -8,0 Q0,0 0,-8Z\" transform=\"translate(36,24)\"/><path d=\"M0,-5 Q0,0 5,0 Q0,0 0,5 Q0,0 -5,0 Q0,0 0,-5Z\" transform=\"translate(60,62)\" fill-opacity=\".7\"/></g></svg>` },
    { id: 'corner-fernshroom', name: 'Fern corner', motif: 'fernshroom', placement: 'corners',
      themes: ['verdant'], file: 'Asset/flairs/corner-fernshroom.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Fern corner</title><desc id=\"d\">A book-plate corner with small fern fronds.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M10,86 C10,48 40,18 86,10\" stroke-width=\"2.4\"/><path d=\"M22,86 C22,58 46,32 86,24\" stroke-width=\"1.2\" stroke-opacity=\".6\"/></g><g fill=\"currentColor\"><circle cx=\"86\" cy=\"10\" r=\"3.2\"/><circle cx=\"10\" cy=\"86\" r=\"3.2\"/></g><g fill=\"currentColor\"><path d=\"M18,80 C19.5,76.5 23.1,66 26.8,59 C30.5,52 39.3,44.5 40,38 C40.7,31.5 32.7,23 31.2,20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/><path d=\"M0,0 C2.6,-2.7 7.3,-2.3 10.4,0 C7.3,2.3 2.6,2.7 0,0Z\" transform=\"translate(21.6,70.8) rotate(-130.4)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.6,-2.7 7.3,-2.3 10.4,0 C7.3,2.3 2.6,2.7 0,0Z\" transform=\"translate(21.6,70.8) rotate(-6.4)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.2,-2.3 6.2,-2 8.9,0 C6.2,2 2.2,2.3 0,0Z\" transform=\"translate(26.8,59) rotate(-124.4)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.2,-2.3 6.2,-2 8.9,0 C6.2,2 2.2,2.3 0,0Z\" transform=\"translate(26.8,59) rotate(-0.4)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.8,-1.9 5.1,-1.6 7.3,0 C5.1,1.6 1.8,1.9 0,0Z\" transform=\"translate(34.5,48.3) rotate(-114.3)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.8,-1.9 5.1,-1.6 7.3,0 C5.1,1.6 1.8,1.9 0,0Z\" transform=\"translate(34.5,48.3) rotate(9.7)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.4,-1.5 4,-1.3 5.8,0 C4,1.3 1.4,1.5 0,0Z\" transform=\"translate(40,38) rotate(-145.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.4,-1.5 4,-1.3 5.8,0 C4,1.3 1.4,1.5 0,0Z\" transform=\"translate(40,38) rotate(-21.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1,-1.1 2.9,-0.9 4.2,0 C2.9,0.9 1,1.1 0,0Z\" transform=\"translate(36.4,27.7) rotate(-184.5)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1,-1.1 2.9,-0.9 4.2,0 C2.9,0.9 1,1.1 0,0Z\" transform=\"translate(36.4,27.7) rotate(-60.5)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C0.9,-1.1 2.5,-0.9 3.6,0 C2.5,0.9 0.9,1.1 0,0Z\" transform=\"translate(31.3,20.1) rotate(-117.7)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M80,18 C78.5,14.5 74.9,4 71.2,-3 C67.5,-10 58.7,-17.5 58,-24 C57.3,-30.5 65.3,-39 66.8,-42\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/><path d=\"M0,0 C2.6,-2.7 7.3,-2.3 10.4,0 C7.3,2.3 2.6,2.7 0,0Z\" transform=\"translate(76.4,8.8) rotate(-173.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.6,-2.7 7.3,-2.3 10.4,0 C7.3,2.3 2.6,2.7 0,0Z\" transform=\"translate(76.4,8.8) rotate(-49.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.2,-2.3 6.2,-2 8.9,0 C6.2,2 2.2,2.3 0,0Z\" transform=\"translate(71.2,-3) rotate(-179.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C2.2,-2.3 6.2,-2 8.9,0 C6.2,2 2.2,2.3 0,0Z\" transform=\"translate(71.2,-3) rotate(-55.6)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.8,-1.9 5.1,-1.6 7.3,0 C5.1,1.6 1.8,1.9 0,0Z\" transform=\"translate(63.5,-13.7) rotate(-189.7)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.8,-1.9 5.1,-1.6 7.3,0 C5.1,1.6 1.8,1.9 0,0Z\" transform=\"translate(63.5,-13.7) rotate(-65.7)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.4,-1.5 4,-1.3 5.8,0 C4,1.3 1.4,1.5 0,0Z\" transform=\"translate(58,-24) rotate(-158.4)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1.4,-1.5 4,-1.3 5.8,0 C4,1.3 1.4,1.5 0,0Z\" transform=\"translate(58,-24) rotate(-34.4)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1,-1.1 2.9,-0.9 4.2,0 C2.9,0.9 1,1.1 0,0Z\" transform=\"translate(61.6,-34.3) rotate(-119.5)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C1,-1.1 2.9,-0.9 4.2,0 C2.9,0.9 1,1.1 0,0Z\" transform=\"translate(61.6,-34.3) rotate(4.5)\" fill=\"currentColor\" fill-opacity=\"0.85\"/><path d=\"M0,0 C0.9,-1.1 2.5,-0.9 3.6,0 C2.5,0.9 0.9,1.1 0,0Z\" transform=\"translate(66.7,-41.9) rotate(-62.3)\" fill=\"currentColor\" fill-opacity=\"0.85\"/></g></svg>` },
    { id: 'corner-moonphases', name: 'Moon corner', motif: 'moonphases', placement: 'corners',
      themes: ['midnight'], file: 'Asset/flairs/corner-moonphases.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Moon corner</title><desc id=\"d\">A book-plate corner with a crescent and stars.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M10,86 C10,48 40,18 86,10\" stroke-width=\"2.4\"/><path d=\"M22,86 C22,58 46,32 86,24\" stroke-width=\"1.2\" stroke-opacity=\".6\"/></g><g fill=\"currentColor\"><circle cx=\"86\" cy=\"10\" r=\"3.2\"/><circle cx=\"10\" cy=\"86\" r=\"3.2\"/></g><g fill=\"currentColor\"><path d=\"M7.9,-12.7 A15,15 0 1 0 7.9,12.7 A13.8,13.8 0 1 1 7.9,-12.7Z\" transform=\"translate(34,34) rotate(-45)\"/><path d=\"M0,-6 Q0,0 6,0 Q0,0 0,6 Q0,0 -6,0 Q0,0 0,-6Z\" transform=\"translate(62,22)\"/><path d=\"M0,-6 Q0,0 6,0 Q0,0 0,6 Q0,0 -6,0 Q0,0 0,-6Z\" transform=\"translate(22,62)\"/><circle cx=\"48\" cy=\"48\" r=\"2.2\"/></g></svg>` },
    { id: 'corner-thornrose', name: 'Rose corner', motif: 'thornrose', placement: 'corners',
      themes: ['velvet'], file: 'Asset/flairs/corner-thornrose.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Rose corner</title><desc id=\"d\">A book-plate corner with a rose.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M10,86 C10,48 40,18 86,10\" stroke-width=\"2.4\"/><path d=\"M22,86 C22,58 46,32 86,24\" stroke-width=\"1.2\" stroke-opacity=\".6\"/></g><g fill=\"currentColor\"><circle cx=\"86\" cy=\"10\" r=\"3.2\"/><circle cx=\"10\" cy=\"86\" r=\"3.2\"/></g><g fill=\"currentColor\"><g transform=\"translate(34,34)\"><path d=\"M18,0 Q21.4,10.3 11.2,14.1 Q5.3,23.2 -4,17.5 Q-14.8,18.6 -16.2,7.8 Q-23.8,0 -16.2,-7.8 Q-14.8,-18.6 -4,-17.5 Q5.3,-23.2 11.2,-14.1 Q21.4,-10.3 18,0Z\" fill=\"currentColor\"/><circle cx=\"0\" cy=\"0\" r=\"14\" fill=\"currentColor\" fill-opacity=\"0.3\"/><circle cx=\"0\" cy=\"0\" r=\"10.1\" fill=\"currentColor\" fill-opacity=\"0.25\"/><circle cx=\"0\" cy=\"0\" r=\"6.1\" fill=\"currentColor\" fill-opacity=\"0.2\"/><path d=\"M1.2,0.8 C1.2,1 1.3,1.4 1.2,1.7 C1.1,2 1,2.3 0.7,2.6 C0.5,2.9 0.1,3.2 -0.3,3.3 C-0.7,3.5 -1.2,3.6 -1.6,3.6 C-2.1,3.6 -2.7,3.5 -3.2,3.3 C-3.7,3 -4.3,2.7 -4.7,2.2 C-5.2,1.8 -5.6,1.2 -5.8,0.5 C-6.1,-0.1 -6.3,-0.9 -6.3,-1.7 C-6.3,-2.4 -6.1,-3.3 -5.8,-4.1 C-5.5,-4.8 -5.1,-5.7 -4.4,-6.3 C-3.8,-7 -3,-7.6 -2.2,-8.1 C-1.3,-8.5 -0.3,-8.9 0.8,-9 C1.8,-9.1 3,-9 4.1,-8.7 C5.2,-8.4 6.7,-7.5 7.3,-7.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-opacity=\".9\"/></g><path d=\"M0,0 C5,-6 14,-5.1 20,0 C14,5.1 5,6 0,0Z\" transform=\"translate(60,20) rotate(15)\"/><path d=\"M0,0 C5,-6 14,-5.1 20,0 C14,5.1 5,6 0,0Z\" transform=\"translate(20,60) rotate(75)\"/></g></svg>` },
    { id: 'corner-jellyfish', name: 'Kelp corner', motif: 'jellyfish', placement: 'corners',
      themes: ['abyss'], file: 'Asset/flairs/corner-jellyfish.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Kelp corner</title><desc id=\"d\">A book-plate corner with kelp and bubbles.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M10,86 C10,48 40,18 86,10\" stroke-width=\"2.4\"/><path d=\"M22,86 C22,58 46,32 86,24\" stroke-width=\"1.2\" stroke-opacity=\".6\"/></g><g fill=\"currentColor\"><circle cx=\"86\" cy=\"10\" r=\"3.2\"/><circle cx=\"10\" cy=\"86\" r=\"3.2\"/></g><g fill=\"currentColor\"><path d=\"M0,0 C5,-6 14,-5.1 20,0 C14,5.1 5,6 0,0Z\" transform=\"translate(30,60) rotate(70)\"/><path d=\"M0,0 C5,-6 14,-5.1 20,0 C14,5.1 5,6 0,0Z\" transform=\"translate(60,30) rotate(20)\"/><circle cx=\"40\" cy=\"40\" r=\"5\"/><circle cx=\"54\" cy=\"50\" r=\"3\"/><circle cx=\"30\" cy=\"26\" r=\"3\"/></g></svg>` },
    { id: 'corner-frostbranch', name: 'Snowflake corner', motif: 'frostbranch', placement: 'corners',
      themes: ['frost'], file: 'Asset/flairs/corner-frostbranch.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 96 96\" role=\"img\" aria-labelledby=\"t d\"><title id=\"t\">Snowflake corner</title><desc id=\"d\">A book-plate corner with a snowflake.</desc><g fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\"><path d=\"M10,86 C10,48 40,18 86,10\" stroke-width=\"2.4\"/><path d=\"M22,86 C22,58 46,32 86,24\" stroke-width=\"1.2\" stroke-opacity=\".6\"/></g><g fill=\"currentColor\"><circle cx=\"86\" cy=\"10\" r=\"3.2\"/><circle cx=\"10\" cy=\"86\" r=\"3.2\"/></g><g transform=\"translate(36,36)\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M0,0 L0,-22 M0,-8.4 L-5.7,-11.7 M0,-8.4 L5.7,-11.7 M0,-13.6 L-4.2,-16.1 M0,-13.6 L4.2,-16.1 M-2.2,-18.9 L0,-22 L2.2,-18.9\" transform=\"rotate(0)\"/><path d=\"M0,0 L0,-22 M0,-8.4 L-5.7,-11.7 M0,-8.4 L5.7,-11.7 M0,-13.6 L-4.2,-16.1 M0,-13.6 L4.2,-16.1 M-2.2,-18.9 L0,-22 L2.2,-18.9\" transform=\"rotate(60)\"/><path d=\"M0,0 L0,-22 M0,-8.4 L-5.7,-11.7 M0,-8.4 L5.7,-11.7 M0,-13.6 L-4.2,-16.1 M0,-13.6 L4.2,-16.1 M-2.2,-18.9 L0,-22 L2.2,-18.9\" transform=\"rotate(120)\"/><path d=\"M0,0 L0,-22 M0,-8.4 L-5.7,-11.7 M0,-8.4 L5.7,-11.7 M0,-13.6 L-4.2,-16.1 M0,-13.6 L4.2,-16.1 M-2.2,-18.9 L0,-22 L2.2,-18.9\" transform=\"rotate(180)\"/><path d=\"M0,0 L0,-22 M0,-8.4 L-5.7,-11.7 M0,-8.4 L5.7,-11.7 M0,-13.6 L-4.2,-16.1 M0,-13.6 L4.2,-16.1 M-2.2,-18.9 L0,-22 L2.2,-18.9\" transform=\"rotate(240)\"/><path d=\"M0,0 L0,-22 M0,-8.4 L-5.7,-11.7 M0,-8.4 L5.7,-11.7 M0,-13.6 L-4.2,-16.1 M0,-13.6 L4.2,-16.1 M-2.2,-18.9 L0,-22 L2.2,-18.9\" transform=\"rotate(300)\"/></g><g fill=\"currentColor\"><path d=\"M0,-5 Q0,0 5,0 Q0,0 0,5 Q0,0 -5,0 Q0,0 0,-5Z\" transform=\"translate(66,20)\"/><path d=\"M0,-5 Q0,0 5,0 Q0,0 0,5 Q0,0 -5,0 Q0,0 0,-5Z\" transform=\"translate(20,66)\"/></g></svg>` },

  ];

  var PLACEMENTS = ['vine', 'corners', 'divider', 'garland', 'watermark'];

  function byId(id) {
    for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i];
    return null;
  }

  // Best flair for a placement+theme: exact theme match first, then '*'
  // fallback; free entries win ties over premium.
  function flairFor(placement, theme) {
    var exact = [], star = [];
    for (var i = 0; i < CATALOG.length; i++) {
      var e = CATALOG[i];
      if (e.placement !== placement) continue;
      if (e.themes.indexOf(theme) >= 0) exact.push(e);
      else if (e.themes.indexOf('*') >= 0) star.push(e);
    }
    var pool = exact.length ? exact : star;
    if (!pool.length) return null;
    for (var j = 0; j < pool.length; j++) if (!pool[j].premium) return pool[j];
    return pool[0];
  }

  // Full theme-matched set. garland/vine may be null (non-seasonal themes
  // have no garland; fete + yuletide have no vine).
  function flairsForTheme(theme) {
    return {
      vine: flairFor('vine', theme),
      corners: flairFor('corners', theme),
      divider: flairFor('divider', theme),
      garland: flairFor('garland', theme),
      watermark: flairFor('watermark', theme),
    };
  }

  // v426: one signature flair per theme — the modal's single decorative
  // statement. Exact theme match. Seasonal garland wins ties (the theme's
  // seasonal identity is its signature); otherwise free entries win over
  // premium.
  function signatureFor(theme) {
    var exact = [];
    for (var i = 0; i < CATALOG.length; i++) {
      var e = CATALOG[i];
      if (!e.signature) continue;
      if (e.themes.indexOf(theme) >= 0) exact.push(e);
    }
    if (!exact.length) return null;
    for (var s = 0; s < exact.length; s++) if (exact[s].seasonal) return exact[s];
    for (var j = 0; j < exact.length; j++) if (!exact[j].premium) return exact[j];
    return exact[0];
  }

  // Namespace the SVG's internal title/desc ids per injection so repeated
  // flairs never produce duplicate ids.
  var _uid = 0;
  function namespaced(svg) {
    _uid++;
    var t = 'mfl-t-' + _uid, d = 'mfl-d-' + _uid;
    return svg
      .replace(/id="t"/g, 'id="' + t + '"')
      .replace(/id="d"/g, 'id="' + d + '"')
      .replace(/aria-labelledby="t d"/g, 'aria-labelledby="' + t + ' ' + d + '"');
  }

  function el(html) {
    var w = document.createElement('div');
    w.innerHTML = html;
    return w.firstChild;
  }

  // Remove previously injected flairs (idempotent re-apply, e.g. re-theme).
  function clear(root) {
    var olds = root.querySelectorAll('.mflair');
    for (var i = 0; i < olds.length; i++) olds[i].remove();
  }

  function sectionBlocks(panel) {
    // Top-level Details-panel sections that dividers sit between.
    var out = [], kids = panel.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.classList && (k.classList.contains('field') || k.tagName === 'DETAILS' || k.id === 'm-buywrap')) {
        if (k.id === 'm-progress' && !k.innerHTML.trim()) continue; // empty placeholder
        if (k.hidden) continue;
        out.push(k);
      }
    }
    return out;
  }

  // v426: signature system — one flair per modal. Renders:
  //  1. the theme's signature at full presence (vine in hero, garland as an
  //     in-flow banner above the Details panel, watermark as backdrop),
  //  2. the watermark faint as before (skipped when the watermark IS the
  //     signature — midnight/twilight get one moon, not two),
  //  3. plain hairline separators between section blocks — no motifs.
  // Corners are retired from injection; the absolute top-edge garland is
  // retired (seasonal garlands now live in the document flow).
  function apply(root) {
    root = root || document;
    var modal = root.querySelector ? root.querySelector('#modal-root .modal') : null;
    if (!modal) return false;
    clear(modal);
    var theme = (typeof getTheme === 'function') ? getTheme() : 'dark';
    var sig = signatureFor(theme);
    var wm = flairFor('watermark', theme);
    var panel = modal.querySelector('#dtab-details');

    if (sig) {
      if (sig.placement === 'garland') {
        // in-flow banner: full-width, normal document flow — physically
        // cannot overlap the cover or nav chrome
        var banner = el('<div class="mflair mflair-banner" aria-hidden="true">' +
          namespaced(sig.svg) + '</div>');
        if (panel && panel.parentNode) panel.parentNode.insertBefore(banner, panel);
        else {
          var bh = modal.querySelector('.d-hero');
          if (bh && bh.parentNode) bh.parentNode.insertBefore(banner, bh.nextSibling);
          else modal.appendChild(banner);
        }
      } else if (sig.placement === 'vine') {
        var hv = modal.querySelector('.d-hero');
        var vcls = sig.id === 'stormrider-vine' ? ' mflair-vine--emblem' : '';
        if (hv) hv.appendChild(el('<div class="mflair mflair-vine' + vcls + '" aria-hidden="true">' +
          namespaced(sig.svg) + '</div>'));
      } else if (sig.placement === 'watermark') {
        modal.insertBefore(el('<div class="mflair mflair-watermark" aria-hidden="true">' +
          namespaced(sig.svg) + '</div>'), modal.firstChild);
      }
    }
    // corners: theme-matched book-plate ornaments at the modal bottom corners,
    // clear of the hero vine. Secondary to the signature (max 2 decorative
    // elements per the restraint rule).
    var cn = flairFor('corners', theme);
    if (cn) {
      modal.insertBefore(el('<div class="mflair mflair-corners" aria-hidden="true">' +
        '<span class="mflair-corner mflair-corner-tl">' + namespaced(cn.svg) + '</span>' +
        '<span class="mflair-corner mflair-corner-tr">' + namespaced(cn.svg) + '</span>' +
        '</div>'), modal.firstChild);
    }
    // watermark stays faint as today, unless it is the signature — but yields
    // to corners (vine + corners is already 2 elements; a watermark would be
    // a third, violating the restraint rule).
    if (wm && (!sig || wm.id !== sig.id) && !cn) {
      modal.insertBefore(el('<div class="mflair mflair-watermark" aria-hidden="true">' +
        namespaced(wm.svg) + '</div>'), modal.firstChild);
    }
    // divider ornaments retired — plain hairlines between section blocks
    if (panel) {
      var blocks = sectionBlocks(panel);
      for (var i = blocks.length - 1; i > 0; i--) {
        panel.insertBefore(el('<div class="mflair mflair-divider-plain" aria-hidden="true">' +
          '<span class="hairline"></span></div>'), blocks[i]);
      }
    }
    return true;
  }

  // Re-apply to the open modal (theme changed while open).
  function refresh() {
    var modal = document.querySelector ? document.querySelector('#modal-root .modal') : null;
    if (modal) apply(document);
  }

  return {
    CATALOG: CATALOG,
    PLACEMENTS: PLACEMENTS,
    byId: byId,
    flairFor: flairFor,
    flairsForTheme: flairsForTheme,
    signatureFor: signatureFor,
    apply: apply,
    refresh: refresh,
  };
})();
