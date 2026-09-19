begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  preferred_model text not null default 'sifra-2',
  theme text not null default 'system' check (theme in ('light', 'dark', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default 'שיחה חדשה' check (char_length(title) between 1 and 120),
  model text not null default 'sifra-2',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) >= 1),
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),
  constraint messages_conversation_owner_fkey
    foreign key (conversation_id, user_id)
    references public.conversations(id, user_id)
    on delete cascade,
  unique (conversation_id, position)
);

create index if not exists conversations_user_updated_idx
  on public.conversations(user_id, updated_at desc);
create index if not exists messages_conversation_position_idx
  on public.messages(conversation_id, position);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.conversations set updated_at = now()
  where id = new.conversation_id and user_id = new.user_id;
  return new;
end;
$$;

create or replace function public.assign_message_position()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.conversation_id::text, 0)
  );
  select coalesce(max(message.position), -1) + 1
    into new.position
  from public.messages as message
  where message.conversation_id = new.conversation_id;
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.profiles.full_name),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.touch_conversation() from public, anon, authenticated;
revoke all on function public.assign_message_position() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at before update on public.conversations
for each row execute function public.set_updated_at();
drop trigger if exists messages_touch_conversation on public.messages;
create trigger messages_touch_conversation after insert or update on public.messages
for each row execute function public.touch_conversation();
drop trigger if exists messages_assign_position on public.messages;
create trigger messages_assign_position before insert on public.messages
for each row execute function public.assign_message_position();
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert or update of email, raw_user_meta_data on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

revoke all on public.profiles, public.conversations, public.messages from anon;
revoke all on public.profiles, public.conversations, public.messages from authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.messages to authenticated;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select to authenticated
using ((select auth.uid()) = id);
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles for insert to authenticated
with check ((select auth.uid()) = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update to authenticated
using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists "conversations_select_own" on public.conversations;
create policy "conversations_select_own" on public.conversations for select to authenticated
using ((select auth.uid()) = user_id);
drop policy if exists "conversations_insert_own" on public.conversations;
create policy "conversations_insert_own" on public.conversations for insert to authenticated
with check ((select auth.uid()) = user_id);
drop policy if exists "conversations_update_own" on public.conversations;
create policy "conversations_update_own" on public.conversations for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "conversations_delete_own" on public.conversations;
create policy "conversations_delete_own" on public.conversations for delete to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "messages_select_own" on public.messages;
create policy "messages_select_own" on public.messages for select to authenticated
using ((select auth.uid()) = user_id);
drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own" on public.messages for insert to authenticated
with check ((select auth.uid()) = user_id);
drop policy if exists "messages_update_own" on public.messages;
create policy "messages_update_own" on public.messages for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "messages_delete_own" on public.messages;
create policy "messages_delete_own" on public.messages for delete to authenticated
using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-attachments', 'chat-attachments', false, 1572864,
  array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "chat_attachments_select_own" on storage.objects;
create policy "chat_attachments_select_own" on storage.objects for select to authenticated
using (bucket_id = 'chat-attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "chat_attachments_insert_own" on storage.objects;
create policy "chat_attachments_insert_own" on storage.objects for insert to authenticated
with check (bucket_id = 'chat-attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "chat_attachments_update_own" on storage.objects;
create policy "chat_attachments_update_own" on storage.objects for update to authenticated
using (bucket_id = 'chat-attachments' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'chat-attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "chat_attachments_delete_own" on storage.objects;
create policy "chat_attachments_delete_own" on storage.objects for delete to authenticated
using (bucket_id = 'chat-attachments' and (storage.foldername(name))[1] = (select auth.uid())::text);

commit;
