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
     corners   — book-plate corners at the modal top corners, below the
                 back/⋮ chrome
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
    { id: 'vine-botanical', name: 'Botanical laurel vine', motif: 'laurel', placement: 'vine', signature: true,
      themes: ['light'], file: 'Asset/flairs/vine-botanical.svg',
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 360" role="img" aria-labelledby="t d">
<title id="t">Botanical laurel vine</title>
<desc id="d">A trailing vine of paired laurel leaves on a curving stem, with budding tips.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M60,352 C46,305 74,268 58,218 C46,178 70,138 56,92 C50,66 60,38 54,12"/>
<path d="M59,240 C44,234 36,222 34,206" stroke-width="1.4"/>
<path d="M57,150 C71,144 79,132 81,116" stroke-width="1.4"/>
</g>
<g fill="currentColor" stroke="none">
<!-- paired leaves: each leaf offset from the stem, inner tip at the node -->
<g transform="rotate(-38 52 302)"><ellipse cx="41" cy="299" rx="12" ry="4.6"/></g>
<g transform="rotate(38 52 302)"><ellipse cx="63" cy="299" rx="12" ry="4.6"/></g>
<g transform="rotate(-36 62 256)"><ellipse cx="51" cy="253" rx="11" ry="4.2"/></g>
<g transform="rotate(36 62 256)"><ellipse cx="73" cy="253" rx="11" ry="4.2"/></g>
<g transform="rotate(-34 57 210)"><ellipse cx="47" cy="207" rx="10" ry="4"/></g>
<g transform="rotate(34 57 210)"><ellipse cx="67" cy="207" rx="10" ry="4"/></g>
<g transform="rotate(-32 54 164)"><ellipse cx="45" cy="161" rx="9" ry="3.6"/></g>
<g transform="rotate(32 54 164)"><ellipse cx="63" cy="161" rx="9" ry="3.6"/></g>
<g transform="rotate(-30 59 118)"><ellipse cx="51" cy="115" rx="8" ry="3.2"/></g>
<g transform="rotate(30 59 118)"><ellipse cx="67" cy="115" rx="8" ry="3.2"/></g>
<g transform="rotate(-28 55 74)"><ellipse cx="48" cy="71" rx="7" ry="2.8"/></g>
<g transform="rotate(28 55 74)"><ellipse cx="62" cy="71" rx="7" ry="2.8"/></g>
<!-- branch-tip leaves -->
<g transform="rotate(-52 34 204)"><ellipse cx="27" cy="200" rx="7.5" ry="3"/></g>
<g transform="rotate(52 81 114)"><ellipse cx="88" cy="110" rx="7.5" ry="3"/></g>
<!-- top buds -->
<circle cx="54" cy="12" r="3.6"/>
<circle cx="46" cy="19" r="2.4"/>
<circle cx="62" cy="19" r="2.4"/>
</g>
</svg>` },
    { id: 'vine-ember', name: 'Ember wheat vine', motif: 'ember', placement: 'vine', signature: true,
      themes: ['hearthside'], file: 'Asset/flairs/vine-ember.svg',
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 360" role="img" aria-labelledby="t d">
<title id="t">Ember wheat vine</title>
<desc id="d">Upright wheat stalks with grain kernels and a curling flame-tipped tendril.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M42,352 C38,300 46,240 42,180 C40,140 46,100 44,60"/>
<path d="M72,352 C76,310 68,270 73,230 C77,195 70,160 74,125" stroke-width="1.8"/>
<path d="M58,352 C50,320 66,300 58,270 C52,248 64,232 60,210" stroke-width="1.4"/>
<path d="M60,210 C70,202 78,190 79,176 C80,166 76,158 70,154 C74,160 74,168 70,174" stroke-width="1.4"/>
</g>
<g fill="currentColor" stroke="none">
<!-- wheat kernels: paired grains along the two main rachises -->
<g>
<ellipse cx="34" cy="180" rx="7" ry="3" transform="rotate(-55 34 180)"/><ellipse cx="50" cy="180" rx="7" ry="3" transform="rotate(55 50 180)"/>
<ellipse cx="34" cy="160" rx="6.6" ry="2.8" transform="rotate(-55 34 160)"/><ellipse cx="50" cy="160" rx="6.6" ry="2.8" transform="rotate(55 50 160)"/>
<ellipse cx="34" cy="140" rx="6.2" ry="2.6" transform="rotate(-55 34 140)"/><ellipse cx="50" cy="140" rx="6.2" ry="2.6" transform="rotate(55 50 140)"/>
<ellipse cx="35" cy="120" rx="5.8" ry="2.4" transform="rotate(-55 35 120)"/><ellipse cx="49" cy="120" rx="5.8" ry="2.4" transform="rotate(55 49 120)"/>
<ellipse cx="36" cy="100" rx="5.4" ry="2.2" transform="rotate(-55 36 100)"/><ellipse cx="48" cy="100" rx="5.4" ry="2.2" transform="rotate(55 48 100)"/>
<ellipse cx="38" cy="80" rx="5" ry="2" transform="rotate(-55 38 80)"/><ellipse cx="46" cy="80" rx="5" ry="2" transform="rotate(55 46 80)"/>
<ellipse cx="42" cy="58" rx="4.6" ry="2.4"/>
</g>
<g>
<ellipse cx="65" cy="230" rx="6.4" ry="2.8" transform="rotate(-55 65 230)"/><ellipse cx="81" cy="230" rx="6.4" ry="2.8" transform="rotate(55 81 230)"/>
<ellipse cx="64" cy="210" rx="6" ry="2.6" transform="rotate(-55 64 210)"/><ellipse cx="82" cy="210" rx="6" ry="2.6" transform="rotate(55 82 210)"/>
<ellipse cx="63" cy="190" rx="5.6" ry="2.4" transform="rotate(-55 63 190)"/><ellipse cx="83" cy="190" rx="5.6" ry="2.4" transform="rotate(55 83 190)"/>
<ellipse cx="64" cy="170" rx="5.2" ry="2.2" transform="rotate(-55 64 170)"/><ellipse cx="82" cy="170" rx="5.2" ry="2.2" transform="rotate(55 82 170)"/>
<ellipse cx="66" cy="150" rx="4.8" ry="2" transform="rotate(-55 66 150)"/><ellipse cx="80" cy="150" rx="4.8" ry="2" transform="rotate(55 80 150)"/>
<ellipse cx="72" cy="132" rx="4.2" ry="2" transform="rotate(-25 72 132)"/><ellipse cx="72" cy="132" rx="4.2" ry="2" transform="rotate(25 72 132)"/>
</g>
<!-- curling tendril tip -->
<circle cx="70" cy="154" r="2.4"/>
<!-- scattered grain dots -->
<circle cx="58" cy="270" r="2.2"/><circle cx="52" cy="300" r="2.2"/><circle cx="88" cy="270" r="2"/>
</g>
</svg>` },
    { id: 'vine-rose', name: 'Rose cane vine', motif: 'rose', placement: 'vine', signature: true,
      themes: ['velvet', 'amour'], file: 'Asset/flairs/vine-rose.svg',
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 360" role="img" aria-labelledby="t d">
<title id="t">Rose cane vine</title>
<desc id="d">A thorny rose cane with leaves and two rosebuds.</desc>
<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
<path d="M55,352 C48,305 68,270 56,222 C47,184 66,148 56,108 C50,84 60,58 55,40"/>
<path d="M56,222 C42,216 34,204 32,190" stroke-width="1.4"/>
</g>
<g fill="currentColor" stroke="none">
<path d="M52,280 l-7,-3 6,-4z"/><path d="M60,250 l7,-3 -6,-4z"/>
<path d="M54,190 l-7,-3 6,-4z"/><path d="M58,140 l7,-3 -6,-4z"/>
<path d="M54,96 l-6,-3 5,-4z"/>
</g>
<g fill="currentColor" stroke="none">
<g transform="rotate(-40 48 300)"><ellipse cx="38" cy="297" rx="11" ry="4.4"/></g>
<g transform="rotate(40 62 262)"><ellipse cx="72" cy="259" rx="11" ry="4.4"/></g>
<g transform="rotate(-40 50 200)"><ellipse cx="41" cy="197" rx="10" ry="4"/></g>
<g transform="rotate(40 60 160)"><ellipse cx="69" cy="157" rx="10" ry="4"/></g>
<g transform="rotate(-38 52 120)"><ellipse cx="44" cy="117" rx="8.5" ry="3.4"/></g>
<g transform="rotate(-52 26 186)"><ellipse cx="19" cy="182" rx="7.5" ry="3"/></g>
</g>
<!-- rosebuds: teardrop bloom + inner petal + sepals -->
<g transform="translate(55,30)">
<path d="M0,-13 C7,-9 9,-1 5,6 C2,11 -2,11 -5,6 C-9,-1 -7,-9 0,-13Z" fill="none" stroke="currentColor" stroke-width="2"/>
<path d="M0,-7 C3,-4 4,1 2,5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
<path d="M-4,11 L-10,17 M0,12 L0,19 M4,11 L10,17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</g>
<g transform="translate(30,188) scale(.7)">
<path d="M0,-13 C7,-9 9,-1 5,6 C2,11 -2,11 -5,6 C-9,-1 -7,-9 0,-13Z" fill="none" stroke="currentColor" stroke-width="2.6"/>
<path d="M0,-7 C3,-4 4,1 2,5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
<path d="M-4,11 L-10,17 M0,12 L0,19 M4,11 L10,17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
</g>
</svg>` },
    { id: 'vine-frostcrystal', name: 'Frost crystal spray', motif: 'frost', placement: 'vine', signature: true,
      themes: ['frost'], file: 'Asset/flairs/vine-frostcrystal.svg',
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 360" role="img" aria-labelledby="t d">
<title id="t">Frost crystal spray</title>
<desc id="d">A curving branch bearing hexagonal frost crystals of decreasing size, with ice dots.</desc>
<g fill="none" stroke="currentColor" stroke-linecap="round">
<path d="M60,352 C54,300 66,242 58,182 C52,132 62,82 58,32" stroke-width="1.8"/>
<!-- crystals: hexagon + three arms + center dot -->
<g stroke-width="1.6">
<path d="M66,300 L59,288 L45,288 L38,300 L45,312 L59,312 Z"/>
<path d="M52,288 L52,312 M41.6,294 L62.4,306 M62.4,294 L41.6,306" stroke-width="1"/>
</g>
<g stroke-width="1.5">
<path d="M78,250 L72,240 L60,240 L54,250 L60,260 L72,260 Z"/>
<path d="M66,240 L66,260 M57.4,245 L74.6,255 M74.6,245 L57.4,255" stroke-width="1"/>
</g>
<g stroke-width="1.4">
<path d="M64,200 L59,191 L49,191 L44,200 L49,209 L59,209 Z"/>
<path d="M54,191 L54,209 M46.1,195.5 L61.9,204.5 M61.9,195.5 L46.1,204.5" stroke-width="0.9"/>
</g>
<g stroke-width="1.3">
<path d="M70,150 L66,143 L58,143 L54,150 L58,157 L66,157 Z"/>
<path d="M62,143 L62,157 M55.8,146.5 L68.2,153.5 M68.2,146.5 L55.8,153.5" stroke-width="0.9"/>
</g>
<g stroke-width="1.2">
<path d="M63,100 L60,95 L54,95 L51,100 L54,105 L60,105 Z"/>
<path d="M57,95 L57,105 M52.7,97.5 L61.3,102.5 M61.3,97.5 L52.7,102.5" stroke-width="0.8"/>
</g>
<g stroke-width="1.1">
<path d="M62,56 L60,52 L56,52 L54,56 L56,60 L60,60 Z"/>
<path d="M58,52 L58,60" stroke-width="0.8"/>
</g>
</g>
<g fill="currentColor" stroke="none">
<circle cx="52" cy="300" r="1.8"/><circle cx="66" cy="250" r="1.6"/><circle cx="54" cy="200" r="1.5"/>
<circle cx="62" cy="150" r="1.4"/><circle cx="57" cy="100" r="1.3"/><circle cx="58" cy="56" r="1.2"/>
<!-- ice dots -->
<circle cx="36" cy="270" r="1.6"/><circle cx="80" cy="224" r="1.6"/><circle cx="40" cy="176" r="1.5"/>
<circle cx="76" cy="128" r="1.5"/><circle cx="44" cy="84" r="1.4"/><circle cx="70" cy="40" r="1.4"/>
<circle cx="58" cy="32" r="2"/>
</g>
</svg>` },
    { id: 'vine-kelp', name: 'Abyssal kelp strands', motif: 'kelp', placement: 'vine', signature: true,
      themes: ['abyss'], file: 'Asset/flairs/vine-kelp.svg',
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 360" role="img" aria-labelledby="t d">
<title id="t">Abyssal kelp strands</title>
<desc id="d">Flowing kelp ribbons with pneumatocyst air bladders, drifting upward.</desc>
<g fill="currentColor" stroke="none" opacity="0.92">
<path d="M46,352 C38,310 52,285 46,250 C41,222 50,200 47,175 C45,155 48,140 47,128
C49,142 54,160 56,180 C59,205 50,228 55,255 C60,285 50,315 52,352Z"/>
<path d="M74,352 C80,315 68,292 74,260 C79,235 70,215 74,192 C77,175 73,160 75,148
C77,162 82,180 80,200 C78,225 86,245 82,270 C78,300 86,325 82,352Z"/>
</g>
<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
<!-- pneumatocyst stalks -->
<path d="M44,240 l-12,-6"/><path d="M50,200 l12,-7"/><path d="M46,160 l-11,-5"/>
<path d="M76,250 l11,-6"/><path d="M76,210 l-11,-6"/><path d="M75,170 l10,-5"/>
</g>
<g fill="currentColor" stroke="none">
<circle cx="30" cy="232" r="4"/><circle cx="64" cy="191" r="4"/><circle cx="33" cy="153" r="3.4"/>
<circle cx="89" cy="242" r="3.6"/><circle cx="63" cy="202" r="3.4"/><circle cx="87" cy="163" r="3"/>
<!-- blade leaves -->
<ellipse cx="30" cy="280" rx="9" ry="3" transform="rotate(-50 30 280)"/>
<ellipse cx="64" cy="140" rx="8" ry="2.8" transform="rotate(42 64 140)"/>
<ellipse cx="90" cy="300" rx="8" ry="2.8" transform="rotate(50 90 300)"/>
<!-- rising bubbles -->
<circle cx="47" cy="110" r="2.6"/><circle cx="54" cy="96" r="2"/><circle cx="43" cy="86" r="1.5"/>
<circle cx="75" cy="130" r="2"/><circle cx="81" cy="118" r="1.5"/>
</g>
</svg>` },
    { id: 'vine-sprig', name: 'Minimal laurel sprig', motif: 'sprig', placement: 'vine', signature: true,
      themes: ['dark'], file: 'Asset/flairs/vine-sprig.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\">
<title id=\"t\">Minimal laurel sprig</title>
<desc id=\"d\">A single quiet laurel sprig with clear leaves and breathing room — the restrained signature for Dark.</desc>
<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\">
<path d=\"M60,352 C54,300 66,252 58,202 C52,158 62,112 56,68 C53,42 58,24 55,10\"/>
</g>
<g fill=\"currentColor\" stroke=\"none\">
<!-- four leaf pairs, present but unhurried -->
<g transform=\"rotate(-34 50 288)\"><ellipse cx=\"40\" cy=\"285\" rx=\"11\" ry=\"4.2\"/></g>
<g transform=\"rotate(34 50 288)\"><ellipse cx=\"60\" cy=\"285\" rx=\"11\" ry=\"4.2\"/></g>
<g transform=\"rotate(-32 55 228)\"><ellipse cx=\"46\" cy=\"225\" rx=\"10\" ry=\"3.8\"/></g>
<g transform=\"rotate(32 55 228)\"><ellipse cx=\"64\" cy=\"225\" rx=\"10\" ry=\"3.8\"/></g>
<g transform=\"rotate(-30 57 168)\"><ellipse cx=\"49\" cy=\"165\" rx=\"9\" ry=\"3.4\"/></g>
<g transform=\"rotate(30 57 168)\"><ellipse cx=\"65\" cy=\"165\" rx=\"9\" ry=\"3.4\"/></g>
<g transform=\"rotate(-28 56 108)\"><ellipse cx=\"49\" cy=\"105\" rx=\"8\" ry=\"3\"/></g>
<g transform=\"rotate(28 56 108)\"><ellipse cx=\"63\" cy=\"105\" rx=\"8\" ry=\"3\"/></g>
<circle cx=\"55\" cy=\"10\" r=\"3.4\"/>
</g>
</svg>` },
    { id: 'vine-candle', name: 'Candle and flame', motif: 'candle', placement: 'vine', signature: true,
      themes: ['candlelight'], file: 'Asset/flairs/vine-candle.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\">
<title id=\"t\">Candle and flame</title>
<desc id=\"d\">A slender candle with a generous flame and radiating glow lines — the signature for Candlelight.</desc>
<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\">
<!-- glow rays above the flame -->
<path d=\"M60,60 L60,44\" opacity=\"0.6\"/>
<path d=\"M38,76 L28,66\" opacity=\"0.6\"/>
<path d=\"M82,76 L92,66\" opacity=\"0.6\"/>
<path d=\"M30,110 L16,106\" opacity=\"0.5\"/>
<path d=\"M90,110 L104,106\" opacity=\"0.5\"/>
<!-- candle body -->
<path d=\"M48,352 L48,268 C48,262 52,258 56,260 C58,268 62,268 64,260 C68,258 72,262 72,268 L72,352\"/>
<!-- melted wax drip -->
<path d=\"M52,268 C52,278 50,286 52,294\" stroke-width=\"1.4\" opacity=\"0.7\"/>
</g>
<g fill=\"currentColor\" stroke=\"none\">
<!-- flame: generous teardrop, rounded base, soft tip -->
<path d=\"M60,250 C46,250 40,236 42,220 C44,202 42,180 48,158 C51,146 54,132 60,118 C64,132 70,148 69,166 C68,188 74,208 71,228 C69,242 66,250 60,250Z\"/>
<!-- flame heart -->
<ellipse cx=\"60\" cy=\"215\" rx=\"7\" ry=\"18\" opacity=\"0.45\"/>
<!-- wick -->
<rect x=\"58.5\" y=\"248\" width=\"3\" height=\"12\" rx=\"1.5\"/>
<!-- leaves at the candle base -->
<g transform=\"rotate(-35 40 340)\"><ellipse cx=\"32\" cy=\"338\" rx=\"9\" ry=\"3.4\"/></g>
<g transform=\"rotate(35 80 340)\"><ellipse cx=\"88\" cy=\"338\" rx=\"9\" ry=\"3.4\"/></g>
<!-- wax pool -->
<ellipse cx=\"60\" cy=\"352\" rx=\"16\" ry=\"4\" opacity=\"0.5\"/>
</g>
</svg>` },
    { id: 'vine-lush', name: 'Lush botanical vine', motif: 'lush', placement: 'vine', signature: true,
      themes: ['verdant'], file: 'Asset/flairs/vine-lush.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 360\" role=\"img\" aria-labelledby=\"t d\">
<title id=\"t\">Lush botanical vine</title>
<desc id=\"d\">A dense intertwining vine of paired laurel leaves on two curving stems — the expressive botanical signature for Verdant.</desc>
<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\">
<path d=\"M60,352 C46,305 74,268 58,218 C46,178 70,138 56,92 C50,66 60,38 54,12\"/>
<path d=\"M62,350 C74,310 50,275 64,230 C74,195 52,155 64,110 C70,85 60,55 66,25\" stroke-width=\"1.6\"/>
<path d=\"M59,240 C44,234 36,222 34,206\" stroke-width=\"1.4\"/>
<path d=\"M57,150 C71,144 79,132 81,116\" stroke-width=\"1.4\"/>
<path d=\"M64,290 C78,284 86,272 88,256\" stroke-width=\"1.4\"/>
<path d=\"M63,180 C49,174 41,162 39,146\" stroke-width=\"1.4\"/>
</g>
<g fill=\"currentColor\" stroke=\"none\">
<!-- main stem leaves: denser pairs -->
<g transform=\"rotate(-38 52 310)\"><ellipse cx=\"41\" cy=\"307\" rx=\"12\" ry=\"4.6\"/></g>
<g transform=\"rotate(38 52 310)\"><ellipse cx=\"63\" cy=\"307\" rx=\"12\" ry=\"4.6\"/></g>
<g transform=\"rotate(-36 58 272)\"><ellipse cx=\"47\" cy=\"269\" rx=\"11.5\" ry=\"4.4\"/></g>
<g transform=\"rotate(36 58 272)\"><ellipse cx=\"69\" cy=\"269\" rx=\"11.5\" ry=\"4.4\"/></g>
<g transform=\"rotate(-34 57 232)\"><ellipse cx=\"47\" cy=\"229\" rx=\"11\" ry=\"4.2\"/></g>
<g transform=\"rotate(34 57 232)\"><ellipse cx=\"67\" cy=\"229\" rx=\"11\" ry=\"4.2\"/></g>
<g transform=\"rotate(-32 55 192)\"><ellipse cx=\"46\" cy=\"189\" rx=\"10.5\" ry=\"4\"/></g>
<g transform=\"rotate(32 55 192)\"><ellipse cx=\"64\" cy=\"189\" rx=\"10.5\" ry=\"4\"/></g>
<g transform=\"rotate(-30 56 152)\"><ellipse cx=\"48\" cy=\"149\" rx=\"10\" ry=\"3.8\"/></g>
<g transform=\"rotate(30 56 152)\"><ellipse cx=\"64\" cy=\"149\" rx=\"10\" ry=\"3.8\"/></g>
<g transform=\"rotate(-28 55 112)\"><ellipse cx=\"48\" cy=\"109\" rx=\"9\" ry=\"3.4\"/></g>
<g transform=\"rotate(28 55 112)\"><ellipse cx=\"62\" cy=\"109\" rx=\"9\" ry=\"3.4\"/></g>
<g transform=\"rotate(-26 55 72)\"><ellipse cx=\"49\" cy=\"69\" rx=\"8\" ry=\"3\"/></g>
<g transform=\"rotate(26 55 72)\"><ellipse cx=\"61\" cy=\"69\" rx=\"8\" ry=\"3\"/></g>
<!-- second stem leaves -->
<g transform=\"rotate(40 70 300)\"><ellipse cx=\"79\" cy=\"297\" rx=\"9\" ry=\"3.4\"/></g>
<g transform=\"rotate(-40 56 250)\"><ellipse cx=\"47\" cy=\"247\" rx=\"8.5\" ry=\"3.2\"/></g>
<g transform=\"rotate(38 70 200)\"><ellipse cx=\"79\" cy=\"197\" rx=\"8\" ry=\"3\"/></g>
<g transform=\"rotate(-38 58 150)\"><ellipse cx=\"50\" cy=\"147\" rx=\"7.5\" ry=\"2.8\"/></g>
<g transform=\"rotate(36 66 100)\"><ellipse cx=\"74\" cy=\"97\" rx=\"7\" ry=\"2.6\"/></g>
<g transform=\"rotate(-34 60 55)\"><ellipse cx=\"53\" cy=\"52\" rx=\"6.5\" ry=\"2.4\"/></g>
<!-- top buds -->
<circle cx=\"54\" cy=\"12\" r=\"3.6\"/>
<circle cx=\"46\" cy=\"19\" r=\"2.4\"/>
<circle cx=\"62\" cy=\"19\" r=\"2.4\"/>
<circle cx=\"66\" cy=\"25\" r=\"2.8\"/>
</g>
</svg>` },
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
    { id: 'watermark-moonstars', name: 'Moon and starfield watermark', motif: 'moonstars', placement: 'watermark', signature: true,
      themes: ['midnight'], file: 'Asset/flairs/watermark-moonstars.svg',
      svg: `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 400 400\" role=\"img\" aria-labelledby=\"t d\">
<title id=\"t\">Moon and starfield watermark</title>
<desc id=\"d\">A crescent moon in a dense starfield — the celestial watermark signature for Midnight, distinct from Twilight's lone moon.</desc>
<g fill=\"currentColor\" stroke=\"none\">
<!-- crescent moon -->
<path d=\"M200,120 C160,120 128,152 128,192 C128,232 160,264 200,264 C172,244 160,220 160,192 C160,164 172,140 200,120Z\"/>
<!-- dense starfield: varied sparkles and dots -->
<g opacity=\"0.85\">
<path d=\"M80,80 l2.4,6 6,2.4 -6,2.4 -2.4,6 -2.4,-6 -6,-2.4 6,-2.4z\"/>
<path d=\"M320,70 l2,5 5,2 -5,2 -2,5 -2,-5 -5,-2 5,-2z\"/>
<path d=\"M280,320 l2.4,6 6,2.4 -6,2.4 -2.4,6 -2.4,-6 -6,-2.4 6,-2.4z\"/>
<path d=\"M100,300 l1.8,4.6 4.6,1.8 -4.6,1.8 -1.8,4.6 -1.8,-4.6 -4.6,-1.8 4.6,-1.8z\"/>
<path d=\"M350,200 l1.8,4.6 4.6,1.8 -4.6,1.8 -1.8,4.6 -1.8,-4.6 -4.6,-1.8 4.6,-1.8z\"/>
<path d=\"M60,180 l1.6,4 4,1.6 -4,1.6 -1.6,4 -1.6,-4 -4,-1.6 4,-1.6z\"/>
</g>
<g opacity=\"0.55\">
<circle cx=\"140\" cy=\"60\" r=\"2.2\"/><circle cx=\"220\" cy=\"50\" r=\"1.8\"/><circle cx=\"300\" cy=\"140\" r=\"2\"/>
<circle cx=\"360\" cy=\"120\" r=\"1.6\"/><circle cx=\"40\" cy=\"240\" r=\"2\"/><circle cx=\"90\" cy=\"350\" r=\"1.8\"/>
<circle cx=\"180\" cy=\"340\" r=\"2.2\"/><circle cx=\"250\" cy=\"280\" r=\"1.6\"/><circle cx=\"330\" cy=\"260\" r=\"2\"/>
<circle cx=\"120\" cy=\"140\" r=\"1.6\"/><circle cx=\"240\" cy=\"110\" r=\"1.8\"/><circle cx=\"200\" cy=\"300\" r=\"1.6\"/>
</g>
<!-- faint constellation lines tying a few stars -->
<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"1\" opacity=\"0.35\" stroke-linecap=\"round\">
<path d=\"M140,60 L220,50 L300,140\"/>
<path d=\"M90,350 L180,340 L250,280\"/>
</g>
</g>
</svg>` },
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
</svg>` },
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
    // watermark stays faint as today, unless it is the signature
    if (wm && (!sig || wm.id !== sig.id)) {
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
