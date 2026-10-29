-- New monthly net calculations derive the rate from salary / monthly planned
-- hours. Keep historical rate fields and snapshots for backup/audit continuity.
begin;
alter table public.payroll_terms drop constraint payroll_terms_monthly_net_rate_required;
comment on column public.payroll_terms.monthly_settlement is 'Versioned monthly wage mode: monthly_net preserves full monthly base and pays positive net minutes using monthly salary divided by monthly planned hours; statutory retains the previous calculation behavior. Existing finalized snapshots are immutable.';
comment on column public.payroll_terms.monthly_extra_hourly_rate is 'Legacy optional rate retained only for historical data and backup compatibility. New monthly_net calculations ignore it and derive the hourly rate from monthly salary / monthly planned hours. New terms may omit it or store NULL.';
commit;
