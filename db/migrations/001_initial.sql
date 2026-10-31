CREATE TABLE checkout_attempts (
  id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  cuts jsonb NOT NULL CHECK (jsonb_typeof(cuts) = 'array' AND jsonb_array_length(cuts) BETWEEN 1 AND 100),
  catalogue_snapshot jsonb NOT NULL CHECK (jsonb_typeof(catalogue_snapshot) = 'object'),
  catalogue_hash text NOT NULL CHECK (catalogue_hash ~ '^[a-f0-9]{64}$'),
  quoted_subtotal_cents bigint NOT NULL CHECK (quoted_subtotal_cents >= 0 AND quoted_subtotal_cents <= 9007199254740991),
  currency text NOT NULL DEFAULT 'CAD' CHECK (currency = 'CAD'),
  fulfillment text NOT NULL CHECK (fulfillment IN ('pickup', 'delivery')),
  lead_time_days integer NOT NULL CHECK (lead_time_days BETWEEN 1 AND 365),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'creating', 'ready', 'needs_reconciliation', 'failed')),
  shopify_draft_id text UNIQUE,
  checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'ready' OR (shopify_draft_id IS NOT NULL AND checkout_url IS NOT NULL))
);

-- A retry may advance checkout state, but must never change the agreed input.
CREATE FUNCTION protect_checkout_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.idempotency_key, NEW.request_hash, NEW.cuts,
    NEW.catalogue_snapshot, NEW.catalogue_hash, NEW.quoted_subtotal_cents,
    NEW.currency, NEW.fulfillment, NEW.lead_time_days, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.idempotency_key, OLD.request_hash, OLD.cuts,
    OLD.catalogue_snapshot, OLD.catalogue_hash, OLD.quoted_subtotal_cents,
    OLD.currency, OLD.fulfillment, OLD.lead_time_days, OLD.created_at) THEN
    RAISE EXCEPTION 'Checkout snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER checkout_snapshot_immutable BEFORE UPDATE ON checkout_attempts
  FOR EACH ROW EXECUTE FUNCTION protect_checkout_snapshot();

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  shop text NOT NULL CHECK (shop ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  shopify_order_id text NOT NULL,
  checkout_attempt_id uuid NOT NULL UNIQUE REFERENCES checkout_attempts(id),
  cuts jsonb NOT NULL CHECK (jsonb_typeof(cuts) = 'array' AND jsonb_array_length(cuts) BETWEEN 1 AND 100),
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN
    ('pending', 'authorized', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'voided', 'expired', 'unknown')),
  cancelled_at timestamptz,
  refunded boolean NOT NULL DEFAULT false,
  hold_reason text,
  is_cut boolean NOT NULL DEFAULT false,
  cut_at timestamptz,
  cut_by text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  shopify_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop, shopify_order_id),
  CHECK ((is_cut AND cut_at IS NOT NULL AND cut_by IS NOT NULL AND length(cut_by) > 0)
    OR (NOT is_cut AND cut_at IS NULL AND cut_by IS NULL))
);
CREATE INDEX orders_production_queue ON orders (is_cut, created_at);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  event text NOT NULL,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 256),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_order ON audit_log (order_id, id);
CREATE FUNCTION protect_audit_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit history is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION protect_audit_log();

CREATE TABLE webhook_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop text NOT NULL CHECK (shop ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  webhook_id text NOT NULL,
  event_id text,
  topic text NOT NULL,
  raw_body_hash text NOT NULL CHECK (raw_body_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processed', 'needs_reconciliation', 'failed', 'ignored')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error_code text,
  UNIQUE (shop, webhook_id)
);
CREATE INDEX webhook_deliveries_pending ON webhook_deliveries (state, received_at);
