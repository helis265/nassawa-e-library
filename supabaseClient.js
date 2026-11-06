"use strict";

require("dotenv").config({ path: require("node:path").join(__dirname, ".env") });
const { createClient } = require("@supabase/supabase-js");

let client;

function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.");
  }

  if (!client) client = createClient(supabaseUrl, supabaseServiceKey);
  return client;
}

module.exports = getSupabaseClient;
