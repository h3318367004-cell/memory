const { createClient } = require("@supabase/supabase-js");
const { readConfig } = require("./config");

function createSupabaseMemoryClient(config = readConfig()) {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

module.exports = {
  createSupabaseMemoryClient,
};
