-- HIGH-002 — delivery-proofs was a PUBLIC bucket with a SELECT policy granted to
-- the `public` role covering every object, and INSERT open to any authenticated
-- user. Proof photos show doorsteps, faces and sometimes addresses.
--
-- Safe to do now: the bucket holds 0 objects, so there is no legacy data to
-- migrate. rider.html switches from getPublicUrl() to createSignedUrl() in the
-- same change; signed URLs are validated by the storage API and keep working
-- for consignees and clients even though the bucket is private.

update storage.buckets
   set public = false,
       file_size_limit = 10485760,                              -- 10 MB
       allowed_mime_types = array['image/jpeg','image/png','image/webp']
 where id = 'delivery-proofs';

-- anyone-can-read is what we are removing
drop policy if exists delivery_proofs_public_read on storage.objects;
drop policy if exists delivery_proofs_authenticated_insert on storage.objects;

-- direct (non-signed) reads: staff and riders only
create policy delivery_proofs_staff_read on storage.objects
  for select to authenticated
  using (bucket_id = 'delivery-proofs'
         and (public.is_admin() or public.my_rider_id() is not null));

-- only a rider or an admin may add a proof, and only under a real folder
create policy delivery_proofs_rider_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'delivery-proofs'
              and (public.is_admin() or public.my_rider_id() is not null)
              and (storage.foldername(name))[1] is not null
              and octet_length(coalesce(name,'')) < 512);

-- proofs are evidence: nobody overwrites or deletes them from the client side
