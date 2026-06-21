-- kg_schema.sql
-- Knowledge-graph layer on top of parcels_schema.sql.
-- Run once in the Supabase SQL Editor AFTER parcels_schema.sql.
-- Project: aqbyxpiwugcvoephsvpm
--
-- Adds: per-source ingest cursors, a point-in-parcel geocoder, a unique
-- constraint so ingestion can upsert nodes idempotently, and a parcel-centric
-- read view the frontend panel fetches in a single round-trip.

set statement_timeout = 0;

-- ── Ingest cursors (mirrors parcels_load_state) ───────────────────────────────
create table if not exists public.kg_ingest_state (
  source       text primary key,      -- 'zoning_cases' | 'permits' | 'votes' | 'embeddings'
  cursor_value text,                  -- last $offset processed (as text)
  last_run     timestamptz,
  last_result  jsonb not null default '{}'::jsonb
);

alter table public.kg_ingest_state enable row level security;
drop policy if exists "anon read kg_ingest_state" on public.kg_ingest_state;
create policy "anon read kg_ingest_state" on public.kg_ingest_state
  for select using (true);

-- ── Idempotency: one node per (node_type, external_id) ────────────────────────
-- Lets ingestion use ON CONFLICT to upsert without duplicating nodes.
create unique index if not exists kg_nodes_type_ext_uniq
  on public.kg_nodes (node_type, external_id)
  where external_id is not null;

-- One edge per (from, to, edge_type).
create unique index if not exists kg_edges_uniq
  on public.kg_edges (from_node, to_node, edge_type);

-- De-dupe documents per (source, source_id).
create unique index if not exists parcel_documents_source_uniq
  on public.parcel_documents (source, source_id)
  where source_id is not null;

-- ── Point-in-parcel geocoder ──────────────────────────────────────────────────
-- Returns the parcel_id whose polygon contains the given lon/lat, or NULL.
-- Uses the existing GIST index on parcels.geom.
create or replace function public.link_point_to_parcel(lon double precision, lat double precision)
returns text
language sql stable
as $$
  select p.parcel_id
  from public.parcels p
  where st_contains(p.geom, st_setsrid(st_makepoint(lon, lat), 4326))
  limit 1;
$$;

-- ── Parcel-centric read view ──────────────────────────────────────────────────
-- One row per parcel that has at least one connected node, with connections
-- grouped by type as JSON arrays. The panel fetches:
--   /rest/v1/parcel_graph?parcel_id=eq.<id>
create or replace view public.parcel_graph
with (security_invoker = true)
as
with case_votes as (
  -- votes attached to a case via has_vote edges
  select
    cn.id as case_node_id,
    jsonb_agg(
      jsonb_build_object(
        'vote_id',    vn.external_id,
        'voter',      vn.metadata->>'voter_name',
        'vote',       vn.metadata->>'vote_cast',
        'action',     vn.metadata->>'action',
        'meeting_date', vn.metadata->>'meeting_date'
      ) order by vn.metadata->>'voter_name'
    ) as votes
  from public.kg_edges e
  join public.kg_nodes cn on cn.id = e.from_node and cn.node_type = 'case'
  join public.kg_nodes vn on vn.id = e.to_node   and vn.node_type = 'vote'
  where e.edge_type = 'has_vote'
  group by cn.id
)
select
  n.parcel_id,
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'case_number',  n.external_id,
        'label',        n.label,
        'status',       n.metadata->>'status',
        'zoning',       n.metadata->>'zoning',
        'district',     n.metadata->>'district',
        'approval_date', n.metadata->>'approval_date',
        'votes',        coalesce(cv.votes, '[]'::jsonb)
      ) order by n.metadata->>'approval_date' desc nulls last
    ) filter (where n.node_type = 'case'),
    '[]'::jsonb
  ) as cases,
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'permit_number', n.external_id,
        'type',         n.metadata->>'type',
        'status',       n.metadata->>'status',
        'issue_date',   n.metadata->>'issue_date'
      ) order by n.metadata->>'issue_date' desc nulls last
    ) filter (where n.node_type = 'permit'),
    '[]'::jsonb
  ) as permits
from public.kg_nodes n
left join case_votes cv on cv.case_node_id = n.id
where n.parcel_id is not null
  and n.node_type in ('case', 'permit')
group by n.parcel_id;
