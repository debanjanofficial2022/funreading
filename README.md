# Reading Rings

Turn a reading list into a game. Readers build **projects** for any topic, add papers by **DOI** or **PDF upload**, set **daily and weekly goals**, and earn **scholar points** (XP) as they read, keep streaks, unlock badges and pass quizzes on each paper. Every project is drawn as a set of concentric rings, one per section, filling in as you read.

The example project, **Electrocatalysis Must-Reads** (196 papers in six rings), is always available. Guests can browse it and track progress in their browser; signing in keeps progress in their account and unlocks their own projects and quizzes.

## Features

- **Projects:** create as many as you like (up to 50), with your own sections. Rename, reorder and delete sections; move papers between them.
- **Adding papers:** paste any number of DOIs (looked up in Crossref), drop in PDFs (the DOI is read from the PDF and checked against Crossref by title), or type details by hand.
- **Reading:** tick papers as read, rate your understanding (still fuzzy, mostly, confident), and open each paper's PDF and supporting information through its DOI, optionally through your library's proxy. Uploaded PDFs are private to you.
- **Quizzes (optional, off by default):** when turned on, marking yourself confident unlocks a 5-question quiz written by Claude. With an uploaded PDF the quiz is written from the paper's own text; otherwise from what Claude knows about the paper. Answers are graded on the server.
- **Game:** XP, ten levels from "Curious reader" to "Distinguished professor", daily and weekly goal bonuses, streaks and 13 badges.
- **Example project:** "Make my own copy" turns it into an editable project.

### Points

| Action | XP |
|---|---|
| Read a paper | 10 |
| Pass a quiz (4 of 5 correct, only when quizzes are on) | 50 |
| Meet your daily goal (per day) | 20 |
| Meet your weekly goal (per week) | 50 |

Points are computed from each reader's reading history, so they're the same on every device. Quiz passes are recorded only by the server after grading.

## How it fits together

| Part | Service | Cost |
|---|---|---|
| Website | Vercel (static Vite build) | Free tier |
| Accounts, projects, progress, private PDFs | Supabase (email sign-in links, Postgres with row-level security, Storage) | Free tier to start |
| Reading DOIs from PDFs | Vercel function `api/pdf-meta.js` with Crossref | Free |
| Quizzes (optional) | Vercel functions in `api/`, calling the Anthropic API with your key | Pay per new quiz |

```
index.html, src/        the app (dashboard, projects, ring maps, quizzes)
src/example.js          the example project, bundled so guests can browse it
api/quiz.js             serves a cached quiz or writes a new one (answers stay on the server)
api/quiz-check.js       grades answers and records quiz passes
api/pdf-meta.js         reads the DOI from an uploaded PDF and looks it up
lib/                    shared server code (Supabase admin client, PDF text, quiz prompt)
supabase/schema.sql     tables, access rules, limits, PDF storage
supabase/seed.sql       the example project
scripts/                regenerate the example project from scripts/catalogue-source.js
```

### Keeping costs down

- Each paper's quiz is generated once and reused for every reader (up to 5 different question sets per paper). Quizzes from a reader's own PDF stay with that reader's paper.
- New quizzes are capped per reader per day (`QUIZ_USER_DAILY_LIMIT`, default 10) and for the whole site per day (`QUIZ_GLOBAL_DAILY_LIMIT`, default 300). Cached quizzes don't count.
- Quizzes from a PDF send up to about 60,000 characters of the paper, so they cost more than knowledge-based ones (roughly a few cents each with a Sonnet-class model). Set a monthly spend limit on your Anthropic account as a backstop.
- Supabase's free tier includes 1 GB of file storage. Uploads are capped at 25 MB each. Watch storage use as readers upload PDFs, and upgrade or add a per-reader cap if needed.

## Set up (about 20 minutes)

### 1. Supabase
1. Create a project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run `supabase/schema.sql`, then `supabase/seed.sql`.
3. In **Authentication → URL Configuration**, set **Site URL** to your website's address and add it under **Redirect URLs** (do this again once you have your Vercel URL or custom domain).
4. In **Project Settings → API**, copy the Project URL, the `anon` public key and the `service_role` key.

### 2. Vercel
1. Import this repository at [vercel.com/new](https://vercel.com/new). Vercel detects Vite.
2. Connect Supabase: either add Supabase from the project's **Storage/Integrations** tab (Vercel fills in the keys itself), or add `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` by hand (see `.env.example`). The integration's variable names work too. Only the two `VITE_` values reach the browser. Never give the service-role key a `VITE_` prefix.
3. Deploy, then put the URL into Supabase's Site URL (step 1.3).

### 3. Quizzes (optional, later)
Quizzes are off until you turn them on. With them off, the site hides every quiz button and badge, and the quiz functions refuse requests. To turn them on:
1. Create an API key at [console.anthropic.com](https://console.anthropic.com) and set a monthly spend limit.
2. In Vercel, add `ANTHROPIC_API_KEY` and `VITE_QUIZZES=true`, then redeploy (the `VITE_` value is read at build time).

## Run locally

```bash
npm install
cp .env.example .env    # fill in the values
npx vercel dev          # site + api functions
```

`npm run dev` serves only the site (no PDF reading or quizzes). Without any Supabase values the site runs in guest mode: the example project works and progress stays in the browser.

## Editing the example project

Edit `scripts/catalogue-source.js`, then run `node scripts/make-example.mjs` and re-run `supabase/seed.sql`. Paper ids are derived from titles, so readers keep their progress unless you change a title.

## Notes

- The site links to publishers through DOIs and never serves PDFs publicly. Uploaded PDFs are readable only by the reader who uploaded them.
- Quizzes can contain mistakes. For papers Claude doesn't know well and that have no PDF, it declines instead of inventing questions.
