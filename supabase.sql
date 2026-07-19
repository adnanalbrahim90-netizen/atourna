-- شغّل هذا الملف كاملاً في Supabase → SQL Editor → New query → Run
-- ينشئ جدول تخزين واحد يحفظ كل بيانات نظام "عطورنا" (مستخدمين، منتجات،
-- مبيعات، فواتير، إعدادات) بشكل مشترك بين كل الأجهزة.

create table if not exists public.kv_store (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- تفعيل أمان مستوى الصف (يبقيه معطلاً للقراءة/الكتابة العامة عبر anon key،
-- وهذا مطلوب لأن التطبيق عميل مباشر (client-only) بدون خادم خلفي).
alter table public.kv_store enable row level security;

drop policy if exists "allow anon read" on public.kv_store;
create policy "allow anon read"
  on public.kv_store for select
  to anon
  using (true);

drop policy if exists "allow anon write" on public.kv_store;
create policy "allow anon write"
  on public.kv_store for insert
  to anon
  with check (true);

drop policy if exists "allow anon update" on public.kv_store;
create policy "allow anon update"
  on public.kv_store for update
  to anon
  using (true)
  with check (true);

drop policy if exists "allow anon delete" on public.kv_store;
create policy "allow anon delete"
  on public.kv_store for delete
  to anon
  using (true);

-- ملاحظة أمان مهمة:
-- هذه السياسات تسمح لأي شخص يملك رابط الموقع + مفتاح anon (وهو مفتاح عام
-- يظهر في كود المتصفح أصلاً) بقراءة/تعديل بيانات هذا الجدول. هذا مقبول لتطبيق
-- داخلي صغير لا يحتوي بيانات حساسة جداً (كنظام مبيعات محل)، لكنه ليس بنفس
-- درجة حماية تطبيق يستخدم تسجيل دخول من طرف الخادم (auth حقيقي). إذا احتجت
-- حماية أقوى مستقبلاً، أخبرني لإضافة Supabase Auth بدلاً من كلمات المرور
-- المخزّنة داخل الجدول نفسه.
