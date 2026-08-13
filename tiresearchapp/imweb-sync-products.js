/**
 * ============================================================================
 * 아임웹 Open API로 전체 상품을 긁어와 products.json 파일로 저장하는 스크립트
 * ============================================================================
 * 이 스크립트는 "브라우저"가 아니라 Node.js 환경(서버, GitHub Actions 등)에서
 * 주기적으로 실행하는 용도입니다. API_KEY / API_SECRET은 절대 브라우저 코드나
 * 공개 저장소에 그대로 커밋하지 마세요. (환경변수로 주입하세요)
 *
 * ▶ 준비물
 * 1. 아임웹 개발자센터(https://developers-docs.imweb.me) 에서 앱 등록 후
 *    API_KEY / API_SECRET 발급
 * 2. Node.js 18 이상 (fetch 내장) — 그보다 낮으면 node-fetch 설치 필요
 *
 * ▶ 실행 방법
 *   IMWEB_API_KEY=xxx IMWEB_API_SECRET=yyy node imweb-sync-products.js
 *
 * ▶ 실제 응답 구조 관련 주의
 * 아래 코드의 응답 파싱 부분(파일 하단 // TODO 표시)은 아임웹 개발자문서의
 * "상품 조회 - GET /v2/shop/products" 응답 스펙을 기준으로 실제 호출 결과를
 * 한 번 콘솔에 찍어보고(console.log(JSON.stringify(res,null,2))) 필드명을
 * 맞춰주셔야 합니다. API 응답 필드명은 문서 버전에 따라 달라질 수 있습니다.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const API_KEY    = process.env.IMWEB_API_KEY;
const API_SECRET = process.env.IMWEB_API_SECRET;
const OUTPUT_FILE = path.join(__dirname, 'products.json');

if (!API_KEY || !API_SECRET) {
  console.error('IMWEB_API_KEY / IMWEB_API_SECRET 환경변수가 필요합니다.');
  process.exit(1);
}

async function getAccessToken() {
  const res = await fetch('https://api.imweb.me/v2/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: API_KEY, secret: API_SECRET })
  });
  if (!res.ok) throw new Error('인증 실패: ' + res.status + ' ' + await res.text());
  const data = await res.json();
  // TODO: 실제 응답 구조 확인 후 아래 경로 수정 (예상: data.access_token 또는 data.data.access_token)
  const token = data.access_token || (data.data && data.data.access_token);
  if (!token) throw new Error('access_token을 응답에서 찾지 못했습니다: ' + JSON.stringify(data));
  return token;
}

async function fetchAllProducts(token) {
  const all = [];
  let page = 1;
  const limit = 100; // 한 번에 가져올 개수 (문서의 최대 허용치로 조정)

  while (true) {
    const url = `https://api.imweb.me/v2/shop/products?page=${page}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { 'access-token': token, 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error('상품 조회 실패: ' + res.status + ' ' + await res.text());
    const body = await res.json();

    // TODO: 실제 응답 구조에 맞춰 리스트 경로 / 총 페이지(또는 총 개수) 경로 수정
    const list = body.data?.list || body.list || [];
    const totalCount = body.data?.total_count ?? body.total_count ?? null;

    if (!list.length) break;
    all.push(...list);

    console.log(`page ${page} 완료 (누적 ${all.length}개)`);

    if (totalCount !== null && all.length >= totalCount) break;
    if (list.length < limit) break; // 마지막 페이지로 판단
    page++;

    await sleep(300); // API 호출 제한(rate limit) 대비 간단한 딜레이
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

async function main() {
  console.log('아임웹 인증 중...');
  const token = await getAccessToken();

  console.log('전체 상품 조회 중...');
  const rawProducts = await fetchAllProducts(token);
  console.log(`총 ${rawProducts.length}개 상품 조회 완료`);

  const products = rawProducts
    .map(p => {
      // TODO: 실제 응답 필드명에 맞춰 매핑 수정
      const name  = p.name || p.prod_name || '';
      const idx   = p.prod_no || p.code || p.idx;
      const price = p.price ?? p.sell_price ?? 0;
      const image = (p.images && p.images[0] && p.images[0].url) || p.image_url || '';
      const parsed = parseTitle(name);

      return {
        idx,
        name,
        price,
        img: image,
        href: `/15/?idx=${idx}`, // 실제 상품목록 페이지 경로에 맞게 수정
        ...(parsed || {})
      };
    })
    .filter(p => p.width); // 사이즈 파싱에 실패한 상품은 필터 데이터에서 제외

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(products, null, 2), 'utf-8');
  console.log(`저장 완료: ${OUTPUT_FILE} (${products.length}개 필터링 가능 상품)`);
}

main().catch(err => {
  console.error('동기화 실패:', err);
  process.exit(1);
});
