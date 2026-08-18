/**
 * ============================================================================
 * 아임웹 Open API(v3, OAuth2)로 전체 상품 + 카테고리(브랜드) + 요약설명(차종/연료)을
 * 긁어와 products.json 파일로 저장
 * ============================================================================
 * Node.js 환경(GitHub Actions 등)에서 주기적으로 실행하는 스크립트입니다.
 *
 * ▶ 필요한 환경변수
 *   IMWEB_CLIENT_ID / IMWEB_CLIENT_SECRET / IMWEB_REFRESH_TOKEN / IMWEB_UNIT_CODE
 *   (선택) GH_PAT, GITHUB_REPOSITORY - 리프레시 토큰 자동 갱신용
 *
 * ▶ 카테고리 트리 규칙 (2026-08-18 변경)
 *   최상위 카테고리 이름으로 "타이어" / "엔진오일" 두 트리를 구분합니다.
 *     타이어(부모) > 한국타이어(자식, 브랜드) / 금호타이어(자식, 브랜드) ...
 *     엔진오일(부모) > 킥스(자식, 브랜드) / 모빌(자식, 브랜드) ...
 *   "자식이 없는(children이 빈 배열인) 카테고리"만 브랜드 필터 대상으로 취급하는 건
 *   기존과 동일합니다. 새 브랜드를 추가하실 땐 반드시 "타이어" 또는 "엔진오일" 밑에
 *   말단(리프) 카테고리로 만들어서 상품에 달아주세요. 이 최상위 이름 밖에 있는
 *   카테고리에 속한 상품은 타입을 판별할 수 없어 동기화 대상에서 제외됩니다.
 *
 * ▶ 상품 타입별 필드
 *   - 타이어(category: "tire")   : width / profile / rim  (상품명에서 정규식으로 파싱)
 *   - 엔진오일(category: "oil")  : viscosity              (상품명에서 정규식으로 파싱)
 *   상품명에서 해당 패턴을 찾지 못하면 그 상품은 필터 데이터에서 제외됩니다.
 *
 * ▶ 차종 / 연료타입 규칙
 *   상품 상세 API의 simpleContent(요약 설명) 텍스트에서 키워드를 찾아 자동 분류합니다.
 *   [차종 - 타이어 상품에 적용]
 *     - "전기차" 포함 → 전기차
 *     - "SUV" 또는 "RV" 포함 → RV/SUV
 *     - "승용" 포함 → 승용
 *   [연료타입 - 엔진오일 상품에 적용]
 *     - "가솔린" 포함 → 가솔린
 *     - "디젤" 포함 → 디젤
 *     - "LPG" 포함 → LPG
 *   요약 설명에 해당 단어가 없으면 그 필터 대상에서 제외됩니다(항상 노출).
 *   상품 개수만큼 상세 API를 추가로 호출하므로, 상품이 많아지면 동기화 시간이 늘어납니다.
 *
 * ▶ 상세 API 장애 방어 (2026-08-14 추가)
 *   아임웹 게이트웨이가 순간적으로 "upstream connect error..." 같은 비-JSON 응답을
 *   200으로 내려주는 경우가 있습니다. 이때 fetchProductDetail이 예외를 던지면 전체
 *   동기화가 죽으므로, 해당 상품 하나만 건너뛰고(차종/연료 정보 없이) 계속 진행합니다.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const CLIENT_ID     = process.env.IMWEB_CLIENT_ID;
const CLIENT_SECRET = process.env.IMWEB_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.IMWEB_REFRESH_TOKEN;
const UNIT_CODE     = process.env.IMWEB_UNIT_CODE;

const GH_PAT             = process.env.GH_PAT || null;
const GITHUB_REPOSITORY  = process.env.GITHUB_REPOSITORY || null;

const OUTPUT_FILE = path.join(__dirname, 'products.json');

// 최상위 카테고리 이름 ↔ 상품 타입 매핑
// 아임웹 관리자에서 카테고리 이름을 이 값과 정확히 똑같이 만들어주세요.
const TOP_CATEGORY_MAP = {
  '타이어': 'tire',
  '엔진오일': 'oil'
};

const SHOP_PATH_BY_TYPE = {
  tire: '/tirelist',
  oil: '/oillist'
};

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !UNIT_CODE) {
  console.error('IMWEB_CLIENT_ID / IMWEB_CLIENT_SECRET / IMWEB_REFRESH_TOKEN / IMWEB_UNIT_CODE 환경변수가 모두 필요합니다.');
  process.exit(1);
}

async function refreshAccessToken() {
  const body = new URLSearchParams({
    grantType: 'refresh_token',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    refreshToken: REFRESH_TOKEN
  });
  const res = await fetch('https://openapi.imweb.me/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await res.json();
  if (!res.ok || !json?.data?.accessToken) {
    throw new Error('토큰 갱신 실패: ' + JSON.stringify(json));
  }
  return json.data;
}

async function fetchAllProducts(accessToken) {
  const all = [];
  let page = 1;
  const limit = 100;
  while (true) {
    const url = `https://openapi.imweb.me/products?page=${page}&limit=${limit}&unitCode=${encodeURIComponent(UNIT_CODE)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = await res.json();
    if (!res.ok || json.statusCode !== 200) throw new Error('상품 조회 실패: ' + JSON.stringify(json));
    all.push(...(json.data.list || []));
    console.log(`상품 page ${page}/${json.data.totalPage} 완료 (누적 ${all.length}/${json.data.totalCount})`);
    if (page >= json.data.totalPage) break;
    page++;
    await sleep(200);
  }
  return all;
}

// 카테고리 트리를 codeToName 맵 + 리프 코드 집합 + (리프 코드 → 최상위 타입) 맵으로 평탄화
async function fetchCategoryMap(accessToken) {
  const url = `https://openapi.imweb.me/products/shop-categories?unitCode=${encodeURIComponent(UNIT_CODE)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok || json.statusCode !== 200) throw new Error('카테고리 조회 실패: ' + JSON.stringify(json));

  const codeToName = new Map();
  const leafCodes = new Set();
  const leafCodeToType = new Map(); // leafCode -> 'tire' | 'oil' (TOP_CATEGORY_MAP에 없는 최상위는 매핑되지 않음)

  function walk(nodes, topType) {
    (nodes || []).forEach(node => {
      codeToName.set(node.categoryCode, node.name);

      // 최상위(depth 0) 노드를 만날 때만 topType을 새로 결정하고,
      // 그 아래 자손들에게는 동일한 topType을 계속 물려줍니다.
      const currentTopType = topType !== undefined ? topType : (TOP_CATEGORY_MAP[node.name] || null);

      if (!node.children || node.children.length === 0) {
        leafCodes.add(node.categoryCode);
        if (currentTopType) leafCodeToType.set(node.categoryCode, currentTopType);
      } else {
        walk(node.children, currentTopType);
      }
    });
  }
  walk(json.data, undefined);

  return { codeToName, leafCodes, leafCodeToType };
}

// 상품 상세 조회 (요약설명/차종/연료용). 실패해도 절대 예외를 던지지 않고 null을 반환합니다.
async function fetchProductDetail(accessToken, prodNo, retries = 1) {
  const url = `https://openapi.imweb.me/products/${prodNo}?unitCode=${encodeURIComponent(UNIT_CODE)}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

      let json;
      try {
        json = await res.json();
      } catch (parseErr) {
        console.warn(`상품 ${prodNo} 상세 응답이 JSON이 아님 (attempt ${attempt + 1}/${retries + 1}): ${parseErr.message}`);
        json = null;
      }

      if (json && res.ok && json.statusCode === 200) {
        return json.data;
      }

      console.warn(`상품 ${prodNo} 상세 조회 실패 (attempt ${attempt + 1}/${retries + 1}), 차종/연료 분류 건너뜀`);
    } catch (networkErr) {
      console.warn(`상품 ${prodNo} 상세 조회 중 네트워크 오류 (attempt ${attempt + 1}/${retries + 1}): ${networkErr.message}`);
    }

    if (attempt < retries) await sleep(500);
  }

  return null;
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function detectVehicleTypes(summaryText) {
  const types = [];
  if (/전기차/.test(summaryText)) types.push('전기차');
  if (/\bRV\b/i.test(summaryText) || /SUV/i.test(summaryText)) types.push('RV/SUV');
  if (/승용/.test(summaryText)) types.push('승용');
  return types;
}

// 연료타입은 (다중 선택이 아니라) 상품 하나당 보통 하나이므로 첫 매치만 사용합니다.
// 상세 요약설명에 문구가 없으면 빈 문자열을 반환하고, 프론트 필터에서는 "전체 노출" 취급됩니다.
function detectFuelType(summaryText) {
  if (/가솔린/.test(summaryText)) return '가솔린';
  if (/디젤/.test(summaryText)) return '디젤';
  if (/LPG/i.test(summaryText)) return 'LPG';
  return '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 타이어 규격 파싱: "245/50R20 ..." → { width, profile, rim }
function parseTireSize(title) {
  const m = String(title || '').match(/(\d{3})\s*\/\s*(\d{2})\s*R\s*(\d{2})/i);
  if (!m) return null;
  return { width: +m[1], profile: +m[2], rim: +m[3] };
}

// 오일 점도등급 파싱: "킥스 KIXX GX5 5W-30" → "5W-30"
// 공백/하이픈 표기가 섞여 있어도("5W30", "5W 30") "5W-30" 형태로 정규화합니다.
function parseViscosity(title) {
  const m = String(title || '').match(/(\d{1,2})\s*W\s*-?\s*(\d{2})/i);
  if (!m) return null;
  return `${m[1]}W-${m[2]}`;
}

async function updateGithubSecret(name, value) {
  if (!GH_PAT || !GITHUB_REPOSITORY) {
    console.log('GH_PAT 또는 GITHUB_REPOSITORY가 없어 시크릿 자동 갱신은 건너뜁니다.');
    return;
  }
  const sodium = require('libsodium-wrappers');
  await sodium.ready;
  const [owner, repo] = GITHUB_REPOSITORY.split('/');
  const keyRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`, {
    headers: { Authorization: `Bearer ${GH_PAT}`, Accept: 'application/vnd.github+json' }
  });
  if (!keyRes.ok) {
    const bodyText = await keyRes.text();
    throw new Error(`공개키 조회 실패 (${keyRes.status}): ${bodyText}`);
  }
  const keyData = await keyRes.json();
  if (!keyData || !keyData.key) {
    throw new Error('공개키 응답에 key 필드가 없습니다: ' + JSON.stringify(keyData));
  }
  const binKey = sodium.from_base64(keyData.key, sodium.base64_variants.ORIGINAL);
  const binVal = sodium.from_string(value);
  const encBytes = sodium.crypto_box_seal(binVal, binKey);
  const encrypted = sodium.to_base64(encBytes, sodium.base64_variants.ORIGINAL);
  const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${GH_PAT}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ encrypted_value: encrypted, key_id: keyData.key_id })
  });
  if (!putRes.ok) console.error('시크릿 자동 갱신 실패:', await putRes.text());
  else console.log(`GitHub Secret [${name}] 갱신 완료`);
}

async function main() {
  console.log('액세스 토큰 갱신 중...');
  const tokenData = await refreshAccessToken();
  const accessToken = tokenData.accessToken;
  console.log('토큰 갱신 완료. scope:', tokenData.scope);

  if (tokenData.refreshToken && tokenData.refreshToken !== REFRESH_TOKEN) {
    try {
      await updateGithubSecret('IMWEB_REFRESH_TOKEN', tokenData.refreshToken);
    } catch (secretErr) {
      console.error('리프레시 토큰 자동 저장 실패 (상품 동기화는 계속 진행합니다):', secretErr.message);
    }
  }

  console.log('카테고리 조회 중...');
  const { codeToName, leafCodes, leafCodeToType } = await fetchCategoryMap(accessToken);
  console.log(`카테고리 ${codeToName.size}개 조회 완료 (브랜드 대상 리프 카테고리 ${leafCodes.size}개)`);

  console.log('전체 상품 조회 중...');
  const rawProducts = await fetchAllProducts(accessToken);
  console.log(`총 ${rawProducts.length}개 상품 조회 완료`);

  console.log('상품별 요약설명(차종/연료) 조회 중...');
  const products = [];
  let detailFailCount = 0;
  let skippedNoType = 0;
  let skippedNoPattern = 0;

  for (const p of rawProducts) {
    const productLeafCodes = (p.categories || []).filter(code => leafCodes.has(code));

    // 이 상품이 속한 리프 카테고리들 중, 타입(tire/oil)이 매핑된 것을 찾음
    const productType = productLeafCodes
      .map(code => leafCodeToType.get(code))
      .find(Boolean);

    if (!productType) {
      // "타이어" 또는 "엔진오일" 최상위 카테고리 밑에 속하지 않은 상품은 판별 불가 → 제외
      skippedNoType++;
      continue;
    }

    const brands = productLeafCodes
      .map(code => codeToName.get(code))
      .filter(Boolean);

    let sizeFields = null;
    if (productType === 'tire') {
      const parsed = parseTireSize(p.name);
      if (!parsed) { skippedNoPattern++; continue; }
      sizeFields = { width: parsed.width, profile: parsed.profile, rim: parsed.rim };
    } else if (productType === 'oil') {
      const viscosity = parseViscosity(p.name);
      if (!viscosity) { skippedNoPattern++; continue; }
      sizeFields = { viscosity };
    }

    const detail = await fetchProductDetail(accessToken, p.prodNo);
    if (!detail) detailFailCount++;
    const summaryText = detail ? stripHtml(detail.simpleContent) : '';

    const extraFields = productType === 'tire'
      ? { vehicle: detectVehicleTypes(summaryText) }
      : { fuelType: detectFuelType(summaryText) };

    products.push({
      idx: p.prodNo,
      category: productType, // 'tire' | 'oil'
      name: p.name,
      price: p.price,
      oldPrice: p.priceOrg,
      img: (p.productImages && p.productImages[0]) || '',
      href: `${SHOP_PATH_BY_TYPE[productType]}?idx=${p.prodNo}`,
      brands,
      ...sizeFields,
      ...extraFields
    });

    await sleep(150);
  }

  if (detailFailCount > 0) {
    console.warn(`상세 조회 실패한 상품 ${detailFailCount}개 (차종/연료 정보 없이 저장됨, 동기화는 정상 완료)`);
  }
  if (skippedNoType > 0) {
    console.warn(`"타이어"/"엔진오일" 최상위 카테고리에 속하지 않아 제외된 상품 ${skippedNoType}개`);
  }
  if (skippedNoPattern > 0) {
    console.warn(`이름에서 규격/점도를 파싱하지 못해 제외된 상품 ${skippedNoPattern}개`);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(products, null, 2), 'utf-8');
  console.log(`저장 완료: ${OUTPUT_FILE} (${products.length}개 상품)`);
}

main().catch(err => {
  console.error('동기화 실패:', err);
  process.exit(1);
});
