-- 0005_permission_catalog: the global list of granular permissions.
-- Must stay in sync with packages/contracts/src/permissions.ts (a test checks this).

INSERT INTO permissions (key, description) VALUES
  ('org.read',                 'View organization profile'),
  ('org.manage',               'Change organization settings'),
  ('members.read',             'View the employee list'),
  ('members.manage',           'Invite, remove, and change roles of members'),
  ('customers.read',           'View customers and their contact details'),
  ('customers.manage',         'Create and edit customers'),
  ('jobs.read_all',            'View every job in the organization'),
  ('jobs.read_assigned',       'View jobs the member is assigned to'),
  ('jobs.manage',              'Create and edit jobs'),
  ('job_assignments.manage',   'Assign and unassign members on jobs'),
  ('photos.upload',            'Upload photos to accessible jobs'),
  ('photo_flags.create',       'Flag a photo on an accessible job'),
  ('photo_flags.manage',       'Resolve photo flags'),
  ('receipts.submit',          'Submit receipts'),
  ('receipts.read_own',        'View receipts the member submitted'),
  ('receipts.read_all',        'View every receipt in the organization'),
  ('financials.read',          'View financial totals and reports'),
  ('vehicles.read_all',        'View every vehicle'),
  ('vehicles.read_assigned',   'View vehicles assigned to the member'),
  ('vehicles.manage',          'Create and edit vehicles and vehicle assignments'),
  ('mileage.submit',           'Submit mileage for an accessible vehicle'),
  ('mileage.read_all',         'View all mileage records'),
  ('maintenance.report',       'Report a maintenance issue on an accessible vehicle'),
  ('maintenance.manage',       'Manage maintenance records'),
  ('audit.read',               'View the audit log');
