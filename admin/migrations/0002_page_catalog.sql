-- Read-only deployment catalogue. It does not grant new authoring permission.
CREATE TABLE published_pages (
 path TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 source_path TEXT NOT NULL,
 source_kind TEXT NOT NULL,
 editor_scope TEXT NOT NULL CHECK(editor_scope IN ('none','partial')),
 commit_sha TEXT NOT NULL,
 observed_at TEXT NOT NULL
);
