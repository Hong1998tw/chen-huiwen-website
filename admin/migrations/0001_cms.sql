CREATE TABLE documents (
 id TEXT PRIMARY KEY, domain TEXT NOT NULL CHECK(domain IN ('events','legal-schedule')),
 record_key TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 base_hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL, actor TEXT NOT NULL,
 UNIQUE(domain,record_key)
);
CREATE TABLE versions (
 document_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL,
 payload TEXT NOT NULL, base_hash TEXT NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL,
 PRIMARY KEY(document_id,version)
);
CREATE TRIGGER document_created AFTER INSERT ON documents BEGIN
 INSERT INTO versions VALUES(new.id,new.version,new.payload,new.base_hash,new.updated_at,new.actor);
END;
CREATE TRIGGER document_updated AFTER UPDATE OF version ON documents BEGIN
 INSERT INTO versions VALUES(new.id,new.version,new.payload,new.base_hash,new.updated_at,new.actor);
END;
CREATE TABLE published_sources (
 domain TEXT NOT NULL, record_key TEXT NOT NULL, payload TEXT NOT NULL,
 source_hash TEXT NOT NULL, commit_sha TEXT NOT NULL, observed_at TEXT NOT NULL,
 PRIMARY KEY(domain,record_key)
);
CREATE TABLE publications (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL,
 domain TEXT NOT NULL, record_key TEXT NOT NULL, payload TEXT NOT NULL, base_hash TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','processing','pr_created','failed','no_change','closed','merged','deployed','verified')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, actor TEXT NOT NULL,
 lease TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
 pr_number INTEGER, message TEXT NOT NULL DEFAULT '', commit_sha TEXT,
 UNIQUE(document_id,version)
);
CREATE INDEX publication_queue ON publications(status,created_at);
-- Authentication providers and membership are separate so adding password accounts later
-- does not change document ownership. Password login is not enabled by this migration.
CREATE TABLE accounts (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE identities (account_id TEXT NOT NULL REFERENCES accounts(id), provider TEXT NOT NULL, subject TEXT NOT NULL, PRIMARY KEY(provider,subject));
INSERT INTO accounts VALUES ('github:126787497','Hong1998tw','owner',0);
