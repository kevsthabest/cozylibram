-- v650: storage bucket size and MIME limits (#371).
--
-- Status: APPLIED to production 2026-11-12 — Security Advisor
-- gate PASS, applied on the User's approval, second of the
-- five-migration sequence (#357, #371, #364, #358, #363).
-- Drafted the same day against the live database (as draft
-- v651; re-verified the same day — see the evidence below).
-- Post-apply read-back: all four buckets carry the limits
-- below; object counts unchanged (285 / 32 / 2 / 0).
--
-- The gap: all four storage buckets carry file_size_limit NULL and
-- allowed_mime_types NULL, so any signed-in user who can write to a
-- bucket can upload an object of any size and any type into it —
-- including types the public buckets would then serve back under the
-- app's own domain (covers, edition-images and spine-photos are
-- public buckets). Bucket config is the cheapest layer of the
-- storage posture: it binds every writer, present and future,
-- without touching a policy or a line of app code.
--
-- Evidence (live census, 2026-11-12): every object already stored
-- conforms to the allowlist its bucket gets here, so the apply
-- cannot strand an existing object — the limits bind only future
-- uploads.
--   covers:         285 objects, all image/webp, largest 194 KB.
--   edition-images:  32 objects, all image/jpeg, largest  51 KB.
--   spine-photos:     2 objects, all image/jpeg, largest  15 KB.
--   avatars:          0 objects.
--
-- Per-bucket reasoning:
--   covers (2 MiB, image/webp only): the only writer is the cover
--     adoption flow (js/136), which transcodes through a canvas
--     capped at 600 px wide / 2M pixels, encodes WebP at q0.85, and
--     REFUSES to upload a blob that is not WebP. WebP-only is
--     therefore the app's own contract, not a new restriction; 2 MiB
--     is roughly ten times the largest object the transcoder has
--     ever produced here.
--   edition-images (5 MiB, image/jpeg only): every client writer
--     (edition capture js/206, the shelf spine flow js/205, the
--     asset share path js/208) uploads content-addressed JPEG
--     candidates. 5 MiB leaves generous headroom for device variance
--     in the capture pipeline while still capping a single object.
--   spine-photos (5 MiB, image/jpeg only): a legacy bucket — v259-era
--     rows still point at it, but the current client writes spine
--     candidates to edition-images. It gets the same posture as
--     edition-images so the legacy surface is not left open behind
--     the newer one.
--   avatars (1 MiB, image/jpeg only): the only writer (js/105)
--     uploads a 256 px canvas render as image/jpeg. 1 MiB is far
--     beyond anything that render can produce.
--
-- Judgment call deliberately NOT made: no image/png or image/webp
-- was added to edition-images or avatars speculatively. No current
-- writer produces them; if a future flow does (a PNG avatar with
-- transparency is the plausible case), the bucket amendment is a
-- one-line follow-up that should ride with that flow, not precede
-- it.
--
-- Re-runnable posture: plain UPDATEs of the bucket rows; running
-- the file twice lands the same state. No object is created,
-- moved, or deleted; no storage policy changes; reads of existing
-- objects are unaffected (these fields bind uploads only).

update storage.buckets
   set file_size_limit = 2097152,
       allowed_mime_types = array['image/webp']
 where id = 'covers';

update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['image/jpeg']
 where id = 'edition-images';

update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['image/jpeg']
 where id = 'spine-photos';

update storage.buckets
   set file_size_limit = 1048576,
       allowed_mime_types = array['image/jpeg']
 where id = 'avatars';
