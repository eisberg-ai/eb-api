-- Add icon column to projects table
-- Stores icon identifier in format "iconId:colorId" (e.g., "rocket:cyan")
-- The actual PNG is generated on-demand via /generate-icon endpoint

ALTER TABLE projects ADD COLUMN IF NOT EXISTS icon TEXT;

COMMENT ON COLUMN projects.icon IS 'App icon identifier (format: iconId:colorId, e.g., rocket:cyan)';
