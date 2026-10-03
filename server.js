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
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${SEMANTIC_SCHOLAR_FIELDS}`;

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
    // 주의: 'gemini-2.5-flash'는 2026-10월부로 신규 사용자에게 404(모델 폐기)를 반환한다.
    // Gemini API가 에러 메시지에서 직접 안내한 최신 모델명으로 교체함 — 모델이 다시 바뀌면
    // Render 로그의 404 에러 메시지에 적힌 권장 모델명으로 다시 교체하면 된다.
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
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

/**
 * ---------------------------------------------------------------------------
 * 크롬 확장 프로그램 연동 — DBpia/RISS/Google Scholar 등에서 DOI/URL/제목을 보내면
 * 서버가 논문 메타데이터를 조회해서 "가져오기 대기함(pending_imports)"에 저장해두는 방식입니다.
 *
 * 왜 곧바로 화면에 노드로 추가되지 않고 "대기함"을 거치나요?
 * PaperPulse는 이 서버에 서재(library) 데이터를 저장하지 않습니다 — 서재는 각 사용자의
 * 브라우저 localStorage에만 있습니다. 그래서 확장 프로그램이 서버로 보낸 요청은
 * "지금 열려 있는 특정 탭"에 실시간으로 꽂아 넣을 방법이 없습니다(웹소켓/실시간 채널이 없음).
 * 대신 이 서버는 요청을 큐에 쌓아두고, paperpulse.html이 로그인 상태로 열려 있을 때
 * 주기적으로(약 25초마다) + 창이 다시 포커스될 때 이 큐를 확인해서 자동으로 서재에 반영합니다.
 * → 실시간은 아니지만 "탭이 열려 있으면 몇십 초 안에 자동 반영"되는 실용적인 절충안입니다.
 *   진짜 즉시 반영이 필요하면 나중에 Supabase Realtime(웹소켓)으로 업그레이드할 수 있습니다.
 *
 * DOI/URL 해석 범위:
 * - doi가 오면: Semantic Scholar → 실패 시 CrossRef 순으로 조회 (국내 학술지도 DOI가 있으면 대부분 커버)
 * - doi 없이 title만 오면: Semantic Scholar 제목 검색 결과 1건(최선 추정치, 부정확할 수 있음)
 * - RISS/DBpia처럼 DOI가 없는 국내 자료의 '순수 URL만'으로는 정확한 메타데이터를 보장할 수 없습니다
 *   (해당 사이트들은 Semantic Scholar/CrossRef에 URL로 색인되어 있지 않음) — 확장 프로그램 쪽에서
 *   가능하면 페이지에서 DOI 또는 제목을 함께 추출해서 보내주는 걸 권장합니다.
 * ---------------------------------------------------------------------------
 */
const EXTERNAL_IMPORT_FIELDS = 'title,year,authors,venue,citationCount,abstract,tldr,fieldsOfStudy,externalIds,openAccessPdf,url';

function mapS2ToImportPayload(raw) {
  const authorsList = (raw.authors || []).map((a) => a.name).filter(Boolean);
  const authorsStr = authorsList.length ? (authorsList.slice(0, 4).join(', ') + (authorsList.length > 4 ? ' 외' : '')) : '저자 정보 없음';
  const tags = (raw.fieldsOfStudy && raw.fieldsOfStudy.length) ? raw.fieldsOfStudy.slice(0, 4) : (raw.venue ? [raw.venue] : ['미분류']);
  const abstract = raw.abstract || '';
  return {
    id: raw.paperId,
    title: raw.title || '(제목 정보 없음)',
    authors: authorsStr,
    journal: raw.venue || '학술지 정보 없음',
    year: raw.year || null,
    citations: typeof raw.citationCount === 'number' ? raw.citationCount : 0,
    tldr: (raw.tldr && raw.tldr.text) || (abstract ? (abstract.length > 220 ? abstract.slice(0, 220) + '...' : abstract) : '크롬 확장 프로그램으로 가져온 논문입니다.'),
    abstract,
    tags,
    methods: '',
    doi: raw.externalIds && raw.externalIds.DOI ? raw.externalIds.DOI : null,
    pdfUrl: raw.openAccessPdf && raw.openAccessPdf.url ? raw.openAccessPdf.url : null,
    sourceUrl: raw.url || null,
    saved: true,
    collection: null,
  };
}
function mapCrossrefToImportPayload(item) {
  const authorsList = (item.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean);
  const authorsStr = authorsList.length ? (authorsList.slice(0, 4).join(', ') + (authorsList.length > 4 ? ' 외' : '')) : '저자 정보 없음';
  const title = Array.isArray(item.title) && item.title.length ? item.title[0] : '(제목 정보 없음)';
  const journal = Array.isArray(item['container-title']) && item['container-title'].length ? item['container-title'][0] : '';
  const year = (item['published-print']?.['date-parts']?.[0]?.[0]) || (item['published-online']?.['date-parts']?.[0]?.[0]) || (item.issued?.['date-parts']?.[0]?.[0]) || null;
  return {
    id: `crossref-${item.DOI}`,
    title,
    authors: authorsStr,
    journal: journal || '학술지 정보 없음',
    year,
    citations: typeof item['is-referenced-by-count'] === 'number' ? item['is-referenced-by-count'] : 0,
    tldr: '크롬 확장 프로그램으로 가져온 논문입니다. (DOI 등록 정보 기반)',
    abstract: '',
    tags: journal ? [journal] : ['미분류'],
    methods: '',
    doi: item.DOI || null,
    pdfUrl: null,
    sourceUrl: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : null),
    saved: true,
    collection: null,
  };
}

async function resolveExternalPaper({ doi, url, title }) {
  if (doi) {
    try {
      const s2Res = await fetch(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=${EXTERNAL_IMPORT_FIELDS}`);
      if (s2Res.ok) return mapS2ToImportPayload(await s2Res.json());
    } catch (e) { /* 다음 방법으로 폴백 */ }
    try {
      const crRes = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
      if (crRes.ok) {
        const crData = await crRes.json();
        if (crData.message) return mapCrossrefToImportPayload(crData.message);
      }
    } catch (e) { /* 아래에서 최종 실패 처리 */ }
  }
  if (title) {
    try {
      const s2Res = await fetch(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=${EXTERNAL_IMPORT_FIELDS}`);
      if (s2Res.ok) {
        const data = await s2Res.json();
        if (data.data && data.data[0]) return mapS2ToImportPayload(data.data[0]);
      }
    } catch (e) { /* 실패 시 아래에서 처리 */ }
  }
  return null;
}

/**
 * [POST] /api/papers/external-import
 * 크롬 확장 프로그램이 호출. Authorization: Bearer <로그인한 사용자의 Supabase access token>
 * body: { doi?: string, url?: string, title?: string }  — doi 또는 title 중 최소 하나 필요
 */
app.post('/api/papers/external-import', requireAuth, async (req, res) => {
  try {
    const { doi, url, title } = req.body || {};
    if (!doi && !title) {
      return res.status(400).json({ success: false, error: 'doi 또는 title 중 하나는 반드시 필요합니다. (URL만으로는 국내 학술 사이트 특성상 정확한 조회가 어려워요)' });
    }
    const payload = await resolveExternalPaper({ doi, url, title });
    if (!payload) {
      return res.status(404).json({ success: false, error: '해당 논문 정보를 찾지 못했습니다. DOI를 함께 보내면 훨씬 정확해요.' });
    }
    if (url && !payload.sourceUrl) payload.sourceUrl = url;

    const { data, error } = await supabaseAdmin
      .from('pending_imports')
      .insert({ user_id: req.user.id, payload, source_url: url || null })
      .select()
      .single();
    if (error) throw error;

    return res.json({ success: true, message: 'PaperPulse 앱이 열려 있으면 잠시 후 서재에 자동으로 추가됩니다.', item: data });
  } catch (error) {
    console.error('외부 논문 가져오기 에러:', error.message);
    return res.status(500).json({ success: false, error: '논문 정보를 가져오는 중 서버 오류가 발생했습니다.' });
  }
});

/**
 * [GET] /api/papers/pending-imports
 * paperpulse.html이 로그인 상태에서 주기적으로 호출해서, 확장 프로그램이 쌓아둔
 * 미처리 항목을 가져갑니다. 소비(ack) 전까지는 계속 다시 조회될 수 있습니다.
 */
app.get('/api/papers/pending-imports', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('pending_imports')
      .select('id, payload, created_at')
      .eq('user_id', req.user.id)
      .eq('consumed', false)
      .order('created_at', { ascending: true })
      .limit(50);
    if (error) throw error;
    return res.json({ success: true, items: data || [] });
  } catch (error) {
    console.error('가져오기 대기함 조회 에러:', error.message);
    return res.status(500).json({ success: false, error: '대기 중인 항목을 조회하지 못했습니다.' });
  }
});

/**
 * [POST] /api/papers/pending-imports/ack
 * 프론트엔드가 위 목록을 실제로 서재에 반영한 뒤 호출 — 처리 완료 표시(consumed=true)를 남겨서
 * 다음 조회 때 같은 항목이 중복으로 다시 추가되지 않게 합니다.
 * body: { ids: string[] }
 */
app.post('/api/papers/pending-imports/ack', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.json({ success: true });
    const { error } = await supabaseAdmin
      .from('pending_imports')
      .update({ consumed: true })
      .eq('user_id', req.user.id)
      .in('id', ids);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error('가져오기 대기함 처리완료 표시 에러:', error.message);
    return res.status(500).json({ success: false, error: '처리 완료 표시에 실패했습니다.' });
  }
});

app.listen(PORT, () => {
  console.log(`PaperPulse AI API 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
