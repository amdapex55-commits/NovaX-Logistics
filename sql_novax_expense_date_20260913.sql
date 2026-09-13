-- NovaX, 13 Sep 2026: the expense tab goes into real use tomorrow.
-- An expense is recorded retrospectively ("yesterday's petrol"), so it needs a
-- date of its own -- created_at only ever says when someone typed it.
begin;

alter table public.expenses
  add column if not exists expense_date date
  not null default (now() at time zone 'Asia/Karachi')::date;

create index if not exists expenses_expense_date_idx on public.expenses (expense_date desc);
create index if not exists expenses_branch_idx       on public.expenses (branch);

commit;
