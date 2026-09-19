begin;

alter table public.conversations
  add column if not exists subject text not null default 'math';

alter table public.conversations
  drop constraint if exists conversations_subject_check;

alter table public.conversations
  add constraint conversations_subject_check
  check (subject in ('math', 'physics', 'chemistry'));

create index if not exists conversations_user_subject_updated_idx
  on public.conversations(user_id, subject, updated_at desc);

commit;
