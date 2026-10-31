ALTER TABLE orders ADD COLUMN ready_at timestamptz;
ALTER TABLE orders ADD COLUMN ready_by text;
ALTER TABLE orders ADD COLUMN ready_generation integer NOT NULL DEFAULT 0 CHECK (ready_generation >= 0);
ALTER TABLE orders ADD CONSTRAINT ready_state_consistent CHECK (
  (ready_at IS NULL AND ready_by IS NULL) OR
  (ready_at IS NOT NULL AND ready_by IS NOT NULL AND length(ready_by) BETWEEN 1 AND 256 AND ready_generation > 0)
);

CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  generation integer NOT NULL CHECK (generation > 0),
  kind text NOT NULL CHECK (kind IN ('pickup','delivery')),
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 3 AND 254 AND recipient !~ '[[:cntrl:]]'),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 300 AND subject !~ '[[:cntrl:]]'),
  text_body text NOT NULL CHECK (length(text_body) BETWEEN 1 AND 100000),
  html_body text NOT NULL CHECK (length(html_body) BETWEEN 1 AND 200000),
  message_id text NOT NULL UNIQUE,
  template_version text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','sent','failed','needs_review','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  queued_at timestamptz NOT NULL DEFAULT now(),
  sending_at timestamptz,
  sent_at timestamptz,
  last_error_code text,
  UNIQUE (order_id,generation)
);
CREATE INDEX notification_outbox_work ON notification_outbox(state,queued_at);
CREATE FUNCTION protect_notification_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.order_id,NEW.generation,NEW.kind,NEW.recipient,NEW.subject,
    NEW.text_body,NEW.html_body,NEW.message_id,NEW.template_version,NEW.queued_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.order_id,OLD.generation,OLD.kind,OLD.recipient,OLD.subject,
    OLD.text_body,OLD.html_body,OLD.message_id,OLD.template_version,OLD.queued_at) THEN
    RAISE EXCEPTION 'Notification snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER notification_snapshot_immutable BEFORE UPDATE ON notification_outbox
  FOR EACH ROW EXECUTE FUNCTION protect_notification_snapshot();
