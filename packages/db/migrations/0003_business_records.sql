-- 0003_business_records: customers, jobs, documents, photos, receipts, fleet.
--
-- Rules applied to every table here:
--   * organization_id NOT NULL.
--   * UNIQUE (organization_id, id) so children can use composite foreign keys.
--   * Every reference to another tenant-owned row is a composite FK that
--     includes organization_id, so cross-organization links are impossible.
--   * Soft delete (deleted_at) instead of hard delete; the runtime role has no DELETE.
--   * client_ref (nullable uuid) = idempotency key generated on the device for
--     offline submissions; unique per organization.

CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  contact_name     text CHECK (contact_name IS NULL OR length(contact_name) <= 200),
  contact_email    citext CHECK (contact_email IS NULL OR (length(contact_email) <= 320 AND contact_email LIKE '%_@_%')),
  contact_phone    text CHECK (contact_phone IS NULL OR contact_phone ~ '^[0-9+() .-]{7,30}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (organization_id, id)
);

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id      uuid,
  job_number       text NOT NULL CHECK (job_number ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$'),
  title            text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  site_name        text CHECK (site_name IS NULL OR length(site_name) <= 200),
  site_address     text CHECK (site_address IS NULL OR length(site_address) <= 500),
  status           text NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned', 'active', 'on_hold', 'completed', 'cancelled')),
  scheduled_start  date,
  scheduled_end    date,
  created_by_membership_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, job_number),
  CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end >= scheduled_start),
  FOREIGN KEY (organization_id, customer_id) REFERENCES customers (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX jobs_org_status_idx ON jobs (organization_id, status);

CREATE TABLE job_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  job_id           uuid NOT NULL,
  membership_id    uuid NOT NULL,
  assigned_by_membership_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, job_id) REFERENCES jobs (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, assigned_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);
-- Only one open assignment per person per job.
CREATE UNIQUE INDEX job_assignments_open_uq ON job_assignments (organization_id, job_id, membership_id) WHERE ended_at IS NULL;
CREATE INDEX job_assignments_member_idx ON job_assignments (organization_id, membership_id) WHERE ended_at IS NULL;

-- Stored files are referenced by an opaque storage key inside private blob
-- storage. Original file names are kept as metadata only and never used as paths.
CREATE TABLE documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  job_id           uuid,
  storage_key      text NOT NULL CHECK (storage_key ~ '^[a-z0-9/_-]{1,300}$'),
  original_filename text NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  content_type     text NOT NULL CHECK (content_type IN (
                     'application/pdf', 'image/jpeg', 'image/png', 'image/heic',
                     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                     'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes       bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 104857600),
  sha256           text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  classification   text NOT NULL DEFAULT 'confidential' CHECK (classification IN ('internal', 'confidential', 'restricted')),
  uploaded_by_membership_id uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, storage_key),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, job_id) REFERENCES jobs (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, uploaded_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE photos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  job_id           uuid NOT NULL,
  storage_key      text CHECK (storage_key IS NULL OR storage_key ~ '^[a-z0-9/_-]{1,300}$'),
  content_type     text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/heic')),
  size_bytes       bigint CHECK (size_bytes IS NULL OR (size_bytes > 0 AND size_bytes <= 52428800)),
  stage            text NOT NULL CHECK (stage IN ('before', 'during', 'after', 'issue', 'other')),
  caption          text CHECK (caption IS NULL OR length(caption) <= 500),
  captured_at      timestamptz NOT NULL,
  upload_status    text NOT NULL DEFAULT 'pending' CHECK (upload_status IN ('pending', 'stored', 'rejected')),
  uploaded_by_membership_id uuid NOT NULL,
  client_ref       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, client_ref),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, job_id) REFERENCES jobs (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, uploaded_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX photos_job_idx ON photos (organization_id, job_id);

CREATE TABLE photo_flags (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  photo_id         uuid NOT NULL,
  flagged_by_membership_id uuid NOT NULL,
  reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_by_membership_id uuid,
  resolution_note  text CHECK (resolution_note IS NULL OR length(resolution_note) <= 1000),
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK ((status = 'open' AND resolved_at IS NULL AND resolved_by_membership_id IS NULL)
      OR (status = 'resolved' AND resolved_at IS NOT NULL AND resolved_by_membership_id IS NOT NULL)),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, photo_id) REFERENCES photos (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, flagged_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, resolved_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);

-- Money is stored as integer minor units (cents) to avoid floating-point error.
CREATE TABLE receipts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  job_id           uuid,
  submitted_by_membership_id uuid NOT NULL,
  vendor           text NOT NULL CHECK (length(btrim(vendor)) BETWEEN 1 AND 200),
  amount_cents     bigint NOT NULL CHECK (amount_cents >= 0 AND amount_cents <= 100000000),
  currency         char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  purchased_on     date NOT NULL,
  category         text NOT NULL CHECK (category IN ('materials', 'fuel', 'tools', 'equipment_rental', 'meals', 'lodging', 'permits', 'other')),
  notes            text CHECK (notes IS NULL OR length(notes) <= 1000),
  document_id      uuid,
  status           text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  client_ref       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, client_ref),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, job_id) REFERENCES jobs (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, submitted_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, document_id) REFERENCES documents (organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX receipts_submitter_idx ON receipts (organization_id, submitted_by_membership_id);

CREATE TABLE vehicles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  unit_number      text NOT NULL CHECK (unit_number ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$'),
  make             text NOT NULL CHECK (length(btrim(make)) BETWEEN 1 AND 60),
  model            text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 60),
  model_year       smallint CHECK (model_year IS NULL OR model_year BETWEEN 1980 AND 2100),
  vin              text CHECK (vin IS NULL OR vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  license_plate    text CHECK (license_plate IS NULL OR license_plate ~ '^[A-Z0-9 -]{1,12}$'),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'in_shop', 'retired')),
  current_odometer integer CHECK (current_odometer IS NULL OR current_odometer >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, unit_number)
);
CREATE UNIQUE INDEX vehicles_vin_uq ON vehicles (organization_id, vin) WHERE vin IS NOT NULL;

CREATE TABLE vehicle_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  vehicle_id       uuid NOT NULL,
  membership_id    uuid NOT NULL,
  starts_at        timestamptz NOT NULL DEFAULT now(),
  ends_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, vehicle_id) REFERENCES vehicles (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX vehicle_assignments_open_uq ON vehicle_assignments (organization_id, vehicle_id, membership_id) WHERE ends_at IS NULL;

CREATE TABLE mileage_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  vehicle_id       uuid NOT NULL,
  membership_id    uuid NOT NULL,
  job_id           uuid,
  trip_date        date NOT NULL,
  odometer_start   integer NOT NULL CHECK (odometer_start >= 0),
  odometer_end     integer NOT NULL,
  purpose          text CHECK (purpose IS NULL OR length(purpose) <= 300),
  client_ref       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, client_ref),
  CHECK (odometer_end >= odometer_start AND odometer_end - odometer_start <= 2000),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, vehicle_id) REFERENCES vehicles (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, job_id) REFERENCES jobs (organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE maintenance_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  vehicle_id       uuid NOT NULL,
  reported_by_membership_id uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('issue', 'service')),
  description      text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
  odometer         integer CHECK (odometer IS NULL OR odometer >= 0),
  cost_cents       bigint CHECK (cost_cents IS NULL OR (cost_cents >= 0 AND cost_cents <= 100000000)),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
  client_ref       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, client_ref),
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, vehicle_id) REFERENCES vehicles (organization_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id, reported_by_membership_id) REFERENCES organization_memberships (organization_id, id) ON DELETE RESTRICT
);

-- updated_at + organization_id immutability triggers for tenant tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'jobs', 'receipts', 'vehicles', 'maintenance_records'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t || '_touch', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['customers', 'jobs', 'job_assignments', 'documents', 'photos', 'photo_flags',
                           'receipts', 'vehicles', 'vehicle_assignments', 'mileage_records',
                           'maintenance_records', 'roles'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.forbid_org_change()', t || '_org_immutable', t);
  END LOOP;
END
$$;
