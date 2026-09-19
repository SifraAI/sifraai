# Supabase setup

1. Create a Supabase project.
2. Run `supabase/migrations/20260919000001_auth_and_chat_persistence.sql` in the Supabase SQL editor (or apply it with the Supabase CLI).
3. Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `.env` locally and to the Vercel project's environment variables for Production, Preview, and Development.
4. In Supabase Authentication, enable Email and Google.
5. In the Google provider settings, use the callback URL shown by Supabase. In **Authentication → URL Configuration**, set the production Site URL and add local/preview URLs to Redirect URLs.
6. Redeploy Vercel after adding the environment variables.

The browser receives only the anon key. Row Level Security restricts profiles, conversations, messages, and private Storage objects to the signed-in user's UUID. The API independently validates the access token against Supabase before accepting a chat request.

Temporary chats require a signed-in user but intentionally skip all database and Storage writes.
