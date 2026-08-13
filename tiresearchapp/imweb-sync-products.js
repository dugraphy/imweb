/**
 * ============================================================================
 * 아임웹 Open API(v3, OAuth2)로 전체 상품 + 카테고리(브랜드) + 요약설명(차종)을
 * 긁어와 products.json 파일로 저장
 * ============================================================================
 * Node.js 환경(GitHub Actions 등)에서 주기적으로 실행하는 스크립트입니다.
 *
 * ▶ 필요한 환경변수
 *   IMWEB_CLIENT_ID / IMWEB_CLIENT_SECRET / IMWEB_REFRESH_TOKEN / IMWEB_UNIT_CODE
 *   (선택) GH_PAT, GITHUB_REPOSITORY - 리프레시 토큰 자동 갱신용
 *
 * ▶ 브랜드(카테고리) 규칙
 *   /products/shop-categories 응답은 트리 구조입니다.
 *   "자식이 없는(children이 빈 배열인) 카테고리"만 브랜드 필터 대상으로 취급합니다.
 *   예) 타이어(부모, 제외) > 한국타이어(자식, 포함) / 금호타이어(자식, 포함)
 *   → 새 브랜드를 추가하실 땐 "말단(리프) 카테고리"로 만들어서 상품에 달아주세요.
 *
 * ▶ 차종 규칙
 *   상품 상세 API의 simpleContent(요약 설명) 텍스트에서 키워드를 찾아 자동 분류합니다.
 *   - "전기차" 포함 → 전기차
 *   - "SUV" 또는 "RV" 포함 → RV/SUV
 *   - "승용" 포함 → 승용
 *   요약 설명에 해당 단어가 없으면 그 상품은 차종 필터 대상에서 제외됩니다(항상 노출).
 *   상품 개수만큼 상세 API를 추가로 호출하므로, 상품이 많아지면 동기화 시간이 늘어납니다.
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
const SHOP_PATH = '/tirelist';

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

// 카테고리 트리를 codeToName 맵과, 자식이 없는(리프) 코드 집합으로 평탄화
async function fetchCategoryMap(accessToken) {
  const url = `https://openapi.imweb.me/products/shop-categories?unitCode=${encodeURIComponent(UNIT_CODE)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok || json.statusCode !== 200) throw new Error('카테고리 조회 실패: ' + JSON.stringify(json));

  const codeToName = new Map();
  const leafCodes = new Set();

  function walk(nodes) {
    (nodes || []).forEach(node => {
      codeToName.set(node.categoryCode, node.name);
      if (!node.children || node.children.length === 0) {
        leafCodes.add(node.categoryCode);
      } else {
        walk(node.children);
      }
    });
  }
  walk(json.data);

  return { codeToName, leafCodes };
}

async function fetchProductDetail(accessToken, prodNo) {
  const url = `https://openapi.imweb.me/products/${prodNo}?unitCode=${encodeURIComponent(UNIT_CODE)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok || json.statusCode !== 200) {
    console.warn(`상품 ${prodNo} 상세 조회 실패, 차종 분류 건너뜀`);
    return null;
  }
  return json.data;
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseTitle(title) {
  const m = String(title || '').match(/(\d{3})\s*\/\s*(\d{2})\s*R\s*(\d{2})\s*(.+)/i);
  if (!m) return null;
  return { width: +m[1], profile: +m[2], rim: +m[3] };
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
  const keyData = await keyRes.json();
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

  console.log('카테고리 조회 중...');
  const { codeToName, leafCodes } = await fetchCategoryMap(accessToken);
  console.log(`카테고리 ${codeToName.size}개 조회 완료 (브랜드 대상 리프 카테고리 ${leafCodes.size}개)`);

  console.log('전체 상품 조회 중...');
  const rawProducts = await fetchAllProducts(accessToken);
  console.log(`총 ${rawProducts.length}개 상품 조회 완료`);

  console.log('상품별 요약설명(차종) 조회 중...');
  const products = [];
  for (const p of rawProducts) {
    const parsed = parseTitle(p.name);
    if (!parsed) continue; // 사이즈 파싱 실패 상품은 필터 데이터에서 제외

    const brands = (p.categories || [])
      .filter(code => leafCodes.has(code))
      .map(code => codeToName.get(code))
      .filter(Boolean);

    const detail = await fetchProductDetail(accessToken, p.prodNo);
    const summaryText = detail ? stripHtml(detail.simpleContent) : '';
    const vehicle = detectVehicleTypes(summaryText);

    products.push({
      idx: p.prodNo,
      name: p.name,
      price: p.price,
      oldPrice: p.priceOrg,
      img: (p.productImages && p.productImages[0]) || '',
      href: `${SHOP_PATH}?idx=${p.prodNo}`,
      width: parsed.width,
      profile: parsed.profile,
      rim: parsed.rim,
      brands,
      vehicle
    });

    await sleep(150); // 상세 API 호출 간 간단한 딜레이 (rate limit 대비)
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(products, null, 2), 'utf-8');
  console.log(`저장 완료: ${OUTPUT_FILE} (${products.length}개 상품)`);

  if (tokenData.refreshToken && tokenData.refreshToken !== REFRESH_TOKEN) {
    await updateGithubSecret('IMWEB_REFRESH_TOKEN', tokenData.refreshToken);
  }
}

main().catch(err => {
  console.error('동기화 실패:', err);
  process.exit(1);
});
