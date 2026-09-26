-- Page-first editor: copy edits and lifecycle operations are versioned separately
-- from the original event/legal document contracts.
CREATE TABLE page_edits (
  path TEXT PRIMARY KEY,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  base_commit TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  publication_status TEXT NOT NULL DEFAULT 'published' CHECK(publication_status IN ('published','unpublished','deleted')),
  updated_at TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE TABLE page_edit_versions (
  path TEXT NOT NULL REFERENCES page_edits(path),
  version INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  base_commit TEXT NOT NULL,
  publication_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  PRIMARY KEY(path,version)
);
CREATE TRIGGER page_edit_created AFTER INSERT ON page_edits BEGIN
  INSERT INTO page_edit_versions VALUES(new.path,new.version,new.payload,new.base_commit,new.publication_status,new.updated_at,new.actor);
END;
CREATE TRIGGER page_edit_updated AFTER UPDATE OF version ON page_edits BEGIN
  INSERT INTO page_edit_versions VALUES(new.path,new.version,new.payload,new.base_commit,new.publication_status,new.updated_at,new.actor);
END;
CREATE TABLE page_publications (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL REFERENCES page_edits(path),
  version INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  base_commit TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('publish','unpublish','delete','restore')),
  status TEXT NOT NULL CHECK(status IN ('queued','processing','pr_created','failed','no_change','closed','merged','deployed','verified')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  lease TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  pr_number INTEGER,
  message TEXT NOT NULL DEFAULT '',
  commit_sha TEXT,
  UNIQUE(path,version,operation)
);
CREATE INDEX page_publication_queue ON page_publications(status,created_at);
