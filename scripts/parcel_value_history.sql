-- scripts/parcel_value_history.sql
-- RPC: public.parcel_value_history(p_parcel_id text) -> jsonb
--
-- Phase C of the value-representation work. Returns a parcel's year-by-year
-- appraisal values (from public.parcel_appraisal_history) as an ordered array,
-- for the value-over-time sparkline in the report. History is populated by
-- load_tcad_appraisal.py (current PACS year) and load_tcad_ears_history.py
-- (prior EARS years).
--
-- Run once in Supabase (or via the load workflows' psql apply step). Safe to re-run.

create or replace function public.parcel_value_history(p_parcel_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'yr',        yr,
        'market',    market_val,
        'appraised', appraised_val,
        'assessed',  assessed_val,
        'land',      land_val,
        'impr',      impr_val,
        'cap',       cap_loss
      ) order by yr
    ),
    '[]'::jsonb)
  from public.parcel_appraisal_history
  where parcel_id = p_parcel_id;
$$;

grant execute on function public.parcel_value_history(text) to anon, authenticated;
