(function initReservationSalesVisibility(global) {
  "use strict";

  function buildExcludedOrderIdSet(rows) {
    const source = Array.isArray(rows) ? rows : [];
    return new Set(
      source
        .map((row) => String(row?.id ?? "").trim())
        .filter(Boolean)
    );
  }

  function applySalesExcludedVisibility(rows, excludedOrderIds, includeExcluded) {
    const source = Array.isArray(rows) ? rows : [];
    const excludedIds = excludedOrderIds instanceof Set ? excludedOrderIds : new Set();

    return source.reduce((visibleRows, row) => {
      const linkedOrderId = row?.confirmed_order_id;
      const salesExcluded = linkedOrderId !== null
        && linkedOrderId !== undefined
        && String(linkedOrderId).trim() !== ""
        && excludedIds.has(String(linkedOrderId));

      if(!includeExcluded && salesExcluded) return visibleRows;
      visibleRows.push({ ...row, sales_excluded: salesExcluded });
      return visibleRows;
    }, []);
  }

  global.DGV_RESERVATION_VISIBILITY = Object.freeze({
    buildExcludedOrderIdSet,
    applySalesExcludedVisibility
  });
})(typeof window === "object" ? window : globalThis);
