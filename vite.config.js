import { defineConfig } from "vite";

// Accepts the variable names set by Vercel's Supabase integration as well as our own VITE_ names.
// Only the project URL and the public (anon/publishable) key are ever put into the browser bundle.
const e = process.env;
const url = e.VITE_SUPABASE_URL || e.NEXT_PUBLIC_SUPABASE_URL || e.SUPABASE_URL || "";
const anon = e.VITE_SUPABASE_ANON_KEY || e.NEXT_PUBLIC_SUPABASE_ANON_KEY || e.SUPABASE_ANON_KEY ||
  e.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || e.SUPABASE_PUBLISHABLE_KEY || "";

export default defineConfig({
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(url),
    "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(anon),
  },
});
