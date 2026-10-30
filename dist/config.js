// The only file you need to touch to connect the site to your database.
// Copy both values from Supabase: Project Settings → API → Project URL and anon public.
// The anon key is safe to publish: row level security in supabase/schema.sql decides
// what an anonymous visitor may read or write, and the key cannot override it.
//
// Put the real strings between the quotes — not a sample. The Project URL is
// https://<twenty lowercase characters>.supabase.co and the anon public key is a long
// eyJ... token with exactly two dots. Anything else is treated as "not connected yet".
export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';
