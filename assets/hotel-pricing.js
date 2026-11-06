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
    for (const value of [checkIn, checkOut]) {
      const parsed = new Date(value + "T00:00:00Z");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new Error("체크인·체크아웃 날짜를 확인해 주세요. / Kiểm tra ngày nhận và trả phòng.");
      }
    }
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
      .some((key) => String(previous[key]) !== String(data[key]))
      || selectionKey(previous.room_items) !== selectionKey(data.room_items);
  }
  function selectionKey(items) {
    if (items == null) return "legacy";
    if (!Array.isArray(items)) throw new Error("객실 내역을 확인해 주세요. / Kiểm tra danh sách phòng.");
    return JSON.stringify(items.map(item => [String(item.room_type_id || ""), Number(item.room_count), String(item.room_grade || "STANDARD")]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  function optionalMoney(value) {
    return value === null || value === undefined || value === "" ? null : money(value);
  }
  function price(data, hotel, previous, roomTypes = []) {
    if (data.room_items != null) return mixedPrice(data, hotel, previous, roomTypes);
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
  function mixedPrice(data, hotel, previous, roomTypes) {
    if (!hotel || String(hotel.id) !== String(data.hotel_id)) throw new Error("호텔을 선택해 주세요. / Chọn khách sạn.");
    if (!["standard","surcharge"].includes(data.pricing_mode)) throw new Error("요금 방식을 선택해 주세요. / Chọn loại giá.");
    if (!Array.isArray(data.room_items) || !data.room_items.length || data.room_items.length > 100) throw new Error("룸타입을 1~100행 추가해 주세요. / Thêm từ 1 đến 100 dòng loại phòng.");
    let roomCount = 0;
    data.room_items.forEach(item => {
      if (!item.room_type_id || !Number.isInteger(Number(item.room_count)) || Number(item.room_count) < 1 || Number(item.room_count) > 10000 || !["STANDARD","VIP"].includes(item.room_grade || "STANDARD")) throw new Error("룸타입·등급·객실 수를 확인해 주세요. / Kiểm tra loại, hạng và số phòng.");
      roomCount += Number(item.room_count);
    });
    if (roomCount > 10000) throw new Error("총 객실 수는 10,000개 이하여야 합니다. / Tổng số phòng không quá 10.000.");
    const normalized = {...data, room_count:roomCount};
    const preserve = previous && !needsRates(previous, normalized);
    const days = stay(data.check_in, data.check_out, preserve ? previous.rate_snapshot?.weekend_days || [] : hotel.weekend_days || []);
    let items;
    if (preserve) {
      items = previous.room_items.map(item => ({...item, rate_snapshot:{...item.rate_snapshot}}));
    } else {
      items = data.room_items.map(item => {
        const type = roomTypes.find(type => String(type.id) === String(item.room_type_id) && String(type.hotel_id) === String(hotel.id));
        if (!type || type.is_active === false) throw new Error("사용 가능한 룸타입을 선택해 주세요. / Chọn loại phòng đang hoạt động.");
        const rates = {weekend_days:[...(hotel.weekend_days || [])]};
        for (const key of ["weekday_purchase","weekday_sale","weekend_purchase","weekend_sale"]) rates[key] = money(type[key]);
        return {room_type_id:type.id, name:type.name, room_type_version:type.version,
          room_grade:item.room_grade || "STANDARD", room_count:Number(item.room_count), rate_snapshot:rates,
          weekday_nights:days.weekday, weekend_nights:days.weekend,
          room_purchase_amount:data.pricing_mode === "standard" ? money(Number(item.room_count) * (days.weekday*rates.weekday_purchase+days.weekend*rates.weekend_purchase)) : null,
          room_sale_amount:data.pricing_mode === "standard" ? money(Number(item.room_count) * (days.weekday*rates.weekday_sale+days.weekend*rates.weekend_sale)) : null};
      });
    }
    let roomPurchase = preserve ? money(previous.room_purchase_amount) : money(items.reduce((sum,item)=>sum+item.room_purchase_amount,0));
    let roomSale = preserve ? money(previous.room_sale_amount) : money(items.reduce((sum,item)=>sum+item.room_sale_amount,0));
    if (data.pricing_mode === "surcharge") {
      roomPurchase = money(data.room_purchase_amount);
      roomSale = money(data.room_sale_amount);
    }
    const mealPurchase = data.includes_meals ? money(data.meal_purchase_amount) : 0;
    const mealSale = data.includes_meals ? money(data.meal_sale_amount) : 0;
    return {...days, items, roomCount, rates:preserve ? previous.rate_snapshot : {weekend_days:hotel.weekend_days || []},
      roomPurchase,roomSale,mealPurchase,mealSale,purchase:money(roomPurchase+mealPurchase),sale:money(roomSale+mealSale)};
  }
  global.HotelPricing = Object.freeze({ money, optionalMoney, stay, needsRates, selectionKey, price });
})(typeof window === "object" ? window : globalThis);
