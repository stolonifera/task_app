-- =============================================================
--  タスク管理 PWA 用スキーマ
--  Supabase の SQL Editor にそのまま貼り付けて実行してください。
--
--  設計:
--    tasks_long  … 長期 (最上位)
--    tasks_mid   … 中期  → long_id で長期に紐づく
--    tasks_short … 短期  → mid_id で中期に、または long_id で長期に直接紐づく
--  テーブルは枠ごとに分かれているが、FK で上位の枠に関連づけられる。
--  削除は deleted フラグによる論理削除 (端末間で削除を伝播させるため)。
-- =============================================================

create extension if not exists pgcrypto;

-- ---------- 長期 ----------
create table if not exists public.tasks_long (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 500),
  due        date,
  done       boolean not null default false,
  deleted    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- 中期 ----------
create table if not exists public.tasks_mid (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  long_id    uuid references public.tasks_long (id) on delete set null,
  body       text not null check (char_length(body) between 1 and 500),
  due        date,
  done       boolean not null default false,
  deleted    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- 短期 ----------
create table if not exists public.tasks_short (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  mid_id     uuid references public.tasks_mid  (id) on delete set null,
  long_id    uuid references public.tasks_long (id) on delete set null,
  body       text not null check (char_length(body) between 1 and 500),
  due        date,
  done       boolean not null default false,
  deleted    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 親は「中期」か「長期」のどちらか一方 (または無し)
  constraint tasks_short_single_parent check (mid_id is null or long_id is null)
);

-- ---------- 差分同期用インデックス ----------
create index if not exists tasks_long_sync_idx  on public.tasks_long  (user_id, updated_at);
create index if not exists tasks_mid_sync_idx   on public.tasks_mid   (user_id, updated_at);
create index if not exists tasks_short_sync_idx on public.tasks_short (user_id, updated_at);
create index if not exists tasks_mid_long_idx   on public.tasks_mid   (long_id);
create index if not exists tasks_short_mid_idx  on public.tasks_short (mid_id);
create index if not exists tasks_short_long_idx on public.tasks_short (long_id);

-- ---------- updated_at を常にサーバ側で更新 ----------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  -- 同期の基準となる時刻はサーバ側で確定させる (端末の時計ずれ対策)
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.user_id := coalesce(auth.uid(), new.user_id);
  else
    new.user_id := old.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists touch_tasks_long  on public.tasks_long;
drop trigger if exists touch_tasks_mid   on public.tasks_mid;
drop trigger if exists touch_tasks_short on public.tasks_short;

create trigger touch_tasks_long  before insert or update on public.tasks_long
  for each row execute function public.touch_updated_at();
create trigger touch_tasks_mid   before insert or update on public.tasks_mid
  for each row execute function public.touch_updated_at();
create trigger touch_tasks_short before insert or update on public.tasks_short
  for each row execute function public.touch_updated_at();

-- ---------- RLS: 自分の行だけ ----------
alter table public.tasks_long  enable row level security;
alter table public.tasks_mid   enable row level security;
alter table public.tasks_short enable row level security;

do $$
declare t text;
begin
  foreach t in array array['tasks_long','tasks_mid','tasks_short'] loop
    execute format('drop policy if exists own_select on public.%I', t);
    execute format('drop policy if exists own_insert on public.%I', t);
    execute format('drop policy if exists own_update on public.%I', t);
    execute format('drop policy if exists own_delete on public.%I', t);

    execute format('create policy own_select on public.%I for select using (auth.uid() = user_id)', t);
    execute format('create policy own_insert on public.%I for insert with check (auth.uid() = user_id)', t);
    execute format('create policy own_update on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('create policy own_delete on public.%I for delete using (auth.uid() = user_id)', t);
  end loop;
end $$;

-- ---------- Realtime (任意: 他端末の変更を即時反映) ----------
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  -- 1 テーブルずつ処理する (まとめると 1 つの重複で全部ロールバックされるため)
  foreach t in array array['tasks_long','tasks_mid','tasks_short'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
