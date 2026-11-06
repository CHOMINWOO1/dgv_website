(function (global) {
  "use strict";
  const MAX_AMOUNT = 999999999999;
  const DAY = 86400000;
  function money(value) {
    const number = Number(value);
    if (value === "" || !Number.isSafeInteger(number) || number < 0 || number > MAX_AMOUNT) {
      throw new Error("금액은 0 이상 999,999,999,999 이하의 정수로 입력해 주세요.");
    }
    return number;
  }
  function stay(checkIn, checkOut, weekendDays) {
    const start = Date.parse(checkIn + "T00:00:00Z");
    const end = Date.parse(checkOut + "T00:00:00Z");
    const nights = (end - start) / DAY;
    if (!Number.isInteger(nights) || nights < 1 || nights > 3660) {
      throw new Error("체크아웃은 체크인 이후로, 숙박 기간은 3,660박 이내로 입력해 주세요.");
    }
    let weekend = 0;
    for (let day = start; day < end; day += DAY) {
      if (weekendDays.includes(new Date(day).getUTCDay())) weekend++;
    }
    return { weekday: nights - weekend, weekend, nights };
  }
  function needsRates(previous, data) {
    return !previous || ["hotel_id", "check_in", "check_out", "room_count", "pricing_mode"]
      .some((key) => String(previous[key]) !== String(data[key]));
  }
  function price(data, hotel, previous) {
    const roomCount = Number(data.room_count);
    if (!Number.isInteger(roomCount) || roomCount < 1 || roomCount > 10000) {
      throw new Error("객실 수는 1~10,000개로 입력해 주세요.");
    }
    const rates = previous && !needsRates(previous, data) ? previous.rate_snapshot : hotel;
    const days = stay(data.check_in, data.check_out, rates?.weekend_days || []);
    let roomPurchase = money(data.room_purchase_amount);
    let roomSale = money(data.room_sale_amount);
    if (data.pricing_mode === "standard") {
      if (!rates) throw new Error("호텔을 선택해 주세요.");
      roomPurchase = money(roomCount * (days.weekday * rates.weekday_purchase + days.weekend * rates.weekend_purchase));
      roomSale = money(roomCount * (days.weekday * rates.weekday_sale + days.weekend * rates.weekend_sale));
    }
    const mealPurchase = data.includes_meals ? money(data.meal_purchase_amount) : 0;
    const mealSale = data.includes_meals ? money(data.meal_sale_amount) : 0;
    return { ...days, roomPurchase, roomSale, mealPurchase, mealSale,
      purchase: money(roomPurchase + mealPurchase), sale: money(roomSale + mealSale), rates };
  }
  global.HotelPricing = Object.freeze({ money, stay, needsRates, price });
})(typeof window === "object" ? window : globalThis);
