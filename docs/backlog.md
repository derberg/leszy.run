# Backlog

Ideas and work items to revisit later. Not planned, not scheduled — just parked so we don't forget.

## Emoji pool (`backend/src/lib/emoji.js`)

Current pool: ~140 unique animals, creatures, and fantasy beings (Unicode only).

### Candidates to consider adding

**Extra Unicode (text, no implementation needed) — low effort:**
- 🫍 orca (new variant, separate from 🐳)
- 🦪 oyster
- 🐀 rat
- 👹 ogre, 👺 goblin, 🧌 troll — "beast mode" / trail horror vibe
- 👾 alien monster, 🤖 robot — arcade/bionic vibe
- 💀 skull, ☠️ skull-and-crossbones — hardcore/ultra vibe
- 🎅 Santa, 🤶 Mrs. Santa — seasonal, only for winter events

**Custom images (requires implementation) — high effort:**
- Custom `leszy.run` themed creatures — AI-generated (DALL·E / Midjourney / SD) with consistent prompt template, or commissioned from illustrator
  - Trail-specific mythology: leszy, rusałka, mokradła creatures, forest spirits
  - Pack of ~20-30 unique polish folklore creatures
- OpenMoji extras (~7 useful): doe, narwhal, beluga, porpoise, spouting-orca, goldfish, pigeon, macaw
- BlobCats pack (~60 cat variants, Apache/OFL license, commercial-safe)

### Implementation notes for custom image support

Requires:
1. Storage — Supabase Storage bucket OR static files in `public/public/emojis/`
2. Schema — either extend `participant.emoji` to accept URL/slug, or add `emoji_custom_url` column
3. Render component — `<EmojiBadge value={...} />` in `@leszyrun/ui` that detects Unicode vs custom and renders `<span>` or `<img>` accordingly. Replace ~6 direct render sites.
4. Pool integration — `POOL` in `emoji.js` includes custom slugs like `:leszy:`; `pickEmoji()` works unchanged
5. Admin UI — upload page for custom emoji (drag & drop, name, enable/disable in pool)
6. Constraints — max 256x256, <100KB, prefer WebP over GIF, hash filename for cache busting
7. UI concern — animated GIFs in results tables may distract; consider static thumbnail in tables, animation on profile

### Community emoji databases surveyed (April 2026)

Not viable for commercial fantasy-creature expansion:
- **OpenMoji** (CC-BY-SA 4.0) — only 11 extra animals beyond Unicode
- **Mutant Standard** (CC-BY-NC-SA 4.0) — rich fantasy creatures but **non-commercial license**, blocks leszy.run
- **7TV / BTTV / FFZ** — 1M+ emotes but mostly copyright-violating user uploads
- **Mastodon emojos.in** — licenses unclear
- **BlobCats** — only cat variants, ~60 sprites (permissive license, could work)
- **Twemoji / Emojitwo / Noto / Fluent / Blobmoji** — Unicode-only, same set, different art styles

Conclusion: for a richer creature pool, AI generation or illustrator commission is the only path.
