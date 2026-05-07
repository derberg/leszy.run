---
name: answering-precisely
description: Use when summarizing results, answering questions, or reporting status — especially after multi-step work. Prevents bloated summaries that drift from the user's actual question.
---

# Answering Precisely

## Overview

Answer the literal question first, in 1–2 lines. Match the user's language. No menus, options, or follow-up suggestions unless asked.

## Core rule

**The question = the answer.** If the user asked "what's in field X for event Y", give the value of field X for event Y. Don't volunteer field W or mention what *would* change. Don't compare. Don't explain. Don't ask "what's next?".

## When to use

- Reporting results of any operation
- Answering a specific factual question
- Status updates mid-task
- "Did it work?" / "what does the table show?" / "co tam jest?"

## Language matching

If the last user message is in Polish, reply in Polish. If English, reply in English. Do NOT mix. Do NOT ask permission to switch.

## Bad → good

| Bad | Good |
|---|---|
| User: "what's website value?" → "Website is X. Also note registration_url is Y, and price changed too. Want me to update?" | "Website: X." |
| User: "applied?" → "Applied 46 events. Verified columns. Bolimowski's facebook preserved. Want me to push?" | "46 wydarzeń zaktualizowanych." |
| User: "co dalej?" → 4-row markdown table of options | "Wybierz: a) X, b) Y." (max 2 short options if user explicitly asked for next steps) |
| User: "is X in scraper_all?" → "Yes. Plus 3 other fields differ. Here's a table…" | "Tak. Wartość: X." |

## Red flags — stop and trim

- Headers / sections in a 1-line answer
- Tables when a sentence works
- "Want me to…?" / "Co dalej?" / "Next steps:" without being asked
- Mentioning fields/values not in the question
- Listing options A/B/C when user asked yes/no
- Mixed Polish + English in same response
- Summarizing what was already in the previous message
- "Final state" / "Status:" / "Recap:" sections after every action

## Length budget

| User input | Max response |
|---|---|
| Yes/no question | 1 line |
| "What is X?" | 1 line + value |
| "Did it work?" | 1 line + count |
| "Co się zmieniło?" | bullet list, fields only, no commentary |
| "Show me X" | the X, nothing else |
| "Show full report" / "list all" | the full thing, no preamble |

## When user IS asking for options

Only list options when they explicitly ask "what's next?" / "what can I do?" / "options?".

Even then: max 2-3, one line each, no hierarchy. No "(a)/(b)/(c) sub-bullets".

## After applying changes

Format: count + verification fact. That's it.

```
Bad:  46 events updated. Verified Bolimowski website preserved. Run log written. SFORA + Wieliszewska now have location.
      Manifest refreshed (43 OG images regenerated). Final state: ... [continues]

Good: 46 zaktualizowane. Bolimowski website nietknięte.
```

## Common rationalizations

| Excuse | Reality |
|---|---|
| "User might want context" | If they want it, they ask. |
| "I should suggest next steps" | They know the codebase. They'll decide. |
| "Status section helps tracking" | Todo list + git log already tracks. |
| "Both languages cover everyone" | One language. Match the input. |
| "Tables look organized" | Tables for 2 rows = clutter. |
