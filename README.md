# Talk Pro — 배포 가능한 학습 데모

Claude 계정 로그인 없이, 학생이 URL 하나로 바로 접속해 학습할 수 있는 독립 실행형 웹앱입니다.
쉐도잉·딕테이션·원어민 패턴학습·영어일기 첨삭을 실제로 체험할 수 있고, AI 호출은 서버(`server.js`)를 통해 안전하게 처리됩니다 (API 키가 브라우저에 노출되지 않습니다).

---

## 1. 사전 준비물

1. **Anthropic API 키** — https://console.anthropic.com 에서 계정 생성 후 발급 (Settings → API Keys)
2. **Node.js 18 이상** (로컬 테스트 시 필요, 배포 플랫폼은 자동으로 제공)
3. 이제 로그인 기능이 있어서 **SESSION_SECRET**도 꼭 설정해야 해요 (아래 3단계에서 안내)

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

## 7. 문제 해결 (Troubleshooting)

**AI 채점/첨삭이 안 될 때**
1. `https://내주소/api/health` 접속 → `ai_configured: true` 확인 (`false`면 Render의 Environment Variables에 `ANTHROPIC_API_KEY`가 안 들어간 것)
2. 화면에 에러 메시지가 그대로 뜨도록 만들어뒀으니(예: "AI 채점 중 오류가 발생했어요: ..."), 그 메시지를 확인하면 원인을 알 수 있습니다
3. Render 대시보드 → 해당 서비스 → **Logs** 탭에서 실제 서버 에러 로그 확인 가능

**마이크(음성인식)가 안 될 때**
- 반드시 **Chrome 브라우저**(데스크탑 또는 Android)로 열어주세요. Safari, 카카오톡/인스타그램 인앱 브라우저는 음성인식을 지원하지 않습니다
- 마이크 권한을 거부했다면, 주소창 왼쪽 자물쇠 아이콘 → 마이크 → 허용으로 변경 후 새로고침
- 이제 에러 발생 시 화면에 구체적인 원인(권한 거부/네트워크 문제/마이크 없음 등)이 한글로 표시됩니다

## 8. 로그인/회원가입 & 하루 3개 제한 (신규)

**새로 추가된 기능**
- 첫 화면이 로그인/회원가입 화면으로 바뀌었어요. 학생이 각자 아이디/비밀번호로 계정을 만들어 사용합니다.
- 회원가입 직후(또는 로그인 후) 레벨 선택 화면이 뜨고, 확인하면 홈으로 이동합니다.
- 쉐도잉·딕테이션은 **하루 3문장**까지만 학습 가능하고, 자정(한국시간) 기준으로 초기화됩니다. (같은 문장을 여러 번 다시 녹음/제출하는 건 횟수에 포함되지 않고, 새 문장으로 넘어갈 때만 차감돼요.)
- 패턴학습·영어일기는 제한이 없습니다.

**⚠️ 배포 시 반드시 설정할 것: `SESSION_SECRET`**
- Render의 Environment Variables에 `ANTHROPIC_API_KEY`와 함께 `SESSION_SECRET`도 추가해주세요 (아무 임의의 긴 문자열이면 됩니다, 예: `talkpro-secret-8f2k9x`).
- 이 값을 설정하지 않으면 서버가 재시작될 때마다(예: Render 무료 플랜의 자동 절전 후 재기동) **모든 학생이 로그아웃**됩니다.

**⚠️ 계정 데이터 저장 위치의 한계**
- 현재 계정 정보는 서버의 `data/db.json` 파일에 저장됩니다. 이 방식은 간단하지만, **GitHub에 새 코드를 올려 재배포할 때마다 계정 데이터가 초기화**됩니다 (Render 무료 플랜은 재배포 시 디스크가 초기화되는 구조라서요).
- 즉, 코드를 수정해서 다시 배포하면 학생들이 다시 회원가입을 해야 해요. 소규모 데모/파일럿 단계에서는 괜찮지만, 실제 서비스로 전환할 때는 실제 데이터베이스(PostgreSQL 등, Render에서 무료로 추가 가능)로 교체하는 걸 권장합니다. 이 부분은 필요하시면 이어서 도와드릴게요.
