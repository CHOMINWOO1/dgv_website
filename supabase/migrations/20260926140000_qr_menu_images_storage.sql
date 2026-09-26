-- Public menu images for the QR menu. This bucket contains only published food
-- photos: downloading a known object URL is public, while listing and every
-- mutation through the Storage API require the authenticated application admin.
--
-- Existing menu_items rows and existing local image paths are not modified.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'qr-menu-images',
  'qr-menu-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists qr_menu_images_admin_select on storage.objects;
create policy qr_menu_images_admin_select
on storage.objects
for select
to authenticated
using (
  bucket_id = 'qr-menu-images'
  and (select public.has_app_role(array['admin']::text[]))
);

drop policy if exists qr_menu_images_admin_insert on storage.objects;
create policy qr_menu_images_admin_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'qr-menu-images'
  and (select public.has_app_role(array['admin']::text[]))
  and name ~ '^menus/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
);

drop policy if exists qr_menu_images_admin_update on storage.objects;
create policy qr_menu_images_admin_update
on storage.objects
for update
to authenticated
using (
  bucket_id = 'qr-menu-images'
  and (select public.has_app_role(array['admin']::text[]))
)
with check (
  bucket_id = 'qr-menu-images'
  and (select public.has_app_role(array['admin']::text[]))
  and name ~ '^menus/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp)$'
);

drop policy if exists qr_menu_images_admin_delete on storage.objects;
create policy qr_menu_images_admin_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'qr-menu-images'
  and (select public.has_app_role(array['admin']::text[]))
);
