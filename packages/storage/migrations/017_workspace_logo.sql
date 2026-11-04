-- Own logo of a workspace (PNG, JPEG or WebP, checked by its first bytes; no SVG).
ALTER TABLE workspaces ADD COLUMN logo bytea;
ALTER TABLE workspaces ADD COLUMN logo_type text;
ALTER TABLE workspaces ADD COLUMN logo_updated_at timestamptz;
