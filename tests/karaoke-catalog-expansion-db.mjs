// Full-cycle/space-insensitive search upgrade contract, offline PostgreSQL only.
process.env.CATALOG_EXPANSION_MIGRATION='20261108092612_karaoke_catalog_space_search_refresh_scale.sql';
await import('./karaoke-catalog-db.mjs');
