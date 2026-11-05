create table if not exists public.library_records (
  collection text not null check (
    collection in (
      'users',
      'books',
      'videos',
      'departments',
      'activity',
      'developers',
      'meta'
    )
  ),
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

create unique index if not exists library_records_user_email_unique
  on public.library_records (lower(data->>'email'))
  where collection = 'users';

alter table public.library_records enable row level security;

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('books', 'books', false, 52428800),
  ('videos', 'videos', false, 314572800),
  ('profile-photos', 'profile-photos', false, 5242880)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;
