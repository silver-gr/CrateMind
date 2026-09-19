# CrateMind: implementation roadmap and feature opportunities

These are **proposals**, not completed features. The objective is a useful personal catalog with recoverable evidence, not an indefinitely expanding platform.

## Operating model

The application should answer three separate questions:

**What is this?** Recording/version identity and source evidence.  
**What does it mean to me?** Likes, taste ratings, notes, set role, discovery history and collection membership.  
**What can I do with it now?** Play a local asset, open a service page, review a match, or publish a selected collection.

A remote-only Spotify track is a valid catalog entry. It is not automatically a download task, a SoundCloud match, or a broken local track. A source collection is historical evidence; an editable CrateMind collection is a user decision. Keep both.

## Smallest useful roadmap

| Stage | Deliverable | Acceptance condition |
|---|---|---|
| 1. Inventory | Active runtime and existing match/import contracts | No duplicate SoundCloud subsystem; exact input hashes recorded |
| 2. Offline staging | All Spotify/SoundCloud identities and memberships | Remote-only items, unknown Likes and original positions survive |
| 3. Match preview | Reuse accepted links; generate ranked candidates | Existing decisions unchanged; ambiguous candidates remain unresolved |
| 4. Collection proof | One source collection represented locally | Local and remote-only items coexist without fake file paths |
| 5. Approved import | Additive, transactional integration | Backup verified; rerun idempotent; no personal metadata loss |
| 6. Useful browsing | Source, availability and provenance filters | User can find/play familiar tracks without reviewing everything first |
| 7. Selective publication | One-way publish preview, then approved write | Wrong-version warnings, omissions, target privacy and result verification |

An effective first milestone is **one complete collection visible with local playback and honest unresolved entries**. Do not hold that hostage to all 11,172 Spotify URIs being matched.

## Identity and collection decisions to make explicitly

**Minimal persistence:** Prefer adapters/staging over a rewrite. Existing file-backed `tracks` and SoundCloud source/match tables may remain. Add Spotify source records and collection support without making file existence mandatory. Decide whether a small catalog-item layer is needed only after the one-collection proof.

**Matching:** Require compatible version tokens and sensible duration comparisons. Preserve labels such as live, remix, extended, edit, remaster and DJ mix. Uploader may be a label or repost channel rather than the performer. A playlist's membership is not evidence of liking each track. Popularity must not influence match identity.

**Collections:** Preserve exact source membership, including saved playlists from other creators. Maintain source snapshot identity even when two collections share one content fingerprint. Expose variants to the user instead of choosing “newer/larger wins.” Prefer keeping alternatives over irreversible automatic dedupe.

**Spotify publishing:** A local collection's existence does not guarantee all entries can be published. Remote mappings, availability and permissions must be checked per target. The publisher should preview excluded/unresolved entries and never silently substitute a different remix. Respect privacy; do not publish private source context by default.

## Feature ideas, ranked by near-term value

### 1. Unified source and availability shelf

One catalog view with filters for `local`, `SoundCloud`, `Spotify`, `in multiple sources`, `unmatched` and `file missing`. A track card distinguishes “no local asset linked” from “previously indexed file is missing.” Remote-only tracks stay browseable with links and collection context. This is the most direct payoff from integrating the exports.

### 2. Match review as a comparison desk

Extend the existing SoundCloud review flow rather than add a second review product. Show local filename/raw tags, candidate title/performer/uploader, duration delta, version differences, source collection and why the candidate was proposed. Keep accept/reject/skip fast and preserve prior decisions. Let the user listen to local audio and open the legitimate service page; no automatic audio downloading is required.

### 3. Personal value versus public exposure

Develop the user's existing plays/Likes idea into **two independent axes**: personal value and observed SoundCloud exposure. Suggested views: “highly rated, low exposure,” “familiar anchors,” “forgotten favorites,” and “not yet judged.” Counts belong to a particular upload and observation date; reuploads split exposure, newer uploads have had less time, and unknown counts are not zero.

Start with raw counters plus transparent filters. Age/cohort adjustments can be experimental later. Do not market any composite score as objective quality or “mainstream probability.”

### 4. Offline set readiness

Before a set, display: local assets present, unresolved identities, confirmed version, duration, BPM/key review flags and export readiness. Reuse existing set-building and M3U8 export functionality where present. A missing external drive or questionable remix matters more here than global catalog completeness.

### 5. Rediscovery with context

Surface a track with “liked in 2018,” “appeared in this old set draft,” or “saved through this creator's playlist.” Keep the evidence label explicit: source timestamp, snapshot observation, or inferred migration date. Historical Likes and playlist membership become navigation, not just fields buried in a database.

### 6. Collection family browser

Show related drafts/finals as a family with added/removed/reordered tracks. Offer a chosen local canonical version while retaining original snapshots. Do not infer “superseded” merely from a larger track count or a later timestamp. This gives the user organization without destroying the development history of a set.

### 7. Publishability matrix

For any collection, show verified local/SoundCloud/Spotify coverage and highlight wrong-version candidates before publication. A “Spotify version of this set” can be an explicit derivative with documented substitutions approved by the user, while the exact local set remains unchanged.

### 8. Lost Favorites shelf

Keep the 75 known-but-unresolved SoundCloud Likes visible as unresolved identities. If old sidecars, exports or local filenames later reveal them, attach new evidence without discarding the original unknown state. The cache audit recovered no metadata for them; this feature is a future recovery opportunity, not a promised fix.

### 9. Familiarity-aware set arc

Use personal ratings, energy and local play history alongside observed exposure to alternate recognizable anchors and discoveries. This should remain an explainable suggestion the DJ can edit, not an opaque “perfect set” generator. It becomes worthwhile only after identity and review data are dependable.

## Deliberately deferred

Bidirectional continuous sync, cloud-side mass deletion, automatic acquisition of missing audio, a graph database, embeddings for every track, complete BPM re-analysis, a mobile rewrite, and generic plugin infrastructure. None is necessary to get the user's music, history and playlists into one useful local view.

## Success test

The user can open CrateMind, find a track regardless of its source, understand its provenance, play a verified local asset when one exists, preserve a remote-only reference otherwise, assemble an ordered collection, and publish only a deliberately selected derivative later. Achieve that before broadening the system.
