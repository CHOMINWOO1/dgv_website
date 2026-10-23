(function (root, factory) {
  const api = factory();
  root.DGV_TAX_REPORT = api;
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const RATE_FOOD = 8;
  const RATE_BEVERAGE = 10;
  const BEVERAGE_CATEGORY_VALUES = new Set(["drink", "cafe", "beverage", "alcohol", "beer", "liquor"]);
  const GROUP_DEFINITIONS = [
    { key: "food8", rate: RATE_FOOD, labelKo: "식당", labelVi: "Món ăn" },
    { key: "drink10", rate: RATE_BEVERAGE, labelKo: "음료·주류", labelVi: "Đồ uống / Rượu bia" }
  ];

  function cleanText(value) {
    return String(value == null ? "" : value).trim();
  }

  function normalizeText(value) {
    return cleanText(value)
      .toLocaleLowerCase("en")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .normalize("NFC")
      .replace(/đ/g, "d")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function integerVnd(value) {
    return Math.round(finiteNumber(value, 0));
  }

  function lineQuantity(line) {
    const quantity = finiteNumber(line && line.qty, 0);
    return quantity > 0 ? quantity : 0;
  }

  function lineGrossVnd(line) {
    if (line && line.line_vnd !== null && line.line_vnd !== undefined && Number.isFinite(Number(line.line_vnd))) {
      return integerVnd(line.line_vnd);
    }
    return integerVnd(finiteNumber(line && line.unit_vnd, 0) * lineQuantity(line));
  }

  function isCustomLine(line) {
    return Boolean(line && (line.is_custom || line.line_source === "order_custom_items"));
  }

  function isSurchargeLine(line) {
    const kind = normalizeText(line && line.kind).replace(/\s+/g, "_");
    if (["fee7", "card_fee", "card_surcharge", "payment_surcharge"].includes(kind)) return true;
    const names = normalizeText(`${cleanText(line && line.ko_name)} ${cleanText(line && line.vi_name)}`);
    return /(?:카드.*(?:수수료|7\s*%)|(?:card|the).*surcharge|phu phi.*(?:the|thanh toan))/.test(names);
  }

  function hasBeverageKeyword(line) {
    const text = normalizeText(`${cleanText(line && line.ko_name)} ${cleanText(line && line.vi_name)} ${cleanText(line && line.en_name)}`);
    return [
      "맥주", "소주", "막걸리", "와인", "보드카", "보드카맨", "위스키", "하이볼", "칵테일",
      "넵머이", "넵 모이", "넷머이", "음료", "커피", "카페", " 차 ", "주스", "쥬스", "스무디",
      "콜라", "사이다", "생수", " 물 ", "콜키지",
      " bia ", " ruou ", " nep moi ", " nuoc ngot ", " nuoc ep ", " sinh to ", " ca phe ",
      " coffee ", " cafe ", " beer ", " soju ", " wine ", " vodka ", " whisky ", " whiskey ",
      " cocktail ", " mocktail ", " juice ", " smoothie ", " tea ", " cola ", " coke ", " pepsi ",
      " sprite ", " soda ", " water ", " corkage "
    ].some((keyword) => (` ${text} `).includes(keyword));
  }

  function classifyLine(line) {
    if (isSurchargeLine(line)) {
      return {
        isSurcharge: true,
        rate: null,
        groupKey: null,
        reviewNeeded: false,
        reviewReason: "",
        classificationSource: "card-surcharge"
      };
    }

    const kind = normalizeText(line && line.kind);
    const type = normalizeText(line && (line.type || (!isCustomLine(line) ? line.kind : "")));
    const qrCategory = normalizeText(line && line.qr_category);
    const beverageByCategory = [kind, type, qrCategory].some((value) => BEVERAGE_CATEGORY_VALUES.has(value));

    if (!isCustomLine(line)) {
      const beverageByName = qrCategory !== "combo" && hasBeverageKeyword(line);
      const rate = beverageByCategory || beverageByName ? RATE_BEVERAGE : RATE_FOOD;
      return {
        isSurcharge: false,
        rate,
        groupKey: rate === RATE_BEVERAGE ? "drink10" : "food8",
        reviewNeeded: false,
        reviewReason: "",
        classificationSource: beverageByCategory
          ? "menu-category"
          : (beverageByName ? "menu-beverage-keyword" : "menu-default-food")
      };
    }

    if (BEVERAGE_CATEGORY_VALUES.has(kind)) {
      return {
        isSurcharge: false,
        rate: RATE_BEVERAGE,
        groupKey: "drink10",
        reviewNeeded: false,
        reviewReason: "",
        classificationSource: "custom-kind"
      };
    }

    if (kind === "special") {
      if (hasBeverageKeyword(line)) {
        return {
          isSurcharge: false,
          rate: RATE_BEVERAGE,
          groupKey: "drink10",
          reviewNeeded: false,
          reviewReason: "",
          classificationSource: "special-beverage-keyword"
        };
      }
      return {
        isSurcharge: false,
        rate: RATE_FOOD,
        groupKey: "food8",
        reviewNeeded: true,
        reviewReason: "SPECIAL 항목의 세율 분류를 확인해 주세요.",
        classificationSource: "special-default-food"
      };
    }

    const beverageByName = hasBeverageKeyword(line);
    return {
      isSurcharge: false,
      rate: beverageByCategory || beverageByName ? RATE_BEVERAGE : RATE_FOOD,
      groupKey: beverageByCategory || beverageByName ? "drink10" : "food8",
      reviewNeeded: false,
      reviewReason: "",
      classificationSource: beverageByCategory
        ? "custom-category"
        : (beverageByName ? "custom-beverage-keyword" : "custom-default-food")
    };
  }

  function inferVietnameseUnit(line, classification, isAdjustment) {
    if (isAdjustment) return "Khoản";
    const kind = normalizeText(line && line.kind);
    const type = normalizeText(line && (line.type || (!isCustomLine(line) ? line.kind : "")));
    const qrCategory = normalizeText(line && line.qr_category);
    const text = normalizeText(`${cleanText(line && line.ko_name)} ${cleanText(line && line.vi_name)} ${cleanText(line && line.en_name)}`);
    const padded = ` ${text} `;

    if ([kind, type, qrCategory].includes("cafe") || [
      "커피", "카페", " 차 ", "주스", "쥬스", "스무디", " ca phe ", " coffee ", " cafe ",
      " tea ", " nuoc ep ", " juice ", " sinh to ", " smoothie ", " cocktail ", " mocktail "
    ].some((keyword) => padded.includes(keyword))) {
      return "Ly";
    }
    if ([
      "맥주", "음료", "콜라", "사이다", " bia ", " beer ", " nuoc ngot ", " soft drink ",
      " cola ", " coke ", " pepsi ", " sprite ", " soda ", " can ", "캔"
    ].some((keyword) => padded.includes(keyword))) {
      return "Lon";
    }
    if ([
      "소주", "와인", "보드카", "넵머이", "넷머이", "콜키지", " ruou ", " nep moi ", " soju ",
      " wine ", " vodka ", " whisky ", " whiskey ", " corkage ", " bottle ", " 병 "
    ].some((keyword) => padded.includes(keyword))) {
      return "Chai";
    }
    return classification && classification.rate === RATE_BEVERAGE ? "Chai" : "Phần";
  }

  function allocateInteger(amount, weights) {
    const target = integerVnd(amount);
    const entries = Object.entries(weights || {})
      .map(([key, value]) => [key, Math.abs(finiteNumber(value, 0))])
      .filter((entry) => entry[1] > 0);
    if (!target) return {};
    if (!entries.length) return { food8: target };

    const sign = target < 0 ? -1 : 1;
    const absoluteTarget = Math.abs(target);
    const totalWeight = entries.reduce((sum, entry) => sum + entry[1], 0);
    const shares = entries.map(([key, weight], index) => {
      const exact = absoluteTarget * weight / totalWeight;
      const floor = Math.floor(exact);
      return { key, index, value: floor, fraction: exact - floor };
    });
    let remainder = absoluteTarget - shares.reduce((sum, share) => sum + share.value, 0);
    shares
      .slice()
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
      .forEach((share) => {
        if (remainder > 0) {
          share.value += 1;
          remainder -= 1;
        }
      });
    return Object.fromEntries(shares.map((share) => [share.key, share.value * sign]));
  }

  function sourceLinesForOrder(source, orderId) {
    const key = String(orderId == null ? "" : orderId);
    const indexed = source && source.linesByOrder;
    if (indexed instanceof Map) return indexed.get(key) || indexed.get(orderId) || [];
    if (indexed && typeof indexed === "object") return indexed[key] || [];
    const lines = Array.isArray(source && source.visibleLines)
      ? source.visibleLines
      : (Array.isArray(source && source.lines) ? source.lines : []);
    return lines.filter((line) => String(line && line.order_id) === key);
  }

  function makeEntry(line, classification, grossAmount, warnings) {
    let qty = lineQuantity(line);
    if (!qty) {
      qty = 1;
      if (grossAmount) warnings.add(`수량이 없는 항목 '${cleanText(line && line.ko_name) || cleanText(line && line.vi_name) || "이름 없음"}'을 1개로 처리했습니다.`);
    }
    const suppliedUnit = Number(line && line.unit_vnd);
    const grossUnit = Number.isFinite(suppliedUnit)
      ? integerVnd(suppliedUnit)
      : integerVnd(grossAmount / qty);
    return {
      rate: classification.rate,
      groupKey: classification.groupKey,
      koName: cleanText(line && line.ko_name) || cleanText(line && line.vi_name) || "메뉴명 없음",
      viName: cleanText(line && line.vi_name) || cleanText(line && line.ko_name) || "Chưa có tên",
      unitVi: inferVietnameseUnit(line, classification, false),
      qty,
      grossUnit,
      grossAmount: integerVnd(grossAmount),
      reviewNeeded: Boolean(classification.reviewNeeded),
      reviewReason: cleanText(classification.reviewReason),
      classificationSource: classification.classificationSource
    };
  }

  function makeAdjustmentEntry(groupKey, amount, options) {
    const definition = GROUP_DEFINITIONS.find((item) => item.key === groupKey) || GROUP_DEFINITIONS[0];
    return {
      rate: definition.rate,
      groupKey: definition.key,
      koName: options.koName,
      viName: options.viName,
      unitVi: "Khoản",
      qty: 1,
      grossUnit: integerVnd(amount),
      grossAmount: integerVnd(amount),
      reviewNeeded: Boolean(options.reviewNeeded),
      reviewReason: cleanText(options.reviewReason),
      classificationSource: options.classificationSource
    };
  }

  function aggregateEntries(entries) {
    const maps = new Map(GROUP_DEFINITIONS.map((definition) => [definition.key, new Map()]));
    entries.forEach((entry) => {
      const map = maps.get(entry.groupKey) || maps.get("food8");
      const key = JSON.stringify([entry.koName, entry.viName, entry.rate, entry.grossUnit, entry.unitVi]);
      const current = map.get(key) || {
        koName: entry.koName,
        viName: entry.viName,
        unitVi: entry.unitVi,
        qty: 0,
        grossUnit: entry.grossUnit,
        grossAmount: 0,
        rate: entry.rate,
        reviewNeeded: false,
        reviewReason: "",
        classificationSource: entry.classificationSource
      };
      current.qty += entry.qty;
      current.grossAmount += entry.grossAmount;
      current.reviewNeeded = current.reviewNeeded || entry.reviewNeeded;
      if (entry.reviewReason && !current.reviewReason.split(" / ").includes(entry.reviewReason)) {
        current.reviewReason = current.reviewReason ? `${current.reviewReason} / ${entry.reviewReason}` : entry.reviewReason;
      }
      map.set(key, current);
    });

    return GROUP_DEFINITIONS.map((definition) => {
      const rows = Array.from(maps.get(definition.key).values())
        .map((row) => {
          const rawNetLine = Math.round(row.grossAmount * 100 / (100 + definition.rate));
          const netUnit = row.qty ? Math.floor(rawNetLine / row.qty) : rawNetLine;
          const netAmount = integerVnd(netUnit * row.qty);
          return {
            ...row,
            rate: definition.rate,
            netUnit,
            netAmount,
            vatAmount: row.grossAmount - netAmount
          };
        })
        .sort((a, b) => a.koName.localeCompare(b.koName, "ko") || a.grossUnit - b.grossUnit);
      return {
        ...definition,
        rows,
        netAmount: rows.reduce((sum, row) => sum + row.netAmount, 0),
        vatAmount: rows.reduce((sum, row) => sum + row.vatAmount, 0),
        grossAmount: rows.reduce((sum, row) => sum + row.grossAmount, 0)
      };
    });
  }

  /**
   * Build an audit-friendly, tax-inclusive sales summary without changing source data.
   * Input matches admin.html's loadRangeReportData():
   * { visibleOrders, linesByOrder } (visibleLines is also accepted as a fallback).
   */
  function buildReport(sourceReport) {
    const source = sourceReport || {};
    const orders = Array.isArray(source.visibleOrders)
      ? source.visibleOrders
      : (Array.isArray(source.orders) ? source.orders : []);
    const paidOrders = orders.filter((order) => normalizeText(order && order.status) === "paid");
    const warnings = new Set();
    const entries = [];
    let paidOrderGross = 0;
    let lineGross = 0;

    paidOrders.forEach((order) => {
      const orderId = cleanText(order && order.id) || "ID 없음";
      const orderGross = integerVnd(order && order.total_vnd);
      paidOrderGross += orderGross;
      const lines = sourceLinesForOrder(source, order && order.id);
      const baseEntries = [];
      const weights = { food8: 0, drink10: 0 };
      let orderLineGross = 0;
      let surchargeGross = 0;

      lines.forEach((line) => {
        const gross = lineGrossVnd(line);
        orderLineGross += gross;
        const classification = classifyLine(line);
        if (classification.isSurcharge) {
          surchargeGross += gross;
          return;
        }
        const entry = makeEntry(line, classification, gross, warnings);
        baseEntries.push(entry);
        weights[entry.groupKey] += Math.abs(gross);
      });
      lineGross += orderLineGross;
      entries.push(...baseEntries);

      if (surchargeGross) {
        const noBase = !weights.food8 && !weights.drink10;
        const allocations = allocateInteger(surchargeGross, weights);
        Object.entries(allocations).forEach(([groupKey, amount]) => {
          if (!amount) return;
          entries.push(makeAdjustmentEntry(groupKey, amount, {
            koName: "카드 결제 수수료",
            viName: "Phụ phí thanh toán thẻ",
            reviewNeeded: noBase,
            reviewReason: noBase ? "기준 메뉴가 없어 식당 8%로 임시 분류했습니다." : "",
            classificationSource: "allocated-explicit-card-surcharge"
          }));
        });
        if (noBase) warnings.add(`주문 ${orderId}: 카드 수수료의 배분 기준 메뉴가 없어 8%로 임시 분류했습니다.`);
      }

      const difference = orderGross - orderLineGross;
      if (difference) {
        const paymentMethod = normalizeText(order && order.payment_method);
        const isLegacyCardSurcharge = paymentMethod === "card" && difference > 0;
        const noBase = !weights.food8 && !weights.drink10;
        const allocations = allocateInteger(difference, weights);
        Object.entries(allocations).forEach(([groupKey, amount]) => {
          if (!amount) return;
          entries.push(makeAdjustmentEntry(groupKey, amount, {
            koName: isLegacyCardSurcharge ? "카드 결제 수수료" : "상세 조정액",
            viName: isLegacyCardSurcharge ? "Phụ phí thanh toán thẻ" : "Điều chỉnh doanh thu",
            reviewNeeded: !isLegacyCardSurcharge || noBase,
            reviewReason: noBase
              ? "상세 메뉴가 없어 식당 8%로 임시 분류했습니다."
              : (!isLegacyCardSurcharge ? "주문 합계와 상세 항목 합계의 차이를 확인해 주세요." : ""),
            classificationSource: isLegacyCardSurcharge ? "allocated-legacy-card-surcharge" : "allocated-order-difference"
          }));
        });
        warnings.add(`주문 ${orderId}: 주문 합계와 상세 항목 합계의 차이 ${difference.toLocaleString("ko-KR")} VND를 조정 행으로 반영했습니다.`);
      }
    });

    let groups = aggregateEntries(entries);
    let groupedGross = groups.reduce((sum, group) => sum + group.grossAmount, 0);
    const safetyDifference = paidOrderGross - groupedGross;
    if (safetyDifference) {
      warnings.add(`전체 합계 차이 ${safetyDifference.toLocaleString("ko-KR")} VND를 8% 조정 행으로 반영했습니다.`);
      entries.push(makeAdjustmentEntry("food8", safetyDifference, {
        koName: "전체 합계 조정",
        viName: "Điều chỉnh tổng doanh thu",
        reviewNeeded: true,
        reviewReason: "전체 합계 조정액의 세율을 확인해 주세요.",
        classificationSource: "global-reconciliation"
      }));
      groups = aggregateEntries(entries);
      groupedGross = groups.reduce((sum, group) => sum + group.grossAmount, 0);
    }

    const reviewRows = groups.flatMap((group) => group.rows
      .filter((row) => row.reviewNeeded)
      .map((row) => ({ ...row, groupKey: group.key })));
    reviewRows.forEach((row) => {
      if (row.reviewReason) warnings.add(`${row.koName}: ${row.reviewReason}`);
    });

    return {
      groups,
      paidOrderCount: paidOrders.length,
      paidOrderGross,
      lineGross,
      reconciliationDifference: paidOrderGross - groupedGross,
      warnings: Array.from(warnings),
      reviewRows
    };
  }

  return Object.freeze({
    RATE_FOOD,
    RATE_BEVERAGE,
    normalizeText,
    classifyLine,
    inferVietnameseUnit,
    allocateInteger,
    buildReport
  });
});


