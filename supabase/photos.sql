-- Photo storage for used listings (OLX). Paste into Supabase > SQL Editor > New query > Run.
-- Private bucket; each user can only see and change files in their own folder. The app deletes photos after 14 days.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "okazje own photos" on storage.objects;
create policy "okazje own photos" on storage.objects for all to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
