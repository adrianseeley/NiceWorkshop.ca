-- Preserve customer fulfillment instructions and accepted terms together with
-- the exact draft payload. Credentials and payment-card data never belong here.
ALTER TABLE checkout_attempts ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(metadata) = 'object');
ALTER TABLE checkout_attempts ADD COLUMN last_error_code text;

CREATE OR REPLACE FUNCTION protect_checkout_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.idempotency_key, NEW.request_hash, NEW.cuts,
    NEW.catalogue_snapshot, NEW.catalogue_hash, NEW.quoted_subtotal_cents,
    NEW.currency, NEW.fulfillment, NEW.lead_time_days, NEW.created_at, NEW.metadata)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.idempotency_key, OLD.request_hash, OLD.cuts,
    OLD.catalogue_snapshot, OLD.catalogue_hash, OLD.quoted_subtotal_cents,
    OLD.currency, OLD.fulfillment, OLD.lead_time_days, OLD.created_at, OLD.metadata) THEN
    RAISE EXCEPTION 'Checkout snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
