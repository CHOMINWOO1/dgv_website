(function initDgvDataUtilities(global) {
  "use strict";

  const DEFAULT_PAGE_SIZE = 1000;

  function validDate(value) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("Invalid date");
    return date;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function formatLocalYmd(value) {
    const date = validDate(value);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function formatYmdInTimeZone(value, timeZone) {
    const date = validDate(value);
    if (!timeZone) throw new TypeError("timeZone is required");
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function normalizeOrder(order) {
    if (!Array.isArray(order) || order.length === 0) {
      throw new TypeError("A stable order is required for pagination");
    }
    return order.map((item) => {
      const spec = typeof item === "string" ? { column: item } : { ...item };
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(spec.column || ""))) {
        throw new TypeError("Pagination order contains an invalid column");
      }
      return {
        column: spec.column,
        ascending: spec.ascending !== false,
        nullsFirst: spec.nullsFirst,
        referencedTable: spec.referencedTable
      };
    });
  }

  function isPastEndError(error, status, offset) {
    if (offset === 0) return false;
    return status === 416 || error?.code === "PGRST103";
  }

  async function collectSupabasePages(queryFactory, options = {}) {
    if (typeof queryFactory !== "function") {
      throw new TypeError("queryFactory must be a function");
    }
    const order = normalizeOrder(options.order);
    const pageSize = Number(options.pageSize || DEFAULT_PAGE_SIZE);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      throw new TypeError("pageSize must be between 1 and 1000");
    }

    const rows = [];
    let offset = 0;
    while (true) {
      let query = queryFactory();
      for (const spec of order) {
        query = query.order(spec.column, {
          ascending: spec.ascending,
          nullsFirst: spec.nullsFirst,
          referencedTable: spec.referencedTable
        });
      }
      const result = await query.range(offset, offset + pageSize - 1);
      if (result.error) {
        if (isPastEndError(result.error, result.status, offset)) break;
        throw result.error;
      }
      const page = Array.isArray(result.data) ? result.data : [];
      if (page.length === 0) break;
      rows.push(...page);
      offset += page.length;
      if (Number.isInteger(result.count) && offset >= result.count) break;
    }
    return rows;
  }

  function rawOrderValue(order) {
    return normalizeOrder(order).map((spec) => {
      const direction = spec.ascending ? "asc" : "desc";
      const nulls = spec.nullsFirst === true
        ? ".nullsfirst"
        : spec.nullsFirst === false
        ? ".nullslast"
        : "";
      return `${spec.column}.${direction}${nulls}`;
    }).join(",");
  }

  function contentRangeTotal(value) {
    const match = String(value || "").match(/\/(\d+)$/);
    return match ? Number(match[1]) : null;
  }

  async function collectRestPages(rawUrl, options = {}) {
    const pageSize = Number(options.pageSize || DEFAULT_PAGE_SIZE);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
      throw new TypeError("pageSize must be between 1 and 1000");
    }
    const url = new URL(rawUrl, global.location?.href);
    url.searchParams.set("order", rawOrderValue(options.order));
    const fetcher = options.fetcher || global.fetch?.bind(global);
    if (typeof fetcher !== "function") throw new TypeError("fetch is unavailable");

    const rows = [];
    let offset = 0;
    while (true) {
      const suppliedHeaders = typeof options.headers === "function"
        ? await options.headers()
        : await options.headers;
      const headers = {
        ...(suppliedHeaders || {}),
        Range: `${offset}-${offset + pageSize - 1}`,
        "Range-Unit": "items",
        Prefer: "count=exact"
      };
      const response = await fetcher(url.toString(), { headers });
      if (response.status === 416 && offset > 0) break;
      const text = await response.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : [];
      } catch {
        json = null;
      }
      if (!response.ok) {
        const message = json?.message || json?.error || text || `HTTP ${response.status}`;
        throw new Error(message);
      }
      const page = Array.isArray(json) ? json : [];
      if (page.length === 0) break;
      rows.push(...page);
      offset += page.length;
      const total = contentRangeTotal(response.headers?.get?.("content-range"));
      if (Number.isInteger(total) && offset >= total) break;
    }
    return rows;
  }

  global.DGV_DATA_UTILS = Object.freeze({
    formatLocalYmd,
    formatYmdInTimeZone,
    collectSupabasePages,
    collectRestPages
  });
})(typeof window === "object" ? window : globalThis);
