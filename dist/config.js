// The only file you need to touch to connect the site to your database.
// Copy both values from Supabase: Project Settings → API → Project URL and anon public.
// The anon key is safe to publish: row level security in supabase/schema.sql decides
// what an anonymous visitor may read or write, and the key cannot override it.
//
// Put the real strings between the quotes — not a sample. The Project URL is
// https://<your-project-ref>.supabase.co and the key is the one labelled "anon public"
// (it may start with sb_publishable_ on a new project, or eyJ... on an older one).
// Anything else is treated as "not connected yet".
export const SUPABASE_URL = 'https://bqsemwjnmmvshlabyerf.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_RydLRXKDnuHcygmVbKWxPw_u5hNFbhN';
