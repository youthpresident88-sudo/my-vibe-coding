-- 0001_init: core schema for the evidence-first transaction protection platform.
-- Design rules:
--  * money is integer minor units (bigint) + ISO currency
--  * transaction_events is an append-only, hash-chained evidence ledger
--  * every state change + side-effect job is written in the same DB transaction (outbox)

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  display_name text not null,
  phone text,
  role text not null default 'user' check (role in ('user','support','arbiter','admin')),
  status text not null default 'active' check (status in ('active','suspended')),
  email_verified_at timestamptz,
  risk_score int not null default 0,
  created_at timestamptz not null default now()
);
create unique index users_email_uq on users (lower(email));

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text,
  ip text,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

create table auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  purpose text not null check (purpose in ('verify_email','reset_password')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Seller verification. status may only become 'verified' via a KYC provider result.
create table seller_profiles (
  user_id uuid primary key references users(id),
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified','pending','verified','rejected')),
  kyc_provider text,
  kyc_reference text,
  verified_at timestamptz,
  payout_account_ref text,
  created_at timestamptz not null default now()
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references users(id),
  buyer_id uuid references users(id),
  title text not null,
  description text not null default '',
  channel text not null default 'other',
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  spec jsonb not null,
  spec_hash text not null,
  state text not null check (state in (
    'awaiting_agreement','agreed','condition_documented','awaiting_payment','funded',
    'dispatched','delivered','inspected','completed','disputed','resolved','cancelled')),
  carrier text,
  tracking_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (buyer_id is null or buyer_id <> seller_id),
  check (buyer_id is not null or state in ('awaiting_agreement','cancelled'))
);
create index transactions_seller_idx on transactions (seller_id, created_at desc);
create index transactions_buyer_idx on transactions (buyer_id, created_at desc);
create index transactions_state_idx on transactions (state);

-- Append-only hash-chained evidence ledger.
create table transaction_events (
  id bigserial primary key,
  transaction_id uuid not null references transactions(id),
  seq int not null,
  type text not null,
  actor_id uuid,
  actor_role text not null,
  payload jsonb not null,
  prev_hash text not null,
  hash text not null,
  created_at timestamptz not null,
  unique (transaction_id, seq)
);

create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'table % is append-only', tg_table_name;
end $$;
create trigger transaction_events_immutable before update or delete on transaction_events
  for each row execute function forbid_mutation();

create table evidence_items (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  uploader_id uuid not null references users(id),
  phase text not null check (phase in ('seller_condition','dispatch','delivery','unboxing','inspection','dispute')),
  kind text not null check (kind in ('photo','video','document')),
  storage_key text not null unique,
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending','verified')),
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  verified_at timestamptz
);
create index evidence_tx_idx on evidence_items (transaction_id, phase);

create table inspections (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null unique references transactions(id),
  inspector_id uuid not null references users(id),
  items jsonb not null,
  overall text not null check (overall in ('matches','discrepancies')),
  created_at timestamptz not null default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  provider text not null,
  provider_session_ref text unique,
  provider_payment_ref text,
  status text not null check (status in ('creating','pending','succeeded','failed','expired','refunded','partially_refunded')),
  amount_minor bigint not null,
  currency char(3) not null,
  checkout_url text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_tx_idx on payments (transaction_id);
-- at most one live (non-terminal-failure) payment attempt per transaction
create unique index payments_one_live_uq on payments (transaction_id)
  where status in ('creating','pending','succeeded','partially_refunded','refunded');

create table payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, provider_event_id)
);

-- Money movements, recorded only after the provider confirms them.
create table money_ledger (
  id bigserial primary key,
  transaction_id uuid not null references transactions(id),
  entry_type text not null check (entry_type in ('escrow_in','payout_out','refund_out','platform_fee')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null,
  provider_ref text,
  created_at timestamptz not null default now(),
  unique (transaction_id, entry_type, provider_ref)
);
create trigger money_ledger_immutable before update or delete on money_ledger
  for each row execute function forbid_mutation();

create table disputes (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id),
  opened_by uuid not null references users(id),
  reason_code text not null check (reason_code in ('not_delivered','not_as_described','damaged','missing_items','counterfeit','other')),
  description text not null,
  status text not null default 'open' check (status in ('open','resolved')),
  resolution text check (resolution in ('full_refund','partial_refund','release_to_seller')),
  resolution_amount_minor bigint,
  resolution_reason text,
  decided_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index disputes_one_open_uq on disputes (transaction_id) where status = 'open';

-- Transactional outbox / job queue (claimed with FOR UPDATE SKIP LOCKED).
create table jobs (
  id bigserial primary key,
  queue text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','running','done','dead')),
  attempts int not null default 0,
  max_attempts int not null default 8,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_claim_idx on jobs (run_at) where status = 'pending';

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  channel text not null check (channel in ('email','sms','in_app')),
  template text not null,
  data jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  provider_message_id text,
  last_error text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notifications_user_idx on notifications (user_id, created_at desc);

create table audit_log (
  id bigserial primary key,
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  ip text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create trigger audit_log_immutable before update or delete on audit_log
  for each row execute function forbid_mutation();

create table idempotency_keys (
  user_id uuid not null references users(id),
  key text not null,
  endpoint text not null,
  request_hash text not null,
  response_status int,
  response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);
