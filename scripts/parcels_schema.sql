-- parcels_schema.sql
-- Run once in the Supabase SQL Editor before loading data.
-- Project: aqbyxpiwugcvoephsvpm

set statement_timeout = 0;

-- ── Extensions ────────────────────────────────────────────────────────────────
create extension if not exists postgis;
create extension if not exists vector;

-- ── Core parcel geometry ──────────────────────────────────────────────────────
create table if not exists public.parcels (
  parcel_id  text primary key,                        -- TCAD PROP_ID
  geom       geometry(MultiPolygon, 4326) not null,
  centroid   geometry(Point, 4326),
  metadata   jsonb not null default '{}'::jsonb,      -- geo_id, situs_address, legal_desc, tcad_acres
  created_at timestamptz not null default now()
);

create index if not exists parcels_geom_idx     on public.parcels using gist (geom);
create index if not exists parcels_centroid_idx on public.parcels using gist (centroid);

alter table public.parcels enable row level security;

drop policy if exists "anon read parcels" on public.parcels;
create policy "anon read parcels" on public.parcels
  for select using (true);

-- ── RAG: documents ────────────────────────────────────────────────────────────
create table if not exists public.parcel_documents (
  id         bigserial primary key,
  parcel_id  text references public.parcels on delete cascade,
  source     text,        -- 'permit','case','deed','commission_minutes', etc.
  source_id  text,
  body       text,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists parcel_documents_parcel_idx on public.parcel_documents (parcel_id);
create index if not exists parcel_documents_source_idx on public.parcel_documents (source, source_id);

alter table public.parcel_documents enable row level security;
drop policy if exists "anon read parcel_documents" on public.parcel_documents;
create policy "anon read parcel_documents" on public.parcel_documents
  for select using (true);

-- ── RAG: embeddings ───────────────────────────────────────────────────────────
create table if not exists public.parcel_embeddings (
  id          bigserial primary key,
  document_id bigint references public.parcel_documents on delete cascade,
  parcel_id   text references public.parcels on delete cascade,
  embedding   vector(1536),
  created_at  timestamptz not null default now()
);

create index if not exists parcel_embeddings_parcel_idx on public.parcel_embeddings (parcel_id);
create index if not exists parcel_embeddings_vec_idx    on public.parcel_embeddings
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

alter table public.parcel_embeddings enable row level security;
drop policy if exists "anon read parcel_embeddings" on public.parcel_embeddings;
create policy "anon read parcel_embeddings" on public.parcel_embeddings
  for select using (true);

-- ── Knowledge-graph nodes ─────────────────────────────────────────────────────
-- Polymorphic entity table. node_type values:
--   'parcel' | 'case' | 'permit' | 'document' | 'person' | 'project'
create table if not exists public.kg_nodes (
  id          uuid primary key default gen_random_uuid(),
  node_type   text not null,
  external_id text,        -- type-specific external key (PROP_ID, case#, permit#, …)
  parcel_id   text references public.parcels on delete set null,  -- nullable anchor
  label       text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists kg_nodes_type_ext_idx on public.kg_nodes (node_type, external_id);
create index if not exists kg_nodes_parcel_idx   on public.kg_nodes (parcel_id);

alter table public.kg_nodes enable row level security;
drop policy if exists "anon read kg_nodes" on public.kg_nodes;
create policy "anon read kg_nodes" on public.kg_nodes
  for select using (true);

-- ── Knowledge-graph edges ─────────────────────────────────────────────────────
-- Directed, typed relationships.
-- edge_type examples: 'has_permit','has_case','has_document','involves_person','part_of_project'
create table if not exists public.kg_edges (
  id          uuid primary key default gen_random_uuid(),
  from_node   uuid not null references public.kg_nodes on delete cascade,
  to_node     uuid not null references public.kg_nodes on delete cascade,
  edge_type   text not null,
  weight      float not null default 1.0,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists kg_edges_from_idx on public.kg_edges (from_node);
create index if not exists kg_edges_to_idx   on public.kg_edges (to_node);
create index if not exists kg_edges_type_idx on public.kg_edges (edge_type);

alter table public.kg_edges enable row level security;
drop policy if exists "anon read kg_edges" on public.kg_edges;
create policy "anon read kg_edges" on public.kg_edges
  for select using (true);

-- ── RAG retrieval helper ──────────────────────────────────────────────────────
-- Returns top-k document chunks nearest to a query embedding, filtered by parcel.
create or replace function public.match_parcel_documents(
  query_embedding vector(1536),
  match_parcel_id text,
  match_count     int default 5
)
returns table (
  document_id bigint,
  parcel_id   text,
  source      text,
  source_id   text,
  body        text,
  metadata    jsonb,
  similarity  float
)
language sql stable
as $$
  select
    e.document_id,
    e.parcel_id,
    d.source,
    d.source_id,
    d.body,
    d.metadata,
    1 - (e.embedding <=> query_embedding) as similarity
  from public.parcel_embeddings e
  join public.parcel_documents  d on d.id = e.document_id
  where e.parcel_id = match_parcel_id
  order by e.embedding <=> query_embedding
  limit match_count;
$$;
