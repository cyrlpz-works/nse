// The only file you need to touch to connect the site to your database.
// Copy both values from Supabase: Project Settings → API → Project URL and anon public.
// The anon key is safe to publish: row level security in supabase/schema.sql decides
// what an anonymous visitor may read or write, and the key cannot override it.
export const SUPABASE_URL = 'https://YOUR-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...your anon key...';
