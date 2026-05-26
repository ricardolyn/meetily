-- Migration: Add projects for grouping meetings by filesystem folder
-- A project is an optional grouping with a user-chosen folder.
-- Meetings recorded under a project write their files into that folder; otherwise they
-- fall back to the default recordings folder.

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    folder_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

ALTER TABLE meetings ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_meetings_project_id ON meetings(project_id);
