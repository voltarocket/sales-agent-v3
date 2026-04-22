CREATE TABLE IF NOT EXISTS managers (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  avatar      VARCHAR(10),
  color       VARCHAR(20)  DEFAULT '#6366f1',
  violations  INTEGER      DEFAULT 0,
  calls_count INTEGER      DEFAULT 0,
  avg_score   NUMERIC(5,2)
);

CREATE TABLE IF NOT EXISTS contacts (
  id             SERIAL PRIMARY KEY,
  phone          VARCHAR(50)  DEFAULT '',
  company        VARCHAR(255) DEFAULT '',
  name           VARCHAR(255) DEFAULT '',
  summary        TEXT         DEFAULT '',
  transcript     TEXT         DEFAULT '',
  score          INTEGER,
  errors         JSONB        DEFAULT '[]',
  recommendation TEXT         DEFAULT '',
  calls_count    INTEGER      DEFAULT 1,
  created_at     TIMESTAMP    DEFAULT NOW(),
  updated_at     TIMESTAMP    DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calls (
  id             SERIAL PRIMARY KEY,
  phone          VARCHAR(50)  DEFAULT '',
  direction      VARCHAR(20)  DEFAULT 'outbound',
  duration       INTEGER      DEFAULT 0,
  transcript     TEXT         DEFAULT '',
  summary        TEXT         DEFAULT '',
  score          INTEGER,
  errors         JSONB        DEFAULT '[]',
  positives      JSONB        DEFAULT '[]',
  recommendation TEXT         DEFAULT '',
  saved          BOOLEAN      DEFAULT FALSE,
  contact_id     INTEGER      REFERENCES contacts(id) ON DELETE SET NULL,
  manager_id     INTEGER      REFERENCES managers(id) ON DELETE SET NULL,
  admin_comment  TEXT         DEFAULT '',
  audio_id       VARCHAR(255),
  created_at     TIMESTAMP    DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key   VARCHAR(100) PRIMARY KEY,
  value TEXT
);

-- Default seed data
INSERT INTO managers (name, avatar, color)
  VALUES ('Менеджер', 'МН', '#6366f1')
  ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value)
  VALUES ('violations_threshold', '5')
  ON CONFLICT DO NOTHING;
