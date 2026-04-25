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

-- ─── Licensing ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS license_plans (
  name                VARCHAR(50)  PRIMARY KEY,
  display_name        VARCHAR(100) DEFAULT '',
  max_devices         INTEGER      DEFAULT 1,   -- -1 = unlimited
  requests_per_month  INTEGER      DEFAULT 100, -- -1 = unlimited
  description         TEXT         DEFAULT ''
);

INSERT INTO license_plans (name, display_name, max_devices, requests_per_month, description) VALUES
  ('unlimited', 'Безлимитный', -1, -1, 'Неограниченные устройства и запросы')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS licenses (
  key                 VARCHAR(64)  PRIMARY KEY,
  customer            VARCHAR(255) DEFAULT '',
  plan                VARCHAR(50)  DEFAULT 'basic',
  max_devices         INTEGER      DEFAULT 1,   -- -1 = unlimited
  requests_per_month  INTEGER      DEFAULT 100, -- -1 = unlimited
  expires_at          TIMESTAMP,
  is_active           BOOLEAN      DEFAULT TRUE,
  created_at          TIMESTAMP    DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS license_devices (
  id           SERIAL    PRIMARY KEY,
  license_key  VARCHAR(64) REFERENCES licenses(key) ON DELETE CASCADE,
  device_id    VARCHAR(255) NOT NULL,
  first_seen   TIMESTAMP DEFAULT NOW(),
  last_seen    TIMESTAMP DEFAULT NOW(),
  UNIQUE(license_key, device_id)
);

CREATE TABLE IF NOT EXISTS license_usage (
  id           SERIAL    PRIMARY KEY,
  license_key  VARCHAR(64) REFERENCES licenses(key) ON DELETE CASCADE,
  device_id    VARCHAR(255) DEFAULT 'unknown',
  month        CHAR(7)   NOT NULL,   -- YYYY-MM
  requests     INTEGER   DEFAULT 0,
  UNIQUE(license_key, month)
);

CREATE TABLE IF NOT EXISTS website_users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) UNIQUE NOT NULL,
  name          VARCHAR(255) DEFAULT '',
  password_hash VARCHAR(64)  NOT NULL,
  license_key   VARCHAR(64)  UNIQUE REFERENCES licenses(key),
  calls_analyzed INTEGER     DEFAULT 0,
  last_login    TIMESTAMP,
  created_at    TIMESTAMP    DEFAULT NOW(),
  is_active     BOOLEAN      DEFAULT TRUE
);

-- Default seed data
INSERT INTO managers (name, avatar, color)
  VALUES ('Менеджер', 'МН', '#6366f1')
  ON CONFLICT DO NOTHING;

INSERT INTO settings (key, value)
  VALUES ('violations_threshold', '5')
  ON CONFLICT DO NOTHING;
