# Vercel and Supabase deployment

1. In Supabase, run [`supabase-schema.sql`](./supabase-schema.sql) in the SQL Editor. This creates the private library data table and the `books`, `videos`, and `profile-photos` storage buckets.
2. Set these server-side environment variables in Vercel (and in `.env` for local runs):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY` (keep this secret; never expose it to browser code)
   - `JWT_SECRET` (use a random value of at least 32 characters)
   - `ADMIN_PASSWORD` (10–128 characters, used to create the first administrator)
   - `ADMIN_EMAIL` (optional; defaults to the existing administrator address)
3. Deploy the project. `vercel.json` sends requests to `api/index.js`; the site and API continue to share one origin.

Use Node.js 22 or newer for local runs and the Vercel function runtime. The backend reads and writes library records in Supabase for each API request. Uploads are stored in private Supabase Storage buckets and served through short-lived signed URLs. The Render disk and Cloudinary assets are not imported automatically; transfer existing data/files before switching production traffic.
