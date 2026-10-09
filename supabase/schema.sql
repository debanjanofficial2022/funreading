-- Fun Reading database. Run once in Supabase (SQL Editor → New query → paste → Run),
-- then run seed.sql to add the example project.

create extension if not exists pgcrypto;

-- ---------- profiles: each reader's goals ----------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  daily_goal int not null default 1 check (daily_goal between 1 and 50),
  weekly_goal int not null default 5 check (weekly_goal between 1 and 200),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "profiles: read own"   on public.profiles for select using (auth.uid() = user_id);
create policy "profiles: insert own" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles: update own" on public.profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- projects: a reading list. The example project has is_template = true and no owner ----------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner uuid references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  sections jsonb not null default '[{"id":"s1","name":"Papers"}]'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  is_template boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists projects_owner on public.projects(owner);
alter table public.projects enable row level security;
create policy "projects: read own or example" on public.projects for select using (is_template or owner = auth.uid());
create policy "projects: create own" on public.projects for insert with check (owner = auth.uid() and not is_template);
create policy "projects: update own" on public.projects for update using (owner = auth.uid()) with check (owner = auth.uid() and not is_template);
create policy "projects: delete own" on public.projects for delete using (owner = auth.uid());

-- ---------- papers in a project ----------
create table if not exists public.papers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 500),
  authors text not null default '' check (char_length(authors) <= 1000),
  journal text not null default '' check (char_length(journal) <= 200),
  year int check (year between 1600 and 2200),
  doi text check (char_length(doi) <= 200),
  section text not null default 's1',
  topic text not null default '' check (char_length(topic) <= 200),
  note text not null default '' check (char_length(note) <= 1000),
  essential boolean not null default false,
  pdf_path text,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists papers_project on public.papers(project_id);
alter table public.papers enable row level security;
create policy "papers: read own or example" on public.papers for select using (
  exists (select 1 from public.projects p where p.id = project_id and (p.is_template or p.owner = auth.uid())));
create policy "papers: add to own project" on public.papers for insert with check (
  owner = auth.uid() and exists (select 1 from public.projects p where p.id = project_id and p.owner = auth.uid()));
create policy "papers: edit own" on public.papers for update using (owner = auth.uid()) with check (
  owner = auth.uid() and exists (select 1 from public.projects p where p.id = project_id and p.owner = auth.uid()));
create policy "papers: delete own" on public.papers for delete using (owner = auth.uid());

-- Abuse limits: 50 projects per reader, 2000 papers per project.
create or replace function public.limit_projects() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from projects where owner = new.owner) >= 50 then raise exception 'You can have up to 50 projects.'; end if;
  return new;
end $$;
create or replace function public.limit_papers() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from papers where project_id = new.project_id) >= 2000 then raise exception 'A project can hold up to 2000 papers.'; end if;
  return new;
end $$;
drop trigger if exists projects_limit on public.projects;
create trigger projects_limit before insert on public.projects for each row when (new.owner is not null) execute function public.limit_projects();
drop trigger if exists papers_limit on public.papers;
create trigger papers_limit before insert on public.papers for each row when (new.owner is not null) execute function public.limit_papers();

-- ---------- reads: one row per reader per paper they've read ----------
-- Readers can mark papers read and set their confidence. Quiz results are written only by the
-- server after grading, so scholar points from quizzes can't be set from the browser.
create table if not exists public.reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  paper_id uuid not null references public.papers(id) on delete cascade,
  read_at timestamptz not null default now(),
  confidence text check (confidence in ('low', 'mid', 'high')),
  quiz_best int,
  quiz_n int,
  quiz_passed boolean not null default false,
  quiz_attempts int not null default 0,
  quiz_passed_at timestamptz,
  primary key (user_id, paper_id)
);
alter table public.reads enable row level security;
create policy "reads: read own"   on public.reads for select using (auth.uid() = user_id);
create policy "reads: add own"    on public.reads for insert with check (auth.uid() = user_id and
  exists (select 1 from public.papers pa join public.projects p on p.id = pa.project_id
          where pa.id = paper_id and (p.is_template or p.owner = auth.uid())));
create policy "reads: update own" on public.reads for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "reads: delete own" on public.reads for delete using (auth.uid() = user_id);
revoke insert, update on public.reads from anon, authenticated;
grant insert (user_id, paper_id, confidence) on public.reads to authenticated;
grant update (confidence) on public.reads to authenticated;

-- ---------- quizzes (server only: no policies, so answers never leave through the public API) ----------
create table if not exists public.quiz_cache (
  id bigint generated always as identity primary key,
  paper_id uuid not null references public.papers(id) on delete cascade,
  questions jsonb not null,
  source text not null default 'knowledge',
  model text,
  created_at timestamptz not null default now()
);
create index if not exists quiz_cache_paper on public.quiz_cache(paper_id);
alter table public.quiz_cache enable row level security;

create table if not exists public.quiz_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  calls int not null default 0,
  primary key (user_id, day)
);
alter table public.quiz_usage enable row level security;

-- Counts one newly generated quiz against the reader's and the site's daily limits.
-- Returns 'ok', 'user' (reader over limit) or 'global' (site over limit).
create or replace function public.bump_quiz_usage(p_user uuid, p_day date, p_user_limit int, p_global_limit int)
returns text language plpgsql security definer set search_path = public as $$
declare u int; g int;
begin
  select coalesce(sum(calls), 0) into g from quiz_usage where day = p_day;
  if g >= p_global_limit then return 'global'; end if;
  insert into quiz_usage(user_id, day, calls) values (p_user, p_day, 1)
  on conflict (user_id, day) do update set calls = quiz_usage.calls + 1
  returning calls into u;
  if u > p_user_limit then
    update quiz_usage set calls = calls - 1 where user_id = p_user and day = p_day;
    return 'user';
  end if;
  return 'ok';
end $$;
revoke all on function public.bump_quiz_usage(uuid, date, int, int) from public, anon, authenticated;

-- ---------- uploaded PDFs: private, one folder per reader ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pdfs', 'pdfs', false, 26214400, array['application/pdf'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
create policy "pdfs: read own"   on storage.objects for select using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "pdfs: upload own" on storage.objects for insert with check (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "pdfs: delete own" on storage.objects for delete using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
