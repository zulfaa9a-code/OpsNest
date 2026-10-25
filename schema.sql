-- OpsNest FIS database tables. Safe to run many times (it only creates what is missing).

CREATE TABLE IF NOT EXISTS sites (
  id        SERIAL PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  location  TEXT NOT NULL,
  manager   TEXT NOT NULL DEFAULT '',
  budget    NUMERIC(18,3) NOT NULL DEFAULT 0,
  status    TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive'))
);

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('Management','Daily Ops Clerk','Revenue & Payroll Clerk')),
  status         TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
  sites          INT[] NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users (lower(username));

CREATE TABLE IF NOT EXISTS transactions (
  id          SERIAL PRIMARY KEY,
  tx_date     DATE NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('ops','rev','pay')),
  type        TEXT NOT NULL CHECK (type IN ('Expense','Revenue')),
  parent      TEXT NOT NULL,
  sub         TEXT NOT NULL,
  party       TEXT NOT NULL DEFAULT '',
  site_id     INT NOT NULL REFERENCES sites(id),
  user_id     INT NOT NULL REFERENCES users(id),
  doc         TEXT NOT NULL DEFAULT '',
  descr       TEXT NOT NULL DEFAULT '',
  net         NUMERIC(18,3) NOT NULL,
  rate        NUMERIC(6,2) NOT NULL DEFAULT 0,
  vat         NUMERIC(18,3) NOT NULL,
  gross       NUMERIC(18,3) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Cancelled')),
  grp         TEXT,
  entered     NUMERIC(18,3),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_tx_site_date ON transactions (site_id, tx_date);
CREATE INDEX IF NOT EXISTS ix_tx_kind ON transactions (kind, status);
-- An invoice number can be used only once among active revenue entries
CREATE UNIQUE INDEX IF NOT EXISTS uq_rev_doc ON transactions (lower(doc)) WHERE kind = 'rev' AND status = 'Active';
-- A payroll month can be active only once per site and category
CREATE UNIQUE INDEX IF NOT EXISTS uq_pay_day ON transactions (grp, tx_date) WHERE kind = 'pay' AND status = 'Active';

CREATE TABLE IF NOT EXISTS cancel_requests (
  id            SERIAL PRIMARY KEY,
  by_user       INT NOT NULL REFERENCES users(id),
  reason        TEXT NOT NULL,
  requested_on  DATE NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
  reviewed_by   INT REFERENCES users(id),
  reviewed_on   DATE,
  tx_ids        INT[] NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cr_status ON cancel_requests (status);
