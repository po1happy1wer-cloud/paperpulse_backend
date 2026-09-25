-- ============================================================
-- PaperPulse Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에서 전체를 실행하세요.
-- ============================================================

-- 1. 사용자 프로필 및 구독/크레딧 테이블
create table if not exists public.profiles (
  id uuid references auth.users not null primary key,
  email text not null,
  full_name text,
  is_subscribed boolean default false,   -- 구독 여부
  credits int default 3,                 -- 무료 체험 크레딧 (기본 3회)
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- 2. 새 유저 가입 시 profiles 테이블에 자동으로 행 추가
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. Row Level Security 활성화 — 반드시 켜야 합니다.
--    이게 없으면 다른 사람이 익명 키(anon key)만으로 누구든지
--    profiles 테이블의 모든 행을 읽고 쓸 수 있습니다.
alter table public.profiles enable row level security;

-- 본인 프로필만 조회 가능
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- 본인 프로필 중 이름 정도만 본인이 수정 가능
-- (is_subscribed, credits는 여기서 막고, 백엔드의 service_role 키로만 갱신하게 합니다)
-- 주의: RLS는 행 단위 제어라 위 정책만으로는 컬럼을 못 막습니다.
-- authenticated 롤의 UPDATE 권한 자체를 full_name 컬럼으로만 좁혀서 이중으로 막습니다.
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

create policy "profiles_update_own_name_only"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- 4. 크레딧 차감용 RPC (백엔드 service_role에서만 호출)
create or replace function public.decrement_credit(uid uuid)
returns int as $$
declare
  remaining int;
begin
  update public.profiles
  set credits = greatest(credits - 1, 0)
  where id = uid
  returning credits into remaining;
  return remaining;
end;
$$ language plpgsql security definer;

-- 프론트엔드(anon/authenticated)가 이 함수를 직접 호출해서
-- 다른 사람 크레딧까지 마음대로 깎지 못하도록 실행 권한을 회수합니다.
revoke execute on function public.decrement_credit(uuid) from public;
revoke execute on function public.decrement_credit(uuid) from authenticated;
revoke execute on function public.decrement_credit(uuid) from anon;

-- 5. 결제 내역 테이블 — 같은 결제건(payment_id)이 여러 계정에서
--    재사용/도용되는 것을 막는 안전장치입니다 (payment_id가 PK라 중복 삽입이 거부됨).
create table if not exists public.payments (
  payment_id text primary key,
  user_id uuid references auth.users not null,
  plan_id text not null,
  amount int not null,
  created_at timestamptz not null default now()
);

alter table public.payments enable row level security;

create policy "payments_select_own"
  on public.payments for select
  using (auth.uid() = user_id);
-- insert/update/delete 정책은 만들지 않습니다 = anon/authenticated는 기본적으로 전부 차단,
-- 백엔드의 service_role 키만 기록할 수 있습니다.

-- 6. 피드백 / A/S 문의 테이블
--    누구나(로그인 전이라도) 쪽지처럼 남길 수 있어야 하므로 INSERT는 열어두되,
--    다른 사람이 남긴 문의 내용을 읽을 수는 없도록 SELECT 정책은 만들지 않습니다
--    (관리자인 나만 Supabase 대시보드의 Table Editor 또는 service_role 키로 확인).
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  type text not null default '기타',
  message text not null,
  contact_email text,
  page_url text,
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;

create policy "feedback_insert_anyone"
  on public.feedback for insert
  to anon, authenticated
  with check (true);
-- select/update/delete 정책은 만들지 않습니다 = 작성자 본인도 자기 글을 다시 읽을 수 없고
-- (쪽지함이 아니라 문의 접수함 개념), service_role 키로만 확인/관리합니다.

-- 7. 서재에 내 PDF 파일 업로드하기 — Supabase Storage 버킷 생성
--    버킷 이름은 paperpulse.html의 CONFIG.PDF_BUCKET 값과 반드시 같아야 합니다 (기본값: paper-pdfs).
--    private 버킷으로 만들어서, 아래 정책으로 "본인 폴더(자기 user id로 시작하는 경로)"만
--    업로드/열람/삭제할 수 있게 제한합니다. (다른 사용자의 PDF는 절대 볼 수 없음)
insert into storage.buckets (id, name, public)
values ('paper-pdfs', 'paper-pdfs', false)
on conflict (id) do nothing;

create policy "paper_pdfs_insert_own_folder"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'paper-pdfs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "paper_pdfs_select_own_folder"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'paper-pdfs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "paper_pdfs_update_own_folder"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'paper-pdfs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "paper_pdfs_delete_own_folder"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'paper-pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
