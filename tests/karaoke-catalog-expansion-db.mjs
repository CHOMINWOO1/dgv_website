// Full-cycle/space-insensitive search upgrade contract, offline PostgreSQL only.
process.env.CATALOG_EXPANSION_MIGRATION='20261108092612_karaoke_catalog_space_search_refresh_scale.sql';
process.env.CATALOG_REFRESH_DUE_MIGRATION='20261108095756_karaoke_catalog_oldest_metadata_due.sql';
await import('./karaoke-catalog-db.mjs');
