-- 全库全文检索 FTS5 索引：只存索引令牌，正文权威仍在 document_pages（external content）。
-- 既加快多词与大库检索，又不把 SQLite 体积翻倍；增删改通过触发器自动同步。

CREATE VIRTUAL TABLE document_pages_fts USING fts5(
	text,
	content='document_pages',
	content_rowid='rowid',
	tokenize='unicode61'
);

CREATE TRIGGER document_pages_fts_ai AFTER INSERT ON document_pages BEGIN
	INSERT INTO document_pages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER document_pages_fts_ad AFTER DELETE ON document_pages BEGIN
	INSERT INTO document_pages_fts(document_pages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER document_pages_fts_au AFTER UPDATE ON document_pages BEGIN
	INSERT INTO document_pages_fts(document_pages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
	INSERT INTO document_pages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

INSERT INTO document_pages_fts(rowid, text) SELECT rowid, text FROM document_pages;
