-- Okazje cloud database. Paste all of this into Supabase > SQL Editor > New query > Run.
-- Every row belongs to the logged-in user (user_id); row level security hides it from everyone else.

create table if not exists items (      -- wishlist items (same fields as the old wishlist.json)
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create table if not exists searches (   -- OLX searches (query, min, max, mustMatch, exclude, criteria)
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (user_id, id)
);
create table if not exists status (     -- latest price per item / search
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (user_id, id)
);
create table if not exists hits (       -- deals found (shown on the page, pushed to the phone)
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id bigint generated always as identity primary key,
  key text not null,                    -- listing/price key, so one deal is only stored once
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, key)
);
create table if not exists seen (       -- every OLX listing already looked at, per search
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  search_id text not null,
  offer_id text not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, search_id, offer_id)
);
create table if not exists settings (   -- ntfy topic etc.
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  key text not null,
  value jsonb,
  primary key (user_id, key)
);
create table if not exists runner (     -- which computer is checking right now
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  device text not null,
  beat timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['items','searches','status','hits','seen','settings','runner'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists own on %I', t);
    execute format('create policy own on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- A computer may check only if no other computer checked in the last 25 minutes.
create or replace function claim_runner(dev text) returns boolean
language plpgsql security invoker as $$
declare r runner;
begin
  select * into r from runner where user_id = auth.uid() for update;
  if not found then
    insert into runner (device) values (dev); return true;
  elsif r.device = dev or r.beat < now() - interval '25 minutes' then
    update runner set device = dev, beat = now() where user_id = auth.uid(); return true;
  end if;
  return false;
end $$;

-- Marks OLX listings as seen and returns only the ones that were new (so nothing is flagged twice).
create or replace function mark_seen(sid text, ids text[]) returns text[]
language sql security invoker as $$
  with ins as (
    insert into seen (search_id, offer_id) select sid, unnest(ids)
    on conflict do nothing returning offer_id
  ) select coalesce(array_agg(offer_id), '{}') from ins;
$$;

-- Old seen rows and hits are cleaned up after 120 days.
create or replace function cleanup() returns void language sql security invoker as $$
  delete from seen where user_id = auth.uid() and seen_at < now() - interval '120 days';
  delete from hits where user_id = auth.uid() and created_at < now() - interval '120 days';
$$;

-- Live updates between devices
do $$ declare t text; begin
  foreach t in array array['items','hits','status'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- Access for logged-in users (row level security above still limits them to their own rows)
grant usage on schema public to authenticated;
grant select, insert, update, delete on items, searches, status, hits, seen, settings, runner to authenticated;
grant execute on function claim_runner(text), mark_seen(text, text[]), cleanup() to authenticated;

-- Photos of used listings (also in photos.sql)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "okazje own photos" on storage.objects;
create policy "okazje own photos" on storage.objects for all to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
