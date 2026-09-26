-- Cover the menu-item foreign key used by QR order history and menu changes.
-- Additive only; no existing rows or prices are modified.

create index if not exists qr_order_items_menu_item_id_idx
  on public.qr_order_items (menu_item_id);
