-- Add descriptive QR-menu metadata from the restaurant-provided menu PDF.
--
-- Deliberately excluded: price_usd and price_vnd. The live values already in
-- menu_items remain the only price source for display, validation, and orders.

create temporary table qr_menu_pdf_metadata_stage (
  ko_name text primary key,
  en_name text,
  description_ko text,
  description_en text,
  description_vi text,
  image_url text not null unique,
  qr_category text not null,
  requires_preorder boolean not null
);

insert into qr_menu_pdf_metadata_stage (
  ko_name, en_name, description_ko, description_en, description_vi,
  image_url, qr_category, requires_preorder
)
values
    (
      '신라면',
      'Shin Ramen',
      '매콤한 한국식 라면을 간단한 고명과 함께 뜨겁게 제공합니다.',
      'A classic spicy Korean instant noodle soup served hot with simple toppings.',
      'Mì gói Hàn Quốc cay, phục vụ nóng với topping đơn giản.',
      'image/restaurant/qr-menu/shin-ramen.webp',
      'single',
      false
    ),
    (
      '설렁탕',
      'Ox Bone Soup (Seolleongtang)',
      '소뼈를 오래 고아 만든 뽀얀 국물에 밥과 한식 반찬을 곁들입니다.',
      'Milky beef bone soup slowly simmered, served with rice and side dishes.',
      'Canh xương bò ninh lâu, ăn kèm cơm và banchan kiểu Hàn.',
      'image/restaurant/qr-menu/seolleongtang.webp',
      'single',
      false
    ),
    (
      '육개장',
      'Spicy Beef Soup (Yukgaejang)',
      '결대로 찢은 소고기와 채소, 당면을 넣어 얼큰하게 끓인 한국식 소고기국입니다.',
      'Spicy Korean beef soup with shredded beef, vegetables and glass noodles.',
      'Canh bò cay với thịt bò xé, rau và miến kiểu Hàn Quốc.',
      'image/restaurant/qr-menu/yukgaejang.webp',
      'single',
      false
    ),
    (
      '얼큰 사골 우거지탕',
      'Spicy Beef Bone Soup with Greens',
      '진한 소뼈 국물에 우거지와 고추를 넣어 칼칼하게 끓여 밥과 잘 어울립니다.',
      'Rich beef bone broth with Korean greens and chili, perfect with rice.',
      'Nước dùng xương bò đậm, nấu cùng rau và ớt cay, rất hợp ăn với cơm.',
      'image/restaurant/qr-menu/spicy-beef-bone-greens.webp',
      'single',
      false
    ),
    (
      '떡만두국',
      'Rice Cake and Dumpling Soup',
      '맑은 소고기 국물에 떡과 만두를 넣어 끓인 전통 한국식 국입니다.',
      'Traditional Korean soup with rice cakes and dumplings in a clear beef broth.',
      'Canh truyền thống Hàn Quốc với bánh gạo và há cảo trong nước dùng bò thanh ngọt.',
      'image/restaurant/qr-menu/rice-cake-dumpling-soup.webp',
      'single',
      false
    ),
    (
      '돌솥 알밥',
      'Hot Stone Pot Roe Rice',
      '뜨거운 돌솥에 날치알과 채소를 올려 비벼 먹으며 바삭한 누룽지를 즐길 수 있습니다.',
      'Rice in a hot stone bowl with fish roe and vegetables, mixed before eating.',
      'Cơm nồi đá với trứng cá và rau, trộn đều rồi thưởng thức lớp cơm cháy giòn.',
      'image/restaurant/qr-menu/hot-stone-roe-rice.webp',
      'single',
      false
    ),
    (
      '제육덮밥',
      'Spicy Stir-fried Pork Rice Bowl',
      '고추장 양념에 매콤하게 볶은 돼지고기를 따뜻한 밥 위에 올렸습니다.',
      'Stir-fried pork with spicy gochujang sauce served over rice.',
      'Thịt heo xào sốt gochujang cay, ăn cùng cơm nóng.',
      'image/restaurant/qr-menu/spicy-pork-rice.webp',
      'single',
      false
    ),
    (
      '다금바리 회덮밥',
      'Dageumbari Sashimi Rice Bowl',
      '신선한 다금바리 회와 채소, 매콤한 소스를 밥과 함께 비벼 먹습니다.',
      'Fresh Dageumbari sashimi over rice with vegetables and spicy sauce.',
      'Cá Dageumbari tươi ăn cùng cơm, rau và sốt cay Hàn Quốc.',
      'image/restaurant/qr-menu/dageumbari-sashimi-rice.webp',
      'single',
      false
    ),
    (
      '냉면',
      'Cold Noodles (Broth or Spicy)',
      '시원한 육수의 물냉면 또는 매콤한 양념의 비빔냉면으로 즐기는 메밀면입니다.',
      'Chilled buckwheat noodles served in icy broth or mixed with spicy sauce.',
      'Mì kiều mạch lạnh, dùng với nước dùng đá hoặc trộn sốt cay.',
      'image/restaurant/qr-menu/cold-noodles.webp',
      'single',
      false
    ),
    (
      '순두부찌개',
      'Soft Tofu Stew',
      '부드러운 순두부와 채소, 달걀을 넣어 은은하게 매콤하게 끓였습니다.',
      'Mildly spicy stew with soft tofu, vegetables and egg.',
      'Đậu phụ mềm hầm với rau và trứng, vị cay nhẹ dễ ăn.',
      'image/restaurant/qr-menu/soft-tofu-stew.webp',
      'single',
      false
    ),
    (
      '찌개(김치/된장)',
      'Kimchi or Soybean Paste Stew',
      '잘 익은 김치와 돼지고기, 두부로 끓인 김치찌개 또는 된장과 채소, 두부로 끓인 된장찌개입니다.',
      'Choose tangy kimchi stew with pork and tofu or traditional soybean paste stew with vegetables and tofu.',
      'Chọn canh kim chi nấu với thịt heo và đậu phụ hoặc canh tương đậu nấu với rau và đậu phụ.',
      'image/restaurant/qr-menu/kimchi-stew.webp',
      'single',
      false
    ),
    (
      '짜파게티',
      'Korean Black Bean Noodles',
      '진하고 감칠맛 나는 짜장 소스에 면과 부드러운 돼지고기를 함께 즐기는 한국식 면 요리입니다.',
      'Korean-style noodles coated in a rich and savory black bean sauce, finished with tender pork and deep umami flavor.',
      'Mì Hàn Quốc sốt đậu đen đậm đà, kết hợp thịt heo mềm và hương vị umami đặc trưng.',
      'image/restaurant/qr-menu/jjapagetti.webp',
      'single',
      false
    ),
    (
      '불닭볶음면',
      'Spicy Korean Stir-fried Noodles',
      '강렬하고 매운 소스의 한국식 볶음면으로 중독성 있는 매운맛이 특징입니다.',
      'Extremely spicy Korean stir-fried noodles with a bold, fiery sauce and addictive flavor.',
      'Mì xào Hàn Quốc siêu cay với sốt đậm vị, cay nồng và cực kỳ gây nghiện.',
      'image/restaurant/qr-menu/buldak-noodles.webp',
      'single',
      false
    ),
    (
      '비빔국수',
      'Spicy Mixed Noodles',
      '차가운 면에 새콤달콤한 고추장 양념, 신선한 채소와 참기름을 넣어 비볐습니다.',
      'Chilled noodles mixed with spicy-sweet gochujang sauce, fresh vegetables and sesame oil.',
      'Mì trộn Hàn Quốc với sốt gochujang cay ngọt, rau tươi và dầu mè thơm.',
      'image/restaurant/qr-menu/bibim-noodles.webp',
      'single',
      false
    ),
    (
      '명동칼국수',
      'Korean Knife-cut Noodle Soup',
      '손으로 썬 면을 담백하고 따뜻한 국물에 끓여 편안하게 즐기는 칼국수입니다.',
      'Warm and comforting Korean noodle soup with hand-cut noodles in a light, savory broth.',
      'Mì nước Hàn Quốc sợi cắt tay, nước dùng thanh ngọt và dễ ăn.',
      'image/restaurant/qr-menu/myeongdong-kalguksu.webp',
      'single',
      false
    ),
    (
      '돼지국밥',
      'Pork Soup with Rice',
      '부산식 돼지뼈 국물에 부드러운 돼지고기와 밥을 곁들입니다.',
      'Busan-style pork broth soup served with tender pork and rice.',
      'Canh nước hầm xương heo kiểu Busan, ăn kèm thịt heo mềm và cơm.',
      'image/restaurant/qr-menu/pork-soup-rice.webp',
      'single',
      false
    ),
    (
      '도가니탕',
      'Ox Knee Soup',
      '도가니를 오래 고아 깊은 감칠맛과 풍부한 콜라겐을 느낄 수 있는 국입니다.',
      'Slow-simmered ox knee soup, rich in collagen and deeply savory.',
      'Canh gân bò hầm lâu, đậm đà và giàu collagen.',
      'image/restaurant/qr-menu/ox-knee-soup.webp',
      'single',
      false
    ),
    (
      '부채살 스테이크',
      'Chuck Flap Tail Steak',
      '육즙이 풍부한 부채살을 구워 채소와 소스를 곁들였습니다.',
      'Juicy grilled beef steak from chuck flap tail, served with vegetables.',
      'Thịt bò nạc vai nướng mọng nước, ăn kèm rau và sốt.',
      'image/restaurant/qr-menu/chuck-flap-steak.webp',
      'single',
      false
    ),
    (
      '연어 스테이크',
      'Salmon Steak',
      '겉은 살짝 바삭하고 속은 부드럽게 구운 연어 스테이크입니다.',
      'Pan-seared salmon steak, crispy outside and tender inside.',
      'Cá hồi áp chảo, bên ngoài hơi giòn, bên trong mềm.',
      'image/restaurant/qr-menu/salmon-steak.webp',
      'single',
      false
    ),
    (
      '김치전골',
      'Kimchi Hot Pot (per person)',
      '김치와 돼지고기, 두부를 함께 끓이며 1인 기준으로 주문하는 전골입니다.',
      'Hot pot with kimchi, pork and tofu, priced per person.',
      'Lẩu kim chi với thịt heo và đậu phụ, tính giá theo từng người.',
      'image/restaurant/qr-menu/kimchi-hot-pot.webp',
      'shared',
      false
    ),
    (
      '우렁쌈밥',
      'Snail Lettuce Wrap Rice (per person)',
      '양념한 우렁이와 밥을 신선한 쌈 채소와 소스에 곁들여 먹습니다.',
      'Seasoned snails and rice wrapped in fresh lettuce with sauces.',
      'Cơm và ốc nêm gia vị, cuốn với rau xà lách tươi và nước chấm.',
      'image/restaurant/qr-menu/snail-wrap-rice.webp',
      'shared',
      false
    ),
    (
      '제육볶음',
      'Spicy Stir-fried Pork (per person)',
      '매콤하게 볶은 돼지고기와 밥을 신선한 채소에 싸서 먹습니다.',
      'Spicy stir-fried pork and rice wrapped in lettuce leaves.',
      'Thịt heo xào cay và cơm, ăn cuốn với lá rau tươi.',
      'image/restaurant/qr-menu/spicy-pork-lettuce.webp',
      'shared',
      false
    ),
    (
      '삼겹살',
      'Grilled Pork Belly (per person)',
      '한국식 삼겹살을 구워 쌈 채소와 소스에 곁들여 먹습니다.',
      'Classic Korean grilled pork belly enjoyed with lettuce and sauces.',
      'Ba chỉ heo nướng kiểu Hàn, ăn cuốn với rau và nước chấm.',
      'image/restaurant/qr-menu/grilled-pork-belly.webp',
      'shared',
      false
    ),
    (
      '훈제오리구이',
      'Smoked Duck',
      '부드러운 훈제오리 슬라이스를 채소와 소스에 곁들였습니다.',
      'Tender smoked duck slices served with vegetables and sauces.',
      'Vịt hun khói thái lát mềm, ăn kèm rau và nước chấm.',
      'image/restaurant/qr-menu/smoked-duck.webp',
      'shared',
      false
    ),
    (
      '모듬수육전골',
      'Assorted Boiled Meat Hot Pot',
      '여러 종류의 수육과 채소를 담백한 국물에 끓여 먹는 전골입니다.',
      'Hot pot with assorted boiled meats and vegetables in a mild broth.',
      'Lẩu với nhiều loại thịt luộc và rau, nước dùng nhẹ dễ ăn.',
      'image/restaurant/qr-menu/assorted-boiled-meat-hotpot.webp',
      'shared',
      false
    ),
    (
      '오뎅탕',
      'Fish Cake Soup',
      '한국식 어묵과 채소를 담백하게 끓여 소주와 잘 어울리는 국물 요리입니다.',
      'Light soup with Korean fish cakes and vegetables, good with soju.',
      'Canh chả cá kiểu Hàn với rau, rất hợp uống cùng soju.',
      'image/restaurant/qr-menu/fish-cake-soup.webp',
      'snack',
      false
    ),
    (
      '다금바리 초무침',
      'Spicy Marinated Dageumbari Fish',
      '얇게 썬 다금바리를 한국식 새콤매콤한 양념에 무쳤습니다.',
      'Sliced Dageumbari fish in spicy and sour Korean dressing.',
      'Cá Dageumbari thái lát trộn sốt cay chua kiểu Hàn Quốc.',
      'image/restaurant/qr-menu/dageumbari-spicy-salad.webp',
      'snack',
      false
    ),
    (
      '육회',
      'Beef Tartare (Yukhoe)',
      '신선한 소고기에 참기름과 배, 달걀노른자를 곁들인 한국식 육회입니다.',
      'Korean-style beef tartare with sesame oil, pear and egg yolk.',
      'Thịt bò sống trộn dầu mè, lê và lòng đỏ trứng kiểu Hàn Quốc.',
      'image/restaurant/qr-menu/beef-tartare.webp',
      'snack',
      false
    ),
    (
      '국물닭발',
      'Spicy Chicken Feet',
      '쫄깃한 닭발을 매콤한 한국식 소스에 진하게 끓였습니다.',
      'Chicken feet simmered in spicy Korean sauce, chewy and bold.',
      'Chân gà hầm sốt cay kiểu Hàn, dai dai và rất đậm vị.',
      'image/restaurant/qr-menu/spicy-chicken-feet.webp',
      'snack',
      false
    ),
    (
      '스팸구이',
      'Grilled Spam',
      '스팸을 노릇하게 구워 짭짤하고 간단하게 즐기는 안주입니다.',
      'Pan-fried Spam slices, simple and salty, great with drinks.',
      'Thịt hộp Spam áp chảo, đơn giản nhưng rất hợp nhắm rượu.',
      'image/restaurant/qr-menu/grilled-spam.webp',
      'snack',
      false
    ),
    (
      '치킨',
      'Fried Chicken',
      '겉은 바삭하고 속은 촉촉하게 튀긴 한국식 후라이드 치킨입니다.',
      'Crispy Korean-style fried chicken, perfect with beer.',
      'Gà rán giòn kiểu Hàn Quốc, rất hợp uống bia.',
      'image/restaurant/qr-menu/fried-chicken.webp',
      'snack',
      false
    ),
    (
      '관자구이',
      'Grilled Scallops',
      '관자를 가볍게 양념해 달콤하고 부드럽게 구웠습니다.',
      'Scallops grilled with light seasoning, sweet and tender.',
      'Sò điệp nướng với gia vị nhẹ, thịt ngọt mềm.',
      'image/restaurant/qr-menu/grilled-scallops.webp',
      'snack',
      false
    ),
    (
      '떡볶이',
      'Spicy Rice Cakes (Tteokbokki)',
      '쫄깃한 떡과 어묵을 새콤달콤한 고추장 소스에 끓였습니다.',
      'Soft rice cakes in sweet and spicy gochujang sauce with fish cakes.',
      'Bánh gạo dẻo nấu sốt gochujang cay ngọt, kèm chả cá.',
      'image/restaurant/qr-menu/tteokbokki.webp',
      'snack',
      false
    ),
    (
      '새우튀김',
      'Fried Shrimp',
      '새우에 얇은 튀김옷을 입혀 바삭하고 고소하게 튀겼습니다.',
      'Deep-fried shrimp in light batter, crispy and tasty.',
      'Tôm chiên bột giòn, thơm ngon, hợp nhắm bia.',
      'image/restaurant/qr-menu/fried-shrimp.webp',
      'snack',
      false
    ),
    (
      '묵은지 두부수육',
      'Boiled Pork with Aged Kimchi and Tofu',
      '부드러운 수육에 오래 숙성한 묵은지와 두부를 곁들여 균형 잡힌 맛을 냅니다.',
      'Tender boiled pork served with aged kimchi and soft tofu, perfectly balanced and savory.',
      'Thịt luộc mềm ăn kèm kimchi ủ lâu và đậu phụ, hài hòa và đậm đà.',
      'image/restaurant/qr-menu/boiled-pork-aged-kimchi-tofu.webp',
      'preorder',
      true
    ),
    (
      '묵은지 등갈비찜',
      'Braised Pork Ribs with Aged Kimchi',
      '등갈비를 잘 익은 묵은지와 함께 푹 익혀 깊고 매콤한 맛을 냅니다.',
      'Pork ribs braised with well-fermented kimchi, rich and spicy.',
      'Sườn heo om cùng kim chi lên men lâu, vị cay chua đậm đà.',
      'image/restaurant/qr-menu/braised-pork-ribs-kimchi.webp',
      'preorder',
      true
    ),
    (
      '닭볶음탕',
      'Spicy Braised Chicken',
      '닭 한 마리를 채소와 함께 매콤한 한국식 양념에 푹 끓였습니다.',
      'Whole chicken braised in spicy Korean sauce with vegetables.',
      'Gà nguyên con hầm sốt cay kiểu Hàn với rau củ.',
      'image/restaurant/qr-menu/spicy-braised-chicken.webp',
      'preorder',
      true
    ),
    (
      '아티소 누룽지 백숙',
      'Artichoke Chicken Soup with Crispy Rice',
      '닭 한 마리를 달랏 아티소와 함께 삶아 바삭한 누룽지를 곁들입니다.',
      'Whole chicken boiled with Dalat artichoke, served with crispy rice.',
      'Gà nguyên con hầm cùng atiso Đà Lạt, ăn kèm cơm cháy giòn.',
      'image/restaurant/qr-menu/artichoke-chicken-crispy-rice.webp',
      'preorder',
      true
    ),
    (
      '다금바리 회 2kg+',
      'Dageumbari Sashimi Set (2kg+)',
      '2kg 이상의 다금바리 한 마리를 회, 초밥과 매운탕으로 즐기는 코스입니다.',
      'Premium Dageumbari full course with sashimi, sushi and spicy soup.',
      'Cá Dageumbari cao cấp phục vụ trọn bộ: gỏi sống, sushi và canh cá cay.',
      'image/restaurant/qr-menu/dageumbari-sashimi-set.webp',
      'preorder',
      true
    ),
    (
      '소주', 'Soju', null, null, null,
      'image/restaurant/qr-menu/soju.webp', 'drink', false
    ),
    (
      '맥주', 'Beer', null, null, null,
      'image/restaurant/qr-menu/beer.webp', 'drink', false
    ),
    (
      '음료', 'Soft Drink', null, null, null,
      'image/restaurant/qr-menu/soft-drink.webp', 'drink', false
    ),
    (
      '막걸리', 'Makgeolli', null, null, null,
      'image/restaurant/qr-menu/makgeolli.webp', 'drink', false
    ),
    (
      '보드카 MEN', 'Vodka Men', null, null, null,
      'image/restaurant/qr-menu/vodka-men.webp', 'drink', false
    ),
    (
      '넵 모이', 'Nep Moi', null, null, null,
      'image/restaurant/qr-menu/nep-moi.webp', 'drink', false
    ),
    (
      '레드 와인', 'Red Wine', null, null, null,
      'image/restaurant/qr-menu/red-wine.webp', 'drink', false
    ),
    (
      '화이트 와인', 'White Wine', null, null, null,
      'image/restaurant/qr-menu/white-wine.webp', 'drink', false
    ),
    (
      '하이볼', 'Highball', null, null, null,
      'image/restaurant/qr-menu/highball.webp', 'drink', false
    );

do $$
declare
  v_stage_count integer;
  v_bad_name_count integer;
begin
  select count(*) into v_stage_count
  from pg_temp.qr_menu_pdf_metadata_stage;

  select count(*) into v_bad_name_count
  from (
    select staged.ko_name
    from pg_temp.qr_menu_pdf_metadata_stage as staged
    left join public.menu_items as menu on menu.ko_name = staged.ko_name
    group by staged.ko_name
    having count(menu.id) <> 1
  ) as invalid_names;

  if v_stage_count <> 48 or v_bad_name_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message = pg_catalog.format(
        'QR menu metadata requires 48 unique names with one menu_items match each; staged=%s invalid_matches=%s',
        v_stage_count,
        v_bad_name_count
      );
  end if;
end;
$$;

update public.menu_items as menu
set
  en_name = metadata.en_name,
  description_ko = metadata.description_ko,
  description_en = metadata.description_en,
  description_vi = metadata.description_vi,
  image_url = metadata.image_url,
  qr_category = metadata.qr_category,
  requires_preorder = metadata.requires_preorder,
  updated_at = now()
from pg_temp.qr_menu_pdf_metadata_stage as metadata
where menu.ko_name = metadata.ko_name;

do $$
declare
  v_matched_rows integer;
  v_distinct_images integer;
begin
  select count(*), count(distinct menu.image_url)
  into v_matched_rows, v_distinct_images
  from public.menu_items as menu
  join pg_temp.qr_menu_pdf_metadata_stage as staged
    on staged.ko_name = menu.ko_name
  where menu.en_name is not distinct from staged.en_name
    and menu.description_ko is not distinct from staged.description_ko
    and menu.description_en is not distinct from staged.description_en
    and menu.description_vi is not distinct from staged.description_vi
    and menu.image_url is not distinct from staged.image_url
    and menu.qr_category is not distinct from staged.qr_category
    and menu.requires_preorder is not distinct from staged.requires_preorder;

  if v_matched_rows <> 48 or v_distinct_images <> 48 then
    raise exception using
      errcode = 'P0001',
      message = pg_catalog.format(
        'QR menu metadata expected 48 one-to-one matches, found %s rows and %s distinct images',
        v_matched_rows,
        v_distinct_images
      );
  end if;
end;
$$;

drop table pg_temp.qr_menu_pdf_metadata_stage;
