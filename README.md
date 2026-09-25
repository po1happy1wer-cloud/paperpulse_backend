# PaperPulse Backend

`paperpulse.html`이 브라우저에 비밀 키(Gemini API 키, Supabase service_role 키, 포트원 API 시크릿)를 노출하지 않고
AI 분석 · 로그인 · 결제 기능을 쓸 수 있게 해주는 백엔드 서버입니다.

## 0. 최소 구성으로 시작하기 (로그인/결제 없이 AI 요약만)

로그인·결제 없이 AI 요약 기능만 써보고 싶다면 아래 1~2, 4만 하고 바로 실행해도 됩니다.
(`paperpulse.html`도 Supabase 설정을 비워두면 로그인 요구 없이 그대로 동작합니다.)

## 1. 패키지 설치

```bash
npm install
```

## 2. 환경변수 설정 (.env)

```bash
cp .env.example .env
```

`.env`를 열어 아래 값을 채웁니다.

| 변수 | 어디서 발급하나요 | 필수 여부 |
|---|---|---|
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) | AI 요약 기능에 필수 |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase 대시보드 → Project Settings → API | 로그인/구독 기능을 쓸 때만 필수 |
| `PORTONE_API_SECRET` | 포트원 대시보드 → 결제 연동 → API Secret | 결제 기능을 쓸 때만 필수 |
| `PORTONE_WEBHOOK_SECRET` | 포트원 대시보드 → 웹훅 설정 | 웹훅 서명 검증용 (선택, 실서비스 권장) |
| `SEMANTIC_SCHOLAR_API_KEY` | [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api) | 선택 — 없어도 논문 검색은 동작합니다 |

## 3. Supabase 프로젝트 세팅 (로그인/결제를 쓸 경우)

1. [supabase.com](https://supabase.com)에서 새 프로젝트를 만듭니다.
2. **Authentication → Providers**에서 Google 로그인을 켜고 클라이언트 ID/Secret을 등록합니다.
3. **SQL Editor**를 열어 이 폴더의 `supabase.sql` 파일 내용을 그대로 붙여넣고 실행합니다.
   - `profiles` 테이블(구독 여부·무료 크레딧), 가입 시 자동 생성 트리거, RLS 정책, 크레딧 차감 함수, `payments` 테이블(결제 재사용 방지)까지 한 번에 생성됩니다.
4. **Project Settings → API**에서 `URL`과 `anon public` 키를 확인해 `paperpulse.html` 상단의 `CONFIG.SUPABASE_URL` / `CONFIG.SUPABASE_ANON_KEY`에 넣습니다. (`service_role` 키는 절대 프론트엔드에 넣지 말고 `.env`에만 넣습니다.)

## 4. 포트원(결제) 세팅 (결제를 쓸 경우)

1. [portone.io](https://portone.io) 대시보드에서 상점을 만들고 카카오페이/카드 등 결제 채널을 연동합니다.
2. Store ID, Channel Key를 확인해 `paperpulse.html`의 `CONFIG.PORTONE_STORE_ID` / `CONFIG.PORTONE_CHANNEL_KEY`에 넣습니다.
3. API Secret은 `.env`의 `PORTONE_API_SECRET`에 넣습니다.
4. (권장) 포트원 대시보드 → 웹훅 설정에서 `https://your-domain.com/api/payments/webhook`을 등록해 두면, 결제 후 사용자가 창을 꺼버려도 구독 처리가 누락되지 않습니다.

## 5. `paperpulse.html`의 CONFIG 값 채우기

`paperpulse.html` 파일을 열어 `const CONFIG = { ... }` 부분을 본인 값으로 바꿉니다.

```js
const CONFIG = {
  SUPABASE_URL: 'https://xxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJ...',        // anon public 키 (공개되어도 안전한 키입니다)
  PORTONE_STORE_ID: 'store-...',
  PORTONE_CHANNEL_KEY: 'channel-key-...',
  PLAN_ID: 'pro_monthly',
  PRICE_KRW: 9900,
  BACKEND_ORIGIN: 'http://localhost:5000',
};
```

값을 비워두면(`YOUR_SUPABASE_URL` 그대로) 로그인/결제 UI가 자동으로 숨겨지고, AI 요약 기능은 기존처럼 동작합니다.

## 6. 서버 실행

```bash
npm start
```

`PaperPulse AI API 서버가 http://localhost:5000 에서 실행 중입니다.` 메시지가 뜨면 준비 완료입니다.

## 7. 확인

1. `paperpulse.html`을 브라우저로 엽니다.
2. 오른쪽 위 **로그인** → 구글 로그인 → 서재에 논문을 몇 개 저장 → **AI 논문 분석 비서**에게 질문.
3. 무료 크레딧(기본 3회)을 다 쓰면 **업그레이드** 버튼으로 결제 테스트를 해볼 수 있습니다 (포트원 테스트 채널 사용 권장).

## 보안 체크리스트

- `.env` 파일(과 그 안의 모든 키)은 절대 Git에 올리지 마세요.
- `SUPABASE_SERVICE_ROLE_KEY`, `PORTONE_API_SECRET`은 **서버(.env)에만** 두고, `paperpulse.html`에는 절대 넣지 마세요.
- `credits`/`is_subscribed`는 프론트엔드가 아니라 백엔드(`server.js`)의 service_role 키로만 변경됩니다 — `supabase.sql`의 RLS/권한 설정을 그대로 유지하세요.
- 결제 검증은 클라이언트가 보낸 금액이 아니라 **포트원 서버에서 다시 조회한 금액**을 기준으로 하고, 같은 결제건이 재사용되지 않도록 `payments` 테이블로 막습니다.
- 이 서버는 개인/소규모 사용을 기준으로 만들어졌습니다. 여러 서버 인스턴스로 배포하거나 트래픽이 늘어나면 요청 제한(rate limit), 로깅, 웹훅 서명 검증 등을 추가로 고려하세요.

## 논문 검색 (Semantic Scholar)

`paperpulse.html`의 검색창은 기본적으로 브라우저에서 Semantic Scholar API(`api.semanticscholar.org`)를 **직접** 호출합니다 — 무료, 로그인/키 없이 동작하고, 이 백엔드가 꺼져 있어도 검색은 됩니다.

다만 회사 네트워크의 보안 프로그램이나 방화벽이 외부 API 직접 호출을 막는 경우가 있는데, 이럴 때를 위해 이 서버에 같은 기능을 하는 대체 경로 `GET /api/search-papers?query=...`를 만들어 뒀습니다. 브라우저 직접 호출이 실패하면 `paperpulse.html`이 자동으로 이 경로로 재시도합니다(별도 설정 불필요, 서버가 켜져 있기만 하면 됩니다).

검색 자체는 무료 기능이라 로그인이나 크레딧 확인 없이 누구나 호출할 수 있게 열어뒀습니다.

## 국내 학술 사이트 바로가기 버튼

Semantic Scholar는 해외 논문 위주라 국내(한국어) 논문이 잘 안 잡히는 경우가 많습니다. 그래서 검색 화면 상단과 논문 상세 화면에 **구글 스칼라 / RISS / DBpia / 네이버 학술정보 / ScienceON(KISTI) / KCI** 6개 사이트로 바로 검색해서 이동하는 버튼을 추가해 뒀습니다. 검색어(또는 논문 제목)를 입력한 상태에서 버튼을 누르면 해당 사이트의 검색 결과 화면으로 새 탭이 열립니다.

- KCI만 사이트 자체의 정책상 검색어를 URL에 미리 채워 넣는 방식(딥링크)이 지원되지 않아, 버튼을 누르면 검색 홈으로 이동합니다. 이동 후 같은 검색어를 KCI 검색창에 다시 입력해 주세요.
- 이 버튼들은 별도 설정 없이 바로 동작합니다. (`paperpulse.html`의 `KOREAN_SITES` 배열을 수정하면 사이트를 추가/변경할 수 있습니다.)

## 피드백 / A/S 문의 (오른쪽 아래 "피드백 · 문의" 버튼)

사용자가 오류 제보, 기능 제안 등을 쪽지처럼 편하게 남길 수 있는 기능입니다. 두 가지 방식으로 동작합니다.

1. **Supabase가 연동되어 있으면** → `feedback` 테이블에 저장됩니다. (`supabase.sql`에 테이블/정책이 포함되어 있으니, 위 3번 단계에서 SQL을 실행했다면 이미 준비된 상태입니다.) 내용 확인은 Supabase 대시보드 → Table Editor → `feedback` 테이블에서 하면 됩니다.
2. **Supabase가 아직 연동되어 있지 않으면** → `paperpulse.html` 상단 `CONFIG.FEEDBACK_EMAIL`에 본인 이메일 주소를 넣어주세요. 넣어두면 사용자가 "보내기"를 눌렀을 때 사용자의 이메일 앱이 열리며 내용이 자동으로 채워집니다. (`YOUR_EMAIL@example.com`으로 비워두면 알림 메시지만 뜨고 전송되지 않습니다.)

## 내 컴퓨터의 PDF 파일을 서재에 저장하기

로그인 후, 서재에 저장한 논문 카드(또는 상세 화면)에 "내 PDF 업로드" 버튼이 생깁니다. 버튼을 누르고 본인 컴퓨터의 PDF 파일을 고르면 Supabase Storage(파일 저장 공간)에 안전하게 업로드되고, 이후 "내 PDF 열기"로 언제든 다시 열어볼 수 있습니다.

**필수 설정 (로그인 연동이 이미 되어 있다는 전제):**

1. `supabase.sql`의 **7번 섹션**(Storage 버킷 생성 + 권한 정책)을 SQL Editor에서 실행합니다. (이미 실행한 적이 있다면, 7번 섹션만 새로 복사해서 실행하세요 — `on conflict ... do nothing`이 있어서 버킷 생성 부분은 다시 실행해도 안전하지만, `create policy` 부분은 한 번만 실행해야 합니다.)
2. Supabase 대시보드 → **Storage**에 들어가서 `paper-pdfs` 버킷이 생성되었는지 확인합니다. (Public이 아니라 **Private**이어야 안전합니다 — 기본값이 Private으로 생성됩니다.)
3. 별도로 `paperpulse.html`을 수정할 필요는 없습니다 (`CONFIG.PDF_BUCKET` 값이 이미 `paper-pdfs`로 맞춰져 있어요).

**제한 사항:**
- 파일 하나당 최대 20MB.
- 로그인하지 않았거나 Supabase 연동이 안 된 상태에서는 이 기능이 보이지 않습니다 (사용자에게 안내 문구만 표시됩니다).
- 각 사용자는 본인이 올린 파일만 볼 수 있습니다 (다른 사람의 PDF는 절대 접근할 수 없도록 Storage 정책으로 막아뒀습니다).

## 배포(호스팅) 방법 — 비개발자를 위한 단계별 가이드

지금까지는 `paperpulse.html`을 내 컴퓨터에서 더블클릭해서(`file://...`) 열어봤을 텐데, **로그인(구글 OAuth)은 실제 웹 주소(https://...)에서만 정상 동작**합니다. 그래서 로그인을 테스트하려면 먼저 배포(인터넷에 올리기)를 해야 합니다.

가장 쉬운 조합: **프론트엔드(`paperpulse.html`)는 Netlify**, **백엔드(`paperpulse-backend`)는 Render**를 추천합니다. 둘 다 무료로 시작할 수 있고, 터미널 명령어 없이 마우스 클릭만으로 배포할 수 있습니다.

### 1단계. 프론트엔드(`paperpulse.html`) 배포 — Netlify

1. [netlify.com](https://www.netlify.com)에서 무료 회원가입 (구글 계정으로도 가입 가능).
2. 로그인 후 대시보드에서 **"Add new site" → "Deploy manually"**를 클릭합니다.
3. `paperpulse.html` 파일이 들어있는 폴더(또는 파일 하나)를 화면에 드래그 앤 드롭합니다.
   - 이때 파일 이름이 반드시 `index.html`이어야 자동으로 첫 화면으로 열립니다. `paperpulse.html`을 `index.html`로 이름을 바꿔서 올려주세요.
4. 업로드가 끝나면 `https://random-name-1234.netlify.app` 같은 주소가 발급됩니다. 이게 이제 내 웹사이트 주소입니다.
5. (선택) Site settings → Change site name에서 주소를 `paperpulse-hayeon.netlify.app` 같은 원하는 이름으로 바꿀 수 있습니다.

### 2단계. 백엔드(`paperpulse-backend`) 배포 — Render

1. [render.com](https://render.com)에서 무료 회원가입 (GitHub 계정 연동을 추천).
2. 이 폴더(`paperpulse-backend`)를 GitHub 저장소로 올려야 합니다 — GitHub 데스크톱 앱(무료, 클릭만으로 사용 가능)이나 [github.com](https://github.com)에서 "Upload files"로 폴더를 통째로 올릴 수 있습니다.
3. Render 대시보드에서 **"New +" → "Web Service"** → 방금 올린 GitHub 저장소 선택.
4. 설정값:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. **Environment Variables** 섹션에 `.env`에 있던 값들을 하나씩 똑같이 입력합니다 (`GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PORTONE_API_SECRET`, `PORTONE_WEBHOOK_SECRET`, `SEMANTIC_SCHOLAR_API_KEY`, `PORT`은 생략 가능).
6. 배포가 끝나면 `https://paperpulse-backend.onrender.com` 같은 주소가 발급됩니다.
   - 참고: Render 무료 요금제는 사용하지 않으면 서버가 잠들어서, 첫 요청에 10~30초 정도 걸릴 수 있습니다. 정상입니다.

### 3단계. `paperpulse.html`의 CONFIG를 배포된 주소로 수정

`CONFIG.BACKEND_ORIGIN` 값을 1단계가 아니라 **2단계에서 받은 백엔드 주소**로 바꿔줍니다.

```js
BACKEND_ORIGIN: 'https://paperpulse-backend.onrender.com',
```

수정한 `paperpulse.html`(→ `index.html`)을 Netlify에 다시 드래그해서 올리면 반영됩니다.

### 4단계. 로그인이 되도록 Supabase / 구글 설정에 배포 주소 등록

로그인이 안 되는 가장 흔한 원인이 "허용된 주소 목록"에 배포 주소가 없어서입니다. 아래 두 곳에 **1단계에서 받은 Netlify 주소**를 반드시 등록해야 합니다.

1. **Supabase 대시보드** → Authentication → URL Configuration
   - Site URL: `https://paperpulse-hayeon.netlify.app`
   - Redirect URLs: 같은 주소 추가
2. **Google Cloud Console** (Supabase에서 구글 로그인 설정할 때 만든 OAuth 클라이언트) → 해당 OAuth 클라이언트 → "승인된 자바스크립트 원본"과 "승인된 리디렉션 URI"에도 같은 Netlify 주소 + Supabase가 안내하는 콜백 주소를 추가.

### 5단계. 최종 확인

1. Netlify 주소로 접속 → 오른쪽 위 "로그인" → 구글 로그인이 정상적으로 되는지 확인.
2. 서재에 논문을 저장하고 AI 비서에게 질문 → 백엔드가 잘 응답하는지 확인.
3. PDF 업로드 버튼으로 파일 하나 올려서 "내 PDF 열기"가 잘 되는지 확인.

이후에 코드를 수정하고 싶으면, 수정한 `paperpulse.html`(`index.html`로 이름 변경)을 Netlify에 다시 드래그하고, `server.js`를 고쳤다면 GitHub 저장소에 다시 업로드하면 Render가 자동으로 재배포합니다.

