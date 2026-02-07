-- Add app_icon_url column to projects table for custom uploaded icon images
ALTER TABLE projects ADD COLUMN IF NOT EXISTS app_icon_url TEXT;
