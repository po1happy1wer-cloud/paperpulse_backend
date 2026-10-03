import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

if (!process.env.GEMINI_API_KEY) {
  console.warn('[경고] .env 파일에 GEMINI_API_KEY가 설정되어 있지 않습니다. .env.example을 복사해서 .env를 만들고 키를 입력하세요.');
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[경고] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY가 설정되어 있지 않습니다. 로그인/결제 기능이 동작하지 않습니다.');
}

// 미들웨어 설정
app.use(cors()); // 프론트엔드(paperpulse.html)와의 통신 허용
app.use(express.json());

// Google Gen AI SDK 초기화 (서버 환경변수에서만 키를 읽음 — 브라우저에는 절대 전달되지 않음)
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// Supabase 관리자(service_role) 클라이언트 — DB의 credits/is_subscribed는 이 키로만 갱신합니다.
// service_role 키는 RLS를 모두 우회하므로 절대 프론트엔드에 노출하면 안 됩니다.
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 요금제: 클라이언트가 보낸 금액을 그대로 믿지 않고, 서버가 정한 값만 인정합니다.
const PRICE_PLANS = {
  pro_monthly: 9900,
};

/**
 * 인증 미들웨어: 프론트엔드가 보낸 Supabase 액세스 토큰(Authorization: Bearer <token>)을
 * 검증해서 req.user에 유저 정보를 담습니다.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ success: false, error: '유효하지 않은 로그인 정보입니다.' });

    req.user = data.user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: '인증 처리 중 오류가 발생했습니다.' });
  }
}

/**
 * [GET] /health - 서버가 켜져 있는지 확인용
 */
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Semantic Scholar 논문 검색에서 요청할 필드 (필요한 것만 받아 응답 속도를 높임)
const SEMANTIC_SCHOLAR_FIELDS = 'title,year,authors,venue,citationCount,abstract,tldr,fieldsOfStudy,externalIds,openAccessPdf,url';

/**
 * [GET] /api/search-papers?query=...&limit=20
 * 프론트엔드가 브라우저에서 Semantic Scholar API를 직접 호출하지 못하는 경우
 * (사내망/보안 프로그램이 막는 경우 등)를 위한 대체 경로입니다.
 * 로그인이나 크레딧 없이 누구나 호출할 수 있습니다 (논문 검색 자체는 무료 기능).
 */
app.get('/api/search-papers', async (req, res) => {
  try {
    const query = (req.query.query || '').toString().trim();
    if (!query) {
      return res.status(400).json({ success: false, error: '검색어를 입력해 주세요.' });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}&fields=${SEMANTIC_SCHOLAR_FIELDS}`;

    // SEMANTIC_SCHOLAR_API_KEY는 선택 사항입니다. 없어도 동작하지만(비인증 요청),
    // 있으면 더 넉넉한 속도 제한을 받습니다. https://www.semanticscholar.org/product/api 에서 무료 발급.
    const headers = process.env.SEMANTIC_SCHOLAR_API_KEY ? { 'x-api-key': process.env.SEMANTIC_SCHOLAR_API_KEY } : {};

    const s2Res = await fetch(url, { headers });
    if (!s2Res.ok) {
      const detail = await s2Res.text().catch(() => '');
      return res.status(s2Res.status).json({ success: false, error: `Semantic Scholar API 오류 (${s2Res.status})`, detail: detail.slice(0, 300) });
    }
    const data = await s2Res.json();
    return res.json({ success: true, data: data.data || [] });
  } catch (error) {
    console.error('논문 검색 프록시 에러:', error);
    return res.status(500).json({ success: false, error: '논문 검색 처리 중 서버 오류가 발생했습니다.' });
  }
});

// HTML 엔티티(&amp; &quot; &#39; 등)를 사람이 읽는 문자로 되돌림 — og:title 등에 흔히 포함됨
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .trim();
}
// <meta property="og:title" content="..."> 형태(속성 순서가 반대인 경우도) 하나를 읽어온다
function extractMetaContent(html, key) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtmlEntities(m[1]);
  }
  return null;
}
// citation_author처럼 같은 메타태그가 여러 개 반복될 수 있는 경우, 전부 모아서 쉼표로 합친다
function extractMetaContentAll(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(decodeHtmlEntities(m[1]));
  return out;
}
// 사설(private)/루프백 주소로 보이는 호스트명을 간단히 걸러내는 최소한의 SSRF 방어 (완벽하지 않음, 1차 방어선)
function looksLikePrivateHost(hostname) {
  const h = (hostname || '').toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  return false;
}

/**
 * [GET] /api/fetch-url-metadata?url=...
 * "URL로 논문/아티클 등록" 기능용 — 브라우저는 CORS 때문에 다른 사이트의 HTML을 직접 읽을 수 없으므로,
 * 서버가 대신 그 페이지를 가져와 Open Graph(og:title 등)와 학술 메타태그(citation_title 등)만 뽑아 돌려준다.
 * 로그인/크레딧 없이 누구나 호출 가능 (논문 검색 프록시와 동일한 성격의 "순수 조회" 기능).
 */
app.get('/api/fetch-url-metadata', async (req, res) => {
  const rawUrl = (req.query.url || '').toString().trim();
  let target;
  try {
    target = new URL(rawUrl);
  } catch (e) {
    return res.status(400).json({ success: false, error: '올바른 URL 형식이 아닙니다.' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return res.status(400).json({ success: false, error: 'http:// 또는 https:// 주소만 지원합니다.' });
  }
  if (looksLikePrivateHost(target.hostname)) {
    return res.status(400).json({ success: false, error: '허용되지 않는 주소입니다.' });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const pageRes = await fetch(target.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // 일부 사이트는 기본 서버 User-Agent(예: node-fetch) 요청을 차단하므로, 일반 브라우저처럼 보이게 함
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!pageRes.ok) {
      return res.status(502).json({ success: false, error: `페이지를 불러오지 못했습니다 (HTTP ${pageRes.status}).` });
    }
    const contentType = pageRes.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return res.status(415).json({ success: false, error: '이 주소는 웹페이지(HTML)가 아니에요.' });
    }
    // 메타 태그는 보통 <head> 안, 즉 문서 앞부분에 있으므로 앞 300KB만 읽어도 충분 — 대용량 페이지의 불필요한 파싱을 막는다
    const fullText = await pageRes.text();
    const html = fullText.slice(0, 300000);

    const ogTitle = extractMetaContent(html, 'og:title');
    const citationTitle = extractMetaContent(html, 'citation_title');
    const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);

    const authorsFromCitation = extractMetaContentAll(html, 'citation_author').filter(Boolean);
    const ogSiteName = extractMetaContent(html, 'og:site_name');
    const metaAuthor = extractMetaContent(html, 'author');

    const ogDescription = extractMetaContent(html, 'og:description');
    const metaDescription = extractMetaContent(html, 'description');

    const title = citationTitle || ogTitle || (titleTagMatch ? decodeHtmlEntities(titleTagMatch[1]) : null);
    const authors = authorsFromCitation.length ? authorsFromCitation.join(', ') : (metaAuthor || ogSiteName || null);
    const description = ogDescription || metaDescription || null;
    const journal = extractMetaContent(html, 'citation_journal_title') || ogSiteName || null;
    const year = (() => {
      const d = extractMetaContent(html, 'citation_publication_date') || extractMetaContent(html, 'citation_date') || extractMetaContent(html, 'article:published_time');
      const m = (d || '').match(/\d{4}/);
      return m ? Number(m[0]) : null;
    })();

    if (!title) {
      return res.status(422).json({ success: false, error: '이 페이지에서 제목 정보를 찾을 수 없어요.' });
    }
    return res.json({ success: true, data: { title, authors, description, journal, year, url: target.toString() } });
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    console.error('URL 메타데이터 추출 에러:', error);
    return res.status(timedOut ? 504 : 500).json({ success: false, error: timedOut ? '페이지 응답이 너무 느려요.' : '웹페이지 정보를 불러오는 중 오류가 발생했습니다.' });
  } finally {
    clearTimeout(timeout);
  }
});

/**
 * [POST] /api/analyze-library
 * 로그인한 사용자만 호출 가능. 구독자가 아니면 남은 무료 크레딧을 차감합니다.
 * body: { library: Array<{title, authors, journal, category, methodology, tldr}>, userQuery: string }
 */
app.post('/api/analyze-library', requireAuth, async (req, res) => {
  try {
    const { library, userQuery } = req.body;

    if (!userQuery) {
      return res.status(400).json({ success: false, error: '질문 내용을 입력해 주세요.' });
    }
    if (!library || library.length === 0) {
      return res.status(400).json({ success: false, error: '서재에 분석할 논문이 없습니다.' });
    }

    // 구독/크레딧 확인
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('is_subscribed, credits')
      .eq('id', req.user.id)
      .single();
    if (profileErr || !profile) {
      return res.status(404).json({ success: false, error: '프로필 정보를 찾을 수 없습니다.' });
    }
    if (!profile.is_subscribed && profile.credits <= 0) {
      return res.status(402).json({ success: false, error: 'NO_CREDITS', message: '무료 체험 크레딧을 모두 사용했습니다. Pro 플랜을 구독하면 무제한으로 이용할 수 있어요.' });
    }

    // 1. 논문 목록을 프롬프트용 맥락(Context) 텍스트로 조립
    const libraryContext = library
      .map(
        (paper, idx) =>
          `[논문 ${idx + 1}]\n` +
          `- 제목: ${paper.title || ''}\n` +
          `- 저자/학술지: ${paper.authors || ''} (${paper.journal || ''})\n` +
          `- 카테고리/방법론: ${paper.category || ''} / ${paper.methodology || ''}\n` +
          `- TL;DR 요약: ${paper.tldr || ''}\n`
      )
      .join('\n');

    // 2. 최종 프롬프트 구성
    const prompt = `
당신은 연구자의 논문 서재 데이터 기반 분석을 돕는 전문 AI 학술 비서입니다.
아래는 연구자가 자신의 '스마트 서재'에 저장한 논문 목록입니다.

---
[연구자의 서재 논문 목록]
${libraryContext}
---

사용자 질문: "${userQuery}"

[답변 작성 지침]
1. 위 서재에 명시된 논문 정보에 근거하여 사용자 질문에 명확하고 객관적으로 답변하세요.
2. 여러 논문 간의 공통점, 차이점, 연구 방법론적 특징을 명확히 비교 정리해 주세요.
3. 근거로 사용한 논문은 [논문 N] 형식으로 표시해 주세요.
4. 가독성을 위해 마크다운(Markdown) 개조식 형식으로 보기 쉽게 작성해 주세요.
`;

    // 3. Gemini 모델 호출
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    // 비구독자는 크레딧 1 차감 (RPC — service_role로만 실행 가능)
    let remainingCredits = profile.credits;
    if (!profile.is_subscribed) {
      const { data: remaining, error: rpcErr } = await supabaseAdmin.rpc('decrement_credit', { uid: req.user.id });
      if (!rpcErr) remainingCredits = remaining;
    }

    // 4. 분석 결과를 프론트엔드로 안전하게 반환 (API 키는 절대 포함하지 않음)
    return res.json({
      success: true,
      result: response.text,
      remainingCredits: profile.is_subscribed ? null : remainingCredits,
    });
  } catch (error) {
    console.error('Gemini API 서버 에러:', error);
    return res.status(500).json({
      success: false,
      error: 'AI 분석 처리 중 서버 오류가 발생했습니다.',
    });
  }
});

/**
 * [POST] /api/payments/complete
 * 프론트엔드가 결제창 완료 직후 호출. 포트원 서버에서 실제 결제 정보를 다시 조회해
 * 위변조 여부를 검증한 뒤 구독 상태를 갱신합니다.
 *
 * 주의: 이 방식은 "사용자가 결제 후 브라우저를 끄지 않았을 때"만 동작합니다.
 * 프로덕션에서는 포트원 웹훅(아래 /api/payments/webhook)을 결제 확정의
 * 최종 소스로 삼고, 이 라우트는 화면에 빠르게 결과를 보여주는 용도로만 쓰세요.
 */
app.post('/api/payments/complete', requireAuth, async (req, res) => {
  try {
    const { paymentId, planId } = req.body;
    const expectedAmount = PRICE_PLANS[planId];
    if (!paymentId || !expectedAmount) {
      return res.status(400).json({ success: false, error: '결제 정보가 올바르지 않습니다.' });
    }

    // 0. 이 결제건(paymentId)을 먼저 선점합니다. payment_id가 PK라서, 이미 다른 요청이
    //    (같은 유저의 중복 클릭이든, 다른 유저의 재사용 시도든) 먼저 처리했다면 여기서 막힙니다.
    const { error: claimErr } = await supabaseAdmin
      .from('payments')
      .insert({ payment_id: paymentId, user_id: req.user.id, plan_id: planId, amount: expectedAmount });
    if (claimErr) {
      return res.status(409).json({ success: false, error: '이미 처리되었거나 다른 계정에서 사용된 결제건입니다.' });
    }

    // 1. 포트원 서버에 결제 정보 단건 조회 (클라이언트가 보낸 금액을 그대로 믿지 않음)
    const portoneRes = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `PortOne ${process.env.PORTONE_API_SECRET}` },
    });
    if (!portoneRes.ok) throw new Error('포트원 결제 정보 조회에 실패했습니다.');
    const paymentData = await portoneRes.json();

    // 2. 결제 상태 + 금액이 서버가 정한 요금제 가격과 정확히 일치하는지 검증
    if (paymentData.status === 'PAID' && paymentData.amount?.total === expectedAmount) {
      const { error: dbError } = await supabaseAdmin
        .from('profiles')
        .update({ is_subscribed: true })
        .eq('id', req.user.id);
      if (dbError) throw dbError;
      return res.json({ success: true, message: '결제 검증 및 구독 처리 완료' });
    }

    // 검증 실패 — 선점해둔 결제건 기록을 되돌려서 나중에 다시 시도할 수 있게 합니다.
    await supabaseAdmin.from('payments').delete().eq('payment_id', paymentId);
    return res.status(400).json({ success: false, error: '유효하지 않은 결제 정보입니다.' });
  } catch (error) {
    console.error('결제 검증 에러:', error.message);
    return res.status(500).json({ success: false, error: '결제 검증 처리 중 서버 오류가 발생했습니다.' });
  }
});

/**
 * [POST] /api/payments/webhook
 * 포트원이 결제 상태 변경 시 서버 대 서버로 직접 호출하는 엔드포인트.
 * 사용자가 결제 후 창을 닫아버려도 구독 처리가 누락되지 않도록 하는 안전망입니다.
 * 포트원 대시보드 > 웹훅 설정에서 이 URL(예: https://your-domain.com/api/payments/webhook)을 등록하세요.
 * TODO: 실서비스 전환 시 포트원 문서에 따라 PORTONE_WEBHOOK_SECRET으로 서명을 검증하는 로직을 추가하세요.
 */
app.post('/api/payments/webhook', async (req, res) => {
  try {
    const { paymentId } = req.body || {};
    if (!paymentId) return res.status(400).json({ success: false });

    const portoneRes = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `PortOne ${process.env.PORTONE_API_SECRET}` },
    });
    const paymentData = await portoneRes.json();
    const userId = paymentData?.customer?.id; // 결제 요청 시 customer.id에 supabase user id를 담아 보내야 합니다.

    if (paymentData.status === 'PAID' && userId) {
      await supabaseAdmin.from('profiles').update({ is_subscribed: true }).eq('id', userId);
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('웹훅 처리 에러:', error.message);
    return res.status(500).json({ success: false });
  }
});

app.listen(PORT, () => {
  console.log(`PaperPulse AI API 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
