-- NOT FOR SUPABASE. This is the app.* schema for the abandoned Qoder Sites Edge
-- Function in this directory; it does not run on a Supabase project (there is no
-- "app" schema there). The live schema is ../supabase/schema.sql.
CREATE TABLE app.posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id text NOT NULL,
  author text NOT NULL,
  rank text NOT NULL,
  category text NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_created_at_idx ON app.posts (created_at);
CREATE INDEX posts_visitor_idx ON app.posts (visitor_id);
CREATE INDEX posts_status_idx ON app.posts (status);

CREATE TABLE app.comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  visitor_id text NOT NULL,
  author text NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_post_idx ON app.comments (post_id);
CREATE INDEX comments_status_idx ON app.comments (status);

CREATE TABLE app.likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  visitor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX likes_post_idx ON app.likes (post_id);
CREATE INDEX likes_visitor_idx ON app.likes (visitor_id);

CREATE TABLE app.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  logo text NOT NULL,
  description text NOT NULL DEFAULT '',
  game_mode text NOT NULL,
  region text NOT NULL,
  required_rank text NOT NULL,
  status text NOT NULL,
  leader text NOT NULL,
  founder_id text NOT NULL,
  slot_count integer NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX teams_created_at_idx ON app.teams (created_at);

CREATE TABLE app.join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  visitor_id text NOT NULL,
  nickname text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX join_requests_team_idx ON app.join_requests (team_id);
