# Kalendarz — Calendar Grid View

**Date:** 2026-04-02
**Status:** Approved

## Summary

Add a calendar grid view as a third tab alongside existing Lista and Mapa views on the leszy.run/kalendarz page. Traditional 7-column month grid (Mon–Sun) with event type color-coding. All existing filters apply.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Relationship to existing views | Third tab (Lista / **Kalendarz** / Mapa) | List is battle-tested for search/filter; calendar adds planning angle |
| Day click behavior (desktop) | Detail panel below grid | Simplest, works at all widths, no space conflicts |
| Event click in detail panel | Same as list view (display-only + registration link) | Consistency with existing UI |
| Max events per cell (desktop) | Fixed 3 + "+N więcej" | Keeps grid uniform; avoids variable row heights |
| Mobile day tap | Auto-scroll to detail panel below grid | Standard mobile pattern; gives events full width |

## Desktop Behavior

### View Toggle
- Filter bar gains a third view button: `Lista | Kalendarz | Mapa`
- URL param: `view=calendar` (alongside existing `list` and `map`)
- Filters persist across view switches

### Month Grid
- 7 columns: Pon, Wt, Śr, Czw, Pt, Sob, Ndz
- Fixed row heights — cells do NOT grow to fit content
- Month navigation: `◀ Prev` | `Dziś` | `Next ▶`
- When switching to calendar view, displayed month is derived from current time range filter

### Day Cells
- **Today**: yellow-dim border on cell, yellow day number
- **Selected**: yellow border + subtle yellow background tint
- **Empty days** (outside month): dark background, no border, not clickable
- Each cell shows up to **3 event names** with colored left border (event type), then "+N więcej" for overflow
- Clicking a cell or "+N więcej" opens the detail panel

### Event Type Colors (left border on event chips)
| Type | Color |
|------|-------|
| Bieg/Uliczny (default) | Cyan `#00BFEF` |
| Trail | Green `#4CAF50` |
| Ultra | Red `#EF4444` |
| OCR | Orange `#FF9800` |
| Nordic | Purple `#9C27B0` |
| Leszy.run events | Yellow `#BBDD00` + subtle yellow background |

### Color Legend
- Horizontal legend bar above the grid showing all event type colors
- Compact: colored line + label for each type

### Detail Panel (Below Grid)
- Appears below the calendar grid when a day is clicked
- Yellow left border stripe (3px)
- Header: date (mono, yellow) + event count (muted)
- Event rows match existing EventRow component style:
  - Type color dot | Event name + location | Tags (type, distances) + registration link
  - Leszy.run events get subtle yellow background tint
- Click same day again → panel closes
- Click different day → panel updates in place

## Mobile Behavior

### Compact Grid
- 7 columns, single-letter day names (P, W, Ś, C, P, S, N)
- Month navigation: ◀ ▶ arrows flanking month name
- No event names in cells — replaced by **colored dots** (one dot per event, color = type)
- Dots wrap if many events on one day (max ~6 visible)
- Today: highlighted background, yellow day number
- Selected: outlined with yellow border

### Day Tap → Auto-Scroll
- Tap a day with events → detail panel appears below grid
- Page auto-scrolls to the detail panel
- Grid stays above (scroll up to see it / tap another day)
- Tap same day again → panel closes

### Mobile Detail Panel
- Same yellow left border stripe
- Event rows: dot + name + location + tags stacked vertically
- "Zapisy →" links open registration in new tab
- Compact tag sizing for mobile

### Mobile Color Legend
- Centered below grid, compact: dots + short labels
- Same colors as desktop

## URL Integration

- `view=calendar` added to existing view param options
- Clicking a day does NOT change URL (detail panel is ephemeral UI state)
- Month navigation does NOT change URL (month is derived from time filter or defaults to current)
- All existing filter params (`q`, `type`, `region`, `dist`, `when`, `r`, `page`) continue to work — they filter which events appear in cells

## Component Structure

```
public/src/
  pages/Kalendarz.jsx          — add calendar view branch to existing view toggle
  components/
    CalendarGrid.jsx           — month grid component (desktop + mobile responsive)
    CalendarDayCell.jsx        — individual day cell (desktop: event chips, mobile: dots)
    CalendarDetailPanel.jsx    — expandable detail panel below grid
    EventRow.jsx               — existing, reused in detail panel
    FilterBar.jsx              — existing, add 'calendar' to view toggle options
```

## Data Flow

1. Existing Supabase query in Kalendarz.jsx fetches events for the time range
2. Events are grouped by date (`Map<dateString, CalendarEvent[]>`)
3. CalendarGrid receives the grouped events + current month
4. Each CalendarDayCell receives its date's events array
5. On day click, CalendarGrid sets `selectedDate` state
6. CalendarDetailPanel receives events for `selectedDate` and renders EventRow-style list

No new API endpoints or database changes needed. Same Supabase query, different rendering.

## Edge Cases

- **No events in view**: show empty grid with "Brak wydarzeń w tym miesiącu" message below
- **Filters active but month has no matching events**: same empty message, grid still renders with empty cells
- **Day with 10+ events on mobile**: dots wrap to second line within the cell; detail panel shows all
- **Switching views with filters active**: calendar view respects all active filters; switching back to list preserves them
- **Time range filter "Cały rok"**: calendar defaults to showing current month; user navigates with arrows

## Mockups

Visual mockups (desktop + mobile, both states) are in:
`.superpowers/brainstorm/78633-1775138252/content/calendar-final.html`
