# Website Feedback ("Pomóż ulepszyć") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a general website feedback system where public users submit suggestions via Kalendarz and admins review them in the Moderation panel.

**Architecture:** New Supabase-only table `website_feedback`. Public form submits directly to Supabase via anon key (same pattern as `ReportEventModal`). Backend API reads/updates via service role key. Moderation panel gets a 3rd tab.

**Tech Stack:** Supabase (table + RLS), React (public modal + admin tab), Fastify (API routes)

---

### Task 1: Create Supabase table and RLS policies

**Files:**
- Supabase migration (via `mcp__supabase__apply_migration`)

- [ ] **Step 1: Apply Supabase migration**

Use `mcp__supabase__apply_migration` with name `website_feedback` and the following SQL:

```sql
CREATE TABLE website_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL CHECK (category IN ('missing_feature', 'bug', 'content', 'other')),
  message TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);

-- RLS
ALTER TABLE website_feedback ENABLE ROW LEVEL SECURITY;

-- Anyone can insert (public submissions)
CREATE POLICY "anon_insert_feedback" ON website_feedback
  FOR INSERT TO anon
  WITH CHECK (true);

-- Only service_role can read
CREATE POLICY "service_select_feedback" ON website_feedback
  FOR SELECT TO service_role
  USING (true);

-- Only service_role can update
CREATE POLICY "service_update_feedback" ON website_feedback
  FOR UPDATE TO service_role
  USING (true);
```

- [ ] **Step 2: Verify table exists**

Use `mcp__supabase__execute_sql` to run:
```sql
SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'website_feedback' ORDER BY ordinal_position;
```

Expected: 8 rows matching the schema (id, category, message, email, status, admin_note, created_at, reviewed_at).

- [ ] **Step 3: Commit**

Nothing to commit locally — this is Supabase-only. Proceed to next task.

---

### Task 2: Create FeedbackModal component (public app)

**Files:**
- Create: `public/src/components/FeedbackModal.jsx`

- [ ] **Step 1: Create FeedbackModal.jsx**

Create `public/src/components/FeedbackModal.jsx`. This follows the exact same pattern as `public/src/components/ReportEventModal.jsx` — modal overlay, honeypot, direct Supabase insert.

```jsx
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'

const CATEGORIES = [
  { value: 'missing_feature', label: 'Brakująca funkcja' },
  { value: 'bug', label: 'Błąd' },
  { value: 'content', label: 'Treść / dane' },
  { value: 'other', label: 'Inne' },
]

const inputClass = 'w-full bg-apex-surface border border-apex-border text-apex-text-bright font-sans text-sm font-medium py-2 px-3 outline-none focus:border-apex-yellow-dim transition-colors'
const labelClass = 'block font-display font-bold text-[10px] tracking-widest uppercase text-apex-muted mb-1'

export default function FeedbackModal({ onClose }) {
  const [category, setCategory] = useState('')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState(null)
  const [honeypot, setHoneypot] = useState('')

  const canSubmit = category && message.trim() && !submitting

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    if (honeypot) { setSubmitted(true); return }

    setSubmitting(true)
    setError(null)

    const { error: err } = await supabase.from('website_feedback').insert({
      category,
      message: message.trim(),
      email: email.trim() || null,
    })

    setSubmitting(false)
    if (err) {
      setError('Nie udało się wysłać sugestii.')
      console.error('Feedback error:', err.message)
    } else {
      setSubmitted(true)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative bg-apex-bg border border-apex-border w-full max-w-[440px] max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div className="p-5">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-display font-bold text-base tracking-widest uppercase text-apex-text-bright">Pomóż ulepszyć</h2>
            <button onClick={onClose} className="text-apex-muted hover:text-apex-text-bright text-lg leading-none">&times;</button>
          </div>

          <p className="text-sm text-apex-muted mb-4">Masz pomysł jak ulepszyć stronę? Podziel się z nami!</p>

          {submitted ? (
            <div className="py-6 text-center">
              <div className="text-apex-yellow text-2xl mb-2">&#10003;</div>
              <p className="text-apex-text-bright font-display font-bold tracking-wide uppercase text-sm">Dziękujemy za sugestię!</p>
              <p className="text-apex-muted text-xs mt-1">Przejrzymy Twoje zgłoszenie.</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="absolute -left-[9999px]" aria-hidden="true">
                <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
              </div>

              <div>
                <label className={labelClass}>Kategoria</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)}
                  className={`${inputClass} appearance-none cursor-pointer`}>
                  <option value="">— wybierz —</option>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>

              <div>
                <label className={labelClass}>Wiadomość</label>
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4}
                  className={`${inputClass} resize-none`} placeholder="Opisz swoją sugestię..." />
              </div>

              <div>
                <label className={labelClass}>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  className={inputClass} placeholder="opcjonalnie, jeśli chcesz odpowiedź" />
              </div>

              {error && <div className="text-apex-red text-xs">{error}</div>}

              <button type="submit" disabled={!canSubmit}
                className={`w-full font-display font-bold text-xs tracking-widest uppercase py-2.5 transition-all ${canSubmit ? 'bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright' : 'bg-apex-surface-2 text-apex-muted cursor-not-allowed border border-apex-border'}`}>
                {submitting ? 'Wysyłanie...' : 'Wyślij sugestię'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add public/src/components/FeedbackModal.jsx
git commit -m "feat: add FeedbackModal component for public website feedback"
```

---

### Task 3: Add feedback button to Kalendarz page

**Files:**
- Modify: `public/src/pages/Kalendarz.jsx`

- [ ] **Step 1: Add import and state to Kalendarz**

At the top of `public/src/pages/Kalendarz.jsx`, add the import after the existing imports:

```jsx
import FeedbackModal from '../components/FeedbackModal.jsx'
```

Inside the `Kalendarz` component, add state for the modal (near the other `useState` calls):

```jsx
const [showFeedback, setShowFeedback] = useState(false)
```

- [ ] **Step 2: Add button next to "Dodaj wydarzenie"**

In the header section of Kalendarz, there's a `Link` to `/kalendarz/dodaj` with class `hidden md:inline-block`. Add a feedback button right before or after that link. Find the block:

```jsx
<Link to="/kalendarz/dodaj" className="hidden md:inline-block font-display font-bold text-[11px] tracking-widest uppercase px-4 py-2.5 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all flex-shrink-0 mt-1">
  + Dodaj wydarzenie
</Link>
```

Replace with:

```jsx
<div className="hidden md:flex gap-2 flex-shrink-0 mt-1">
  <button onClick={() => setShowFeedback(true)} className="font-display font-bold text-[11px] tracking-widest uppercase px-4 py-2.5 border-2 border-apex-border text-apex-muted hover:border-apex-text hover:text-apex-text-bright transition-all">
    Pomóż ulepszyć
  </button>
  <Link to="/kalendarz/dodaj" className="font-display font-bold text-[11px] tracking-widest uppercase px-4 py-2.5 border-2 border-apex-yellow text-apex-yellow hover:bg-apex-yellow hover:text-apex-ink transition-all">
    + Dodaj wydarzenie
  </Link>
</div>
```

- [ ] **Step 3: Render the modal**

Just before the closing `</>` of the return statement (before `<Footer />`), add:

```jsx
{showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
```

- [ ] **Step 4: Verify the public app renders**

Run `cd public && npx vite --port 3002` and open http://localhost:3002/kalendarz. Confirm the "Pomóż ulepszyć" button appears next to "Dodaj wydarzenie" on desktop.

- [ ] **Step 5: Commit**

```bash
git add public/src/pages/Kalendarz.jsx
git commit -m "feat: add feedback button to Kalendarz page"
```

---

### Task 4: Create backend API routes for website feedback

**Files:**
- Create: `backend/src/routes/websiteFeedback.js`
- Modify: `backend/src/server.js`

- [ ] **Step 1: Create websiteFeedback.js route file**

Create `backend/src/routes/websiteFeedback.js`. Follow the same pattern as `backend/src/routes/calendarEventReports.js` — imports supabase client, exports async route function.

```js
import { supabase } from '../lib/supabaseClient.js'

export async function websiteFeedbackRoutes(fastify) {
  fastify.get('/website-feedback', async (request, reply) => {
    const { status = 'pending', category } = request.query

    let query = supabase
      .from('website_feedback')
      .select('*')
      .eq('status', status)
      .order('created_at', { ascending: false })

    if (category) {
      query = query.eq('category', category)
    }

    const { data, error } = await query

    if (error) return reply.status(500).send({ error: error.message })
    return { data }
  })

  fastify.patch('/website-feedback/:id/review', async (request, reply) => {
    const { id } = request.params
    const { admin_note } = request.body || {}

    const updates = {
      status: 'reviewed',
      reviewed_at: new Date().toISOString(),
    }
    if (admin_note !== undefined) updates.admin_note = admin_note

    const { error } = await supabase
      .from('website_feedback')
      .update(updates)
      .eq('id', id)

    if (error) return reply.status(500).send({ error: error.message })
    return { success: true }
  })

  fastify.patch('/website-feedback/:id/dismiss', async (request, reply) => {
    const { id } = request.params
    const { admin_note } = request.body || {}

    const updates = {
      status: 'dismissed',
      reviewed_at: new Date().toISOString(),
    }
    if (admin_note !== undefined) updates.admin_note = admin_note

    const { error } = await supabase
      .from('website_feedback')
      .update(updates)
      .eq('id', id)

    if (error) return reply.status(500).send({ error: error.message })
    return { success: true }
  })
}
```

- [ ] **Step 2: Register routes in server.js**

In `backend/src/server.js`, add the import after the existing route imports (around line 29):

```js
import { websiteFeedbackRoutes } from './routes/websiteFeedback.js'
```

Inside the `fastify.register(async (api) => { ... })` block, add after `await api.register(urlSuggestionsRoutes)`:

```js
await api.register(websiteFeedbackRoutes)
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/routes/websiteFeedback.js backend/src/server.js
git commit -m "feat: add backend API routes for website feedback"
```

---

### Task 5: Add "Sugestie" tab to Moderation panel

**Files:**
- Modify: `frontend/src/pages/Moderation.jsx`

- [ ] **Step 1: Add feedback state and fetch function**

In `frontend/src/pages/Moderation.jsx`, inside the `Moderation` component, add state alongside the existing `pendingEvents` and `reports` state (around line 136):

```js
const [feedback, setFeedback] = useState([])
```

Add a fetch function alongside `fetchPending` and `fetchReports`:

```js
const fetchFeedback = useCallback(async () => {
  const res = await fetch(`${API}/api/website-feedback?status=pending`)
  const json = await res.json()
  setFeedback(json.data || [])
}, [])
```

Update the `useEffect` to also fetch feedback. Change:

```js
Promise.all([fetchPending(), fetchReports()]).finally(() => setLoading(false))
```

To:

```js
Promise.all([fetchPending(), fetchReports(), fetchFeedback()]).finally(() => setLoading(false))
```

- [ ] **Step 2: Add feedback action handlers**

Add these handler functions inside the component, after the existing `rejectReportGroup` function:

```js
const reviewFeedback = async (id, adminNote) => {
  await fetch(`${API}/api/website-feedback/${id}/review`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_note: adminNote || null }),
  })
  setFeedback(prev => prev.filter(f => f.id !== id))
}

const dismissFeedback = async (id, adminNote) => {
  await fetch(`${API}/api/website-feedback/${id}/dismiss`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admin_note: adminNote || null }),
  })
  setFeedback(prev => prev.filter(f => f.id !== id))
}
```

- [ ] **Step 3: Add the third tab button**

In the tab bar `<div className="flex gap-4 border-b border-apex-border">`, add a third button after the "Zgłoszenia" button:

```jsx
<button onClick={() => setTab('feedback')} className={`${tabClass} ${tab === 'feedback' ? activeTab : inactiveTab}`}>
  Sugestie ({feedback.length})
</button>
```

- [ ] **Step 4: Add the feedback tab content**

After the `{!loading && tab === 'reports' && ( ... )}` block, add:

```jsx
{!loading && tab === 'feedback' && (
  <div className="space-y-3">
    {feedback.length === 0 && <div className="text-apex-muted py-8 text-center">Brak sugestii do przejrzenia.</div>}
    {feedback.map(f => (
      <FeedbackItem key={f.id} item={f} onReview={reviewFeedback} onDismiss={dismissFeedback} />
    ))}
  </div>
)}
```

- [ ] **Step 5: Create the FeedbackItem component**

Add this component above the `Moderation` default export function (after the `EditableEvent` component, around line 131):

```jsx
const CATEGORY_BADGES = {
  missing_feature: { label: 'Funkcja', cls: 'border-apex-cyan text-apex-cyan' },
  bug: { label: 'Błąd', cls: 'border-apex-red text-apex-red' },
  content: { label: 'Treść', cls: 'border-apex-yellow text-apex-yellow' },
  other: { label: 'Inne', cls: 'border-apex-border text-apex-muted' },
}

function FeedbackItem({ item, onReview, onDismiss }) {
  const [note, setNote] = useState('')
  const badge = CATEGORY_BADGES[item.category] || CATEGORY_BADGES.other
  const ago = getRelativeTime(item.created_at)

  return (
    <div className="bg-apex-surface border border-apex-border p-4">
      <div className="flex items-center gap-3 mb-2">
        <span className={`font-mono text-[10px] font-semibold px-2 py-0.5 border ${badge.cls}`}>
          {badge.label}
        </span>
        <span className="font-mono text-[10px] text-apex-muted">{ago}</span>
        {item.email && (
          <a href={`mailto:${item.email}`} className="font-mono text-[10px] text-apex-cyan hover:underline ml-auto">{item.email}</a>
        )}
      </div>
      <p className="text-sm text-apex-text mb-3 whitespace-pre-wrap">{item.message}</p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Notatka (opcjonalnie)"
          className="flex-1 bg-apex-bg border border-apex-border text-apex-text-bright text-xs py-1.5 px-2.5 outline-none focus:border-apex-yellow-dim"
        />
        <button onClick={() => onReview(item.id, note)} className={`${btnBase} bg-apex-yellow text-apex-ink hover:bg-apex-yellow-bright`}>
          Przeczytane
        </button>
        <button onClick={() => onDismiss(item.id, note)} className={`${btnBase} border border-apex-red/50 text-apex-red hover:bg-apex-red hover:text-white`}>
          Odrzuć
        </button>
      </div>
    </div>
  )
}

function getRelativeTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins} min temu`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} godz. temu`
  const days = Math.floor(hours / 24)
  return `${days} dni temu`
}
```

Note: `btnBase` is already defined at the top of the file (line 7): `'font-display font-bold text-[11px] tracking-widest uppercase px-3 py-1.5 transition-all'`

Also add `useState` to the import if not already present (it already is on line 1).

- [ ] **Step 6: Verify the admin app renders**

Start the frontend dev server and navigate to http://localhost:3000/moderation. Confirm three tabs appear: "Oczekujące", "Zgłoszenia", "Sugestie".

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/Moderation.jsx
git commit -m "feat: add Sugestie tab to Moderation panel for website feedback"
```

---

### Task 6: End-to-end verification

- [ ] **Step 1: Test the public submission flow**

1. Open http://localhost:3002/kalendarz
2. Click "Pomóż ulepszyć"
3. Select category "Brakująca funkcja", type a message, optionally add email
4. Submit — expect success message "Dziękujemy za sugestię!"

- [ ] **Step 2: Test the admin review flow**

1. Open http://localhost:3000/moderation
2. Click "Sugestie" tab
3. The submitted feedback should appear with category badge, message, email, and timestamp
4. Add a note and click "Przeczytane" — item should disappear from pending list

- [ ] **Step 3: Verify dismissed flow**

Submit another test feedback, then dismiss it from the admin panel. Confirm it disappears.

- [ ] **Step 4: Verify honeypot**

In browser devtools, manually fill the hidden honeypot field and submit. The form should show success but NOT insert a row into Supabase.
