/* /assets/i18n.js */
(function(){
  const common = {
    ko:{
      "page-title":"DGV Company Limited",
      "brand-sub":"달랏 골프 바우처",
      "hero-sub":"골프 · 호텔 · 차량 · 한식당 전문 서비스",
      "nav-home":"Home","nav-restaurant":"식당 예약","nav-golf":"골프 예약","nav-hotel":"호텔 예약","nav-package":"패키지","nav-car":"차량 예약","nav-contact":"문의"
    },
    en:{
      "page-title":"DGV Company Limited",
      "brand-sub":"Da Lat Golf Voucher",
      "hero-sub":"Professional Golf · Hotel · Car · Korean Restaurant Services",
      "nav-home":"Home","nav-restaurant":"Restaurant","nav-golf":"Golf","nav-hotel":"Hotel","nav-package":"Package","nav-car":"Car","nav-contact":"Contact"
    },
    vi:{
      "page-title":"DGV Company Limited",
      "brand-sub":"Phiếu Golf Đà Lạt",
      "hero-sub":"Dịch vụ: Golf · Khách sạn · Xe đưa đón · Nhà hàng Hàn Quốc",
      "nav-home":"Trang chủ","nav-restaurant":"Nhà hàng Hàn Quốc","nav-golf":"Sân golf","nav-hotel":"Khách sạn","nav-package":"Gói","nav-car":"Xe đưa đón","nav-contact":"Liên hệ"
    }
  };

  function deepMerge(base, extra){
    const out = JSON.parse(JSON.stringify(base));
    for(const lang of Object.keys(extra||{})){
      out[lang] = Object.assign({}, out[lang]||{}, extra[lang]||{});
    }
    return out;
  }

  window.mergeLangData = function(extra){ window.langData = deepMerge(common, extra||{}); };

  window.setLang = function(lang){
    const dictAll = window.langData || common;
    const dict = dictAll[lang] || dictAll.ko;

    for(const key in dict){
      if(key === "page-title" || key === "brand-sub") continue;
      const el = document.getElementById(key);
      if(el) el.innerHTML = dict[key];
    }
    if(dict["page-title"]) document.title = dict["page-title"];
    const brandSub = document.getElementById("brand-sub");
    if(brandSub && dict["brand-sub"]) brandSub.textContent = dict["brand-sub"];

    localStorage.setItem("lang", lang);
    document.querySelectorAll(".lang-switch button").forEach(btn=>{
      btn.classList.toggle("active", btn.dataset.lang === lang);
    });
  };

  window.initI18n = function(defaultLang="ko"){
    const saved = localStorage.getItem("lang");
    const browser = (navigator.language||"ko").slice(0,2);
    const initial = saved || (["ko","en","vi"].includes(browser) ? browser : defaultLang);

    document.querySelectorAll(".lang-switch button").forEach(btn=>{
      if(!btn.dataset.lang){
        const t = btn.textContent;
        if(t.includes("한국어")) btn.dataset.lang = "ko";
        else if(t.includes("English")) btn.dataset.lang = "en";
        else if(t.includes("Tiếng Việt")) btn.dataset.lang = "vi";
      }
      btn.addEventListener("click", ()=> window.setLang(btn.dataset.lang));
    });

    window.setLang(initial);
  };

  document.addEventListener("DOMContentLoaded", ()=>{
    if(!window.langData) window.langData = common;
    window.initI18n("ko");
  });
})();
