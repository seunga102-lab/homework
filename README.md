# Talk Pro — 배포 가능한 학습 데모

Claude 계정 로그인 없이, 학생이 URL 하나로 바로 접속해 학습할 수 있는 독립 실행형 웹앱입니다.
쉐도잉·딕테이션·원어민 패턴학습·영어일기 첨삭을 실제로 체험할 수 있고, AI 호출은 서버(`server.js`)를 통해 안전하게 처리됩니다 (API 키가 브라우저에 노출되지 않습니다).

---

## 1. 사전 준비물

1. **Anthropic API 키** — https://console.anthropic.com 에서 계정 생성 후 발급 (Settings → API Keys)
2. **Node.js 18 이상** (로컬 테스트 시 필요, 배포 플랫폼은 자동으로 제공)

---

## 2. 로컬에서 먼저 테스트하기

```bash
# 압축을 푼 폴더로 이동
cd talkpro-app

# 패키지 설치
npm install

# .env 파일 생성 후 API 키 입력
cp .env.example .env
# .env 파일을 열어 ANTHROPIC_API_KEY=발급받은키 로 수정

# 서버 실행
npm start
```

브라우저에서 `http://localhost:3000` 접속 → 정상 작동하는지 확인 후 배포를 진행하세요.

---

## 3. 실제 배포하기 (추천 순서)

### 방법 A — Render.com (가장 쉬움, 무료 플랜 있음)

1. 이 폴더를 GitHub 저장소에 업로드 (`.env`는 올리지 마세요 — `.gitignore`에 이미 제외되어 있습니다)
2. https://render.com 가입 → **New +** → **Web Service** → GitHub 저장소 연결
3. 설정값:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. **Environment** 탭에서 `ANTHROPIC_API_KEY` 값을 등록
5. Deploy 클릭 → 몇 분 후 `https://your-app-name.onrender.com` 형태의 URL 발급 → 이 링크를 학생들에게 전달

### 방법 B — Railway.app

1. https://railway.app 가입 → **New Project** → **Deploy from GitHub repo**
2. **Variables** 탭에서 `ANTHROPIC_API_KEY` 등록
3. 자동 배포 후 발급되는 URL을 그대로 학생들에게 전달 (Settings → Networking → Generate Domain)

### 방법 C — 회사/학원 자체 서버(VPS)가 있는 경우

```bash
# 서버에 파일 업로드 후
npm install --production
# .env 파일에 ANTHROPIC_API_KEY 설정
# pm2 등으로 상시 실행 (예시)
npm install -g pm2
pm2 start server.js --name talkpro
```
이후 nginx 등으로 도메인 연결 및 HTTPS(Let's Encrypt) 설정을 권장합니다.

---

## 4. 배포 후 꼭 확인할 것

- [ ] `https://발급받은URL/api/health` 접속 시 `{"status":"ok","ai_configured":true}` 로 나오는지 확인
- [ ] 실제 모바일 브라우저(Chrome 권장)로 접속해 쉐도잉 마이크 권한 요청이 뜨는지 확인
- [ ] 딕테이션 제출 시 AI 채점 결과가 정상적으로 오는지 확인
- [ ] 학생 다수가 동시 접속할 경우 API 사용량/비용이 발생하므로, Anthropic 콘솔에서 사용량 알림(Usage limits)을 설정해두는 것을 권장합니다

---

## 5. 구조 설명

```
talkpro-app/
 ├─ server.js        # Express 서버 — 정적 파일 제공 + AI 프록시(/api/ai)
 ├─ package.json     # 의존성 정의
 ├─ .env.example     # 환경변수 예시 (API 키는 여기 넣지 말고 .env에)
 └─ public/
     └─ index.html   # 프론트엔드 전체 (쉐도잉/딕테이션/패턴/일기 UI + 로직)
```

**보안 원칙**: `index.html`(브라우저에서 실행되는 코드)은 API 키를 절대 가지고 있지 않습니다. 모든 AI 요청은 `/api/ai`를 거쳐 서버에서만 Anthropic API를 호출하도록 설계했습니다. 이후 실서비스로 발전시킬 때도 이 구조(백엔드 프록시 경유)를 그대로 유지하시면 됩니다.

---

## 6. 다음 확장 방향 (참고)

- 문장 데이터베이스 확장: `public/index.html` 내 `shadowSentences`, `dictSentence`, `patternSteps` 배열에 레벨별 문장을 추가
- 학생별 데이터 영구 저장: 현재는 브라우저 `localStorage`(기기별 저장)만 사용 — 여러 기기 동기화가 필요하면 실제 DB(PostgreSQL 등) 연동 필요
- 회원 구분(학생/플래너/강사/관리자): 현재 데모는 학생 화면만 포함, 로그인/권한 시스템은 기획서 8~9장 구조를 참고해 추가 구현 필요
