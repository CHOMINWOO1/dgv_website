/*
 * Environment-specific public configuration.
 *
 * This is the only file that should change when promoting the static site to a
 * different Supabase project. A publishable key is safe to ship to browsers;
 * authorization must still be enforced by RLS and the app_* RPC functions.
 */
window.DGV_SUPABASE_CONFIG = Object.freeze({
  url: "https://fbbecxtxsaplrmanjunw.supabase.co",
  publishableKey: "sb_publishable_kvhurEnExMnJxTiaqBLnOA_p2bcCuxx",
  authAccounts: Object.freeze({
    staff: "staff@dgv.local",
    admin: "admin@dgv.local"
  })
});
