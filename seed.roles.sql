-- PROPOSED role-search rows (source = himalayas). NOT applied. Needs migration 0007 first.
-- Each row is one query, polled in rotation with the company boards. board = 'query|scope':
--   IN = candidates in India, WORLDWIDE = open to anywhere, blank = any country.
--
-- Retire the three Adzuna software-engineer rows from 0005: their titles no longer pass the
-- role filter, and prod has no Adzuna keys so they only write errors.
UPDATE companies SET active = 0 WHERE source = 'adzuna';

INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: ai engineer (IN)', 'himalayas', 'ai engineer|IN', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: ai engineer (WORLDWIDE)', 'himalayas', 'ai engineer|WORLDWIDE', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: ai engineer (ALL)', 'himalayas', 'ai engineer|', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: machine learning engineer (IN)', 'himalayas', 'machine learning engineer|IN', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: machine learning engineer (WORLDWIDE)', 'himalayas', 'machine learning engineer|WORLDWIDE', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: machine learning engineer (ALL)', 'himalayas', 'machine learning engineer|', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: llm engineer (IN)', 'himalayas', 'llm engineer|IN', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: llm engineer (WORLDWIDE)', 'himalayas', 'llm engineer|WORLDWIDE', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: llm engineer (ALL)', 'himalayas', 'llm engineer|', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: forward deployed engineer (IN)', 'himalayas', 'forward deployed engineer|IN', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: forward deployed engineer (WORLDWIDE)', 'himalayas', 'forward deployed engineer|WORLDWIDE', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: forward deployed engineer (ALL)', 'himalayas', 'forward deployed engineer|', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: ai engineer intern (IN)', 'himalayas', 'ai engineer intern|IN', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: ai engineer intern (WORLDWIDE)', 'himalayas', 'ai engineer intern|WORLDWIDE', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Himalayas: ai engineer intern (ALL)', 'himalayas', 'ai engineer intern|', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
