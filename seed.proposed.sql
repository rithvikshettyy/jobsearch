-- PROPOSED additions, verified live on 2026-10-27 (each board returned HTTP 200 and >0 openings).
-- NOT applied. Review, delete lines you do not want, then:
--   npx wrangler d1 execute job-bot-db --remote --file=seed.proposed.sql --yes

INSERT INTO companies (name, source, board, active) VALUES ('Razorpay', 'greenhouse', 'razorpaysoftwareprivatelimited', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Navi', 'ashby', 'navi', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Mindtickle', 'lever', 'mindtickle', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Sarvam AI', 'ashby', 'sarvam', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Hevo Data', 'lever', 'hevodata', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Fampay', 'lever', 'fampay', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Zeta', 'lever', 'zeta', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Rubrik', 'greenhouse', 'rubrik', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Sumo Logic', 'greenhouse', 'sumologic', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Okta', 'greenhouse', 'okta', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Zscaler', 'greenhouse', 'zscaler', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Snyk', 'ashby', 'snyk', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Amplitude', 'ashby', 'amplitude', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Airbnb', 'greenhouse', 'airbnb', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Coinbase', 'greenhouse', 'coinbase', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;

-- AI-native additions, verified live on 2026-10-28 (HTTP 200, >0 openings, matching titles, small payloads).
INSERT INTO companies (name, source, board, active) VALUES ('Anthropic', 'greenhouse', 'anthropic', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Scale AI', 'greenhouse', 'scaleai', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Glean', 'greenhouse', 'gleanwork', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Perplexity', 'ashby', 'perplexity', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Cohere', 'ashby', 'cohere', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Cursor', 'ashby', 'cursor', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('ElevenLabs', 'ashby', 'elevenlabs', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Pinecone', 'ashby', 'pinecone', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Writer', 'ashby', 'writer', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Together AI', 'greenhouse', 'togetherai', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Fireworks AI', 'ashby', 'fireworks', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Replit', 'ashby', 'replit', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Cognition', 'ashby', 'cognition', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Cerebras', 'ashby', 'cerebras', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Modal', 'ashby', 'modal', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Baseten', 'ashby', 'baseten', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Cresta', 'greenhouse', 'cresta', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Mercor', 'ashby', 'mercor', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Turing', 'greenhouse', 'turing', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
INSERT INTO companies (name, source, board, active) VALUES ('Invisible Technologies', 'greenhouse', 'invisibletech', 1)
  ON CONFLICT (name) DO UPDATE SET source = excluded.source, board = excluded.board, active = 1;
