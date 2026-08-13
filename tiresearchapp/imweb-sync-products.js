/**
 * ============================================================================
 * 아임웹 Open API(v3, OAuth2)로 전체 상품을 긁어와 products.json 파일로 저장
 * ============================================================================
 * Node.js 환경(GitHub Actions 등)에서 주기적으로 실행하는 스크립트입니다.
 * 절대 브라우저에서 실행하거나, 이 파일에 실제 키 값을 직접 적지 마세요.
 *
 * ▶ 필요한 환경변수
 *   IMWEB_CLIENT_ID      - 아임웹 개발자센터에서 발급받은 Client ID
 *   IMWEB_CLIENT_SECRET  - 아임웹 개발자센터에서 발급받은 Client Secret
 *   IMWEB_REFRESH_TOKEN  - 최초 1회 수동 인증으로 발급받은 Refresh Token
 *   IMWEB_UNIT_CODE      - 액세스 토큰 안에 담겨있던 unitCode (예: u2026061652f9282162ece)
 *
 *   (선택, 리프레시 토큰 자동 갱신용)
 *   GH_PAT                - repo 시크릿을 수정할 수 있는 GitHub Personal Access Token
 *   GITHUB_REPOSITORY     - GitHub Actions가 자동으로 넣어주는 값 (owner/repo)
 *
 * ▶ 로컬 실행 예시
 *   IMWEB_CLIENT_ID=xxx IMWEB_CLIENT_SECRET=xxx IMWEB_REFRESH_TOKEN=xxx IMWEB_UNIT_CODE=xxx node imweb-sync-products.js
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
// 실제 상품목록 페이지 경로에 맞게 필요시 수정하세요.
const SHOP_PATH = '/15/';

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
  return json.data; // { accessToken, refreshToken, scope }
}

async function fetchAllProducts(accessToken) {
  const all = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const url = `https://openapi.imweb.me/products?page=${page}&limit=${limit}&unitCode=${encodeURIComponent(UNIT_CODE)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const json = await res.json();
    if (!res.ok || json.statusCode !== 200) {
      throw new Error('상품 조회 실패: ' + JSON.stringify(json));
    }

    const list = json.data.list || [];
    all.push(...list);
    console.log(`page ${page}/${json.data.totalPage} 완료 (누적 ${all.length}/${json.data.totalCount})`);

    if (page >= json.data.totalPage) break;
    page++;
    await sleep(200);
  }

  return all;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 상품명("165/60R15 솔루스 TA31")에서 필터에 필요한 필드를 뽑아냅니다.
function parseTitle(title) {
  const m = String(title || '').match(/(\d{3})\s*\/\s*(\d{2})\s*R\s*(\d{2})\s*(.+)/i);
  if (!m) return null;
  return { width: +m[1], profile: +m[2], rim: +m[3], model: m[4].trim() };
}

// GitHub Secrets에 새 refreshToken을 자동으로 업데이트 (선택 기능)
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
    headers: {
      Authorization: `Bearer ${GH_PAT}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ encrypted_value: encrypted, key_id: keyData.key_id })
  });

  if (!putRes.ok) {
    console.error('시크릿 자동 갱신 실패:', await putRes.text());
  } else {
    console.log(`GitHub Secret [${name}] 갱신 완료`);
  }
}

async function main() {
  console.log('액세스 토큰 갱신 중...');
  const tokenData = await refreshAccessToken();
  console.log('토큰 갱신 완료. scope:', tokenData.scope);

  console.log('전체 상품 조회 중...');
  const rawProducts = await fetchAllProducts(tokenData.accessToken);
  console.log(`총 ${rawProducts.length}개 상품 조회 완료`);

  const products = rawProducts
    .map(p => {
      const parsed = parseTitle(p.name);
      return {
        idx: p.prodNo,
        name: p.name,
        price: p.price,
        oldPrice: p.priceOrg,
        img: (p.productImages && p.productImages[0]) || '',
        href: `${SHOP_PATH}?idx=${p.prodNo}`,
        ...(parsed || {})
      };
    })
    .filter(p => p.width); // 사이즈 파싱 실패한 상품은 필터 데이터에서 제외

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(products, null, 2), 'utf-8');
  console.log(`저장 완료: ${OUTPUT_FILE} (${products.length}개 필터링 가능 상품)`);

  // 다음 실행을 위해 새로 발급된 refreshToken을 GitHub Secrets에 반영 시도
  if (tokenData.refreshToken && tokenData.refreshToken !== REFRESH_TOKEN) {
    await updateGithubSecret('IMWEB_REFRESH_TOKEN', tokenData.refreshToken);
  }
}

main().catch(err => {
  console.error('동기화 실패:', err);
  process.exit(1);
});
