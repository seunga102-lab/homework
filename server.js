require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET 환경변수가 설정되어 있지 않습니다. 서버가 재시작되면 모든 로그인 세션이 초기화됩니다.');
}

const DAILY_LIMIT = 3; // 쉐도잉/딕테이션 1일 학습 가능 문장 수

// 선생님 계정으로 가입하려면 이 코드를 알아야 한다. 배포 시 환경변수로 반드시 바꿔서 사용할 것.
const TEACHER_SIGNUP_CODE = process.env.TEACHER_SIGNUP_CODE || 'talkpro-teacher';

/* ================= PostgreSQL 연결 (Neon 등) ================= */
// 회원 정보/학습 기록을 실제 데이터베이스에 저장한다. 재배포해도 데이터가 사라지지 않는다.
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Neon 등 대부분의 매니지드 Postgres는 SSL 필수
  });
} else {
  console.warn('⚠️  DATABASE_URL 환경변수가 설정되어 있지 않습니다. 회원가입/로그인 기능이 동작하지 않습니다.');
}

async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'student',
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_content (
        content_key TEXT PRIMARY KEY,
        content JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    console.log('✅ 데이터베이스 테이블 준비 완료');
  } catch (e) {
    console.error('❌ 데이터베이스 초기화 오류:', e);
  }
}

function todayKST() {
  // 한국 시간 기준 날짜 문자열 (일일 학습 제한 리셋 기준)
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function daysSince(dateStr) {
  // 가입일(joinDate)부터 오늘까지 며칠째인지 계산 (가입일 = 1일차)
  const start = new Date(dateStr + 'T00:00:00+09:00');
  const today = new Date(todayKST() + 'T00:00:00+09:00');
  const diffDays = Math.round((today - start) / (1000 * 60 * 60 * 24));
  return diffDays + 1;
}

/* ================= AI 기반 일일 콘텐츠 생성 (레벨당/타입당 하루에 한 번만 생성, 그 날 접속하는 모든 학생이 공유) ================= */
const LEVEL_META = {
  1: { name: 'Lv.1 입문', cefr: 'A1', goal: '단어 → 아주 짧은 문장', length: '3~5단어', grammar: 'Be동사, 일반동사 현재형만 사용 (접속사·전치사구 사용 금지, 한 문장에 절 하나만)', vocab: '초등 저학년 수준의 아주 쉬운 기초 단어만 사용 (가족, 색깔, 숫자, 동물, 음식, 날씨, 일상 사물, 기본 동작 등). 2음절을 넘는 단어나 추상적인 단어는 피할 것', example: 'I am happy. / She likes coffee. / I have a dog.' },
  2: { name: 'Lv.2 초급', cefr: 'A2', goal: '일상 한 문장 말하기', length: '5~8단어', grammar: '현재, 과거, 미래 시제와 단순 의문문만 사용 (관계대명사·접속사·분사 사용 금지, 한 문장에 절 하나만)', vocab: '초등학생도 이해할 수 있는 쉬운 일상 단어만 사용. 관용구, 비유적 표현, 어려운 어휘는 피할 것', example: 'I usually go to work by bus. / What time is it?' },
  3: { name: 'Lv.3 초중급', cefr: 'A2-B1', goal: '이유를 덧붙여 말하기', length: '6~9단어', grammar: 'because, when, if, can, want to 중 하나만 사용해 절을 한 번만 연결 (여러 개를 한 문장에 겹쳐 쓰지 말 것)', vocab: '일상적이고 자주 쓰는 쉬운 단어 위주로 사용. 어렵거나 격식 있는 단어, 관용구는 피할 것', example: 'I stayed home because it was raining.' },
  4: { name: 'Lv.4 중급', cefr: 'B1', goal: '자연스럽게 대화하기', length: '10~15단어', grammar: '현재완료, 비교급, 관계대명사, 동명사', example: "I've never been to Japan, but I'd like to visit someday." },
  5: { name: 'Lv.5 중고급', cefr: 'B1-B2', goal: '의견과 경험 설명하기', length: '15~20단어', grammar: '가정법, 수동태, 분사구문 일부', example: 'If I had more time, I would learn another language.' },
  6: { name: 'Lv.6 고급', cefr: 'B2-C1', goal: '원어민처럼 길게 말하기', length: '20단어 이상', grammar: '다양한 문장 연결어, 관용 표현, 자연스러운 어순', example: 'Although it was difficult at first, I eventually became comfortable speaking English.' },
  7: { name: 'Lv.7 미국 MZ 슬랭', cefr: '슬랭·줄임말', goal: '미국 MZ세대(Gen Z)가 실생활/SNS/문자에서 쓰는 슬랭과 줄임말 익히기', length: '5~15단어 (슬랭 표현이 자연스럽게 들어간 문장)', grammar: '캐주얼한 구어체, 슬랭/줄임말을 실제 대화 맥락 속에서 사용', example: "Bro, that party was bussin, no cap." }
};

// 최소한의 비상용 대체 콘텐츠 (AI 호출 자체가 실패했을 때만 사용됨)
const FALLBACK_CONTENT = {
  shadowing: [
    { en: 'I am happy today.', ko: '나는 오늘 행복하다.' },
    { en: "I'm not sure what to do next.", ko: '다음에 뭘 해야 할지 잘 모르겠어.' },
    { en: "There's more to this than meets the eye.", ko: '이건 겉보기보다 더 많은 게 있어.' }
  ],
  dictation: [
    { en: 'My name is Anna.', ko: '내 이름은 애나다.' },
    { en: "I haven't decided yet.", ko: '나는 아직 결정하지 않았어.' },
    { en: 'This warrants a closer look.', ko: '이건 더 자세히 살펴볼 필요가 있어.' }
  ],
  pattern: [
    { en: 'I like...', ko: '나는 좋아해...' },
    { en: 'I like pizza.', ko: '나는 피자를 좋아해.' },
    { en: 'I like pizza and pasta.', ko: '나는 피자랑 파스타를 좋아해.' }
  ],
  scramble: [
    { en: 'I usually go to work by bus.', ko: '나는 보통 버스로 출근한다.' },
    { en: 'She likes to read books at night.', ko: '그녀는 밤에 책 읽는 것을 좋아한다.' },
    { en: 'We are planning a trip next month.', ko: '우리는 다음 달에 여행을 계획하고 있다.' }
  ]
};

async function callAnthropicRaw(systemPrompt, userPrompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${errText}`);
  }
  const data = await response.json();
  const text = (data.content || []).map((b) => b.text || '').filter(Boolean).join('\n');
  if (!text) throw new Error('AI가 빈 응답을 반환했습니다.');
  return text.replace(/```json|```/g, '').trim();
}
function safeJsonParseServer(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const arrStart = raw.indexOf('[');
    const arrEnd = raw.lastIndexOf(']');
    // 배열 형태([...])와 객체 형태({...}) 둘 다 대비
    if (arrStart !== -1 && arrEnd !== -1 && (start === -1 || arrStart < start)) {
      return JSON.parse(raw.slice(arrStart, arrEnd + 1));
    }
    if (start !== -1 && end !== -1) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw e;
  }
}

async function generateDailyContent(type, level) {
  const meta = LEVEL_META[level];
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY 미설정');

  if (type === 'shadowing' || type === 'dictation' || type === 'scramble') {
    const purpose = type === 'shadowing'
      ? '쉐도잉(듣고 따라 말하기) 연습용 문장'
      : type === 'dictation'
      ? '딕테이션(듣고 받아쓰기) 연습용 문장'
      : '문장 재구성 게임(섞인 단어를 순서대로 배열하는 게임)용 문장 - 단어 하나하나가 명확히 구분되는 자연스러운 문장';
    const isSlangLevel = level === 7;
    const slangRules = isSlangLevel
      ? `\n특별 규칙 (이 레벨 전용):
- 이건 미국 MZ세대(Gen Z)가 실생활 대화, SNS, 문자에서 실제로 자주 쓰는 슬랭/줄임말 표현 학습이다.
- 매번 다른 슬랭 표현을 하나 이상씩 자연스러운 문장 속에 포함시킬 것 (예: no cap, bet, lowkey, highkey, bussin, slay, rizz, iykyk, fr fr, sus, cap, bruh, goated, hits different, ghosted, simp, vibe check 등 — 매번 새로운 것 위주로)
- 한글 뜻에는 문장 번역과 함께, 사용된 슬랭 표현의 의미를 괄호로 짧게 설명할 것 (예: "이 파티 진짜 대박이었어, 진짜야. (bussin=엄청 좋다/맛있다, no cap=진심이야))
- 너무 오래되거나 안 쓰이는 슬랭 말고, 최근에도 실제로 쓰이는 표현 위주로 만들 것
- 욕설, 비속어, 성적이거나 공격적인 표현은 절대 포함하지 말 것. 학생들이 배워도 괜찮은 캐주얼하고 건전한 슬랭만 사용할 것`
      : '';
    const sys = `너는 영어 학습 콘텐츠 제작자다. 아래 레벨 기준에 정확히 맞는 ${purpose} 3개를 새로 만든다.

레벨: ${meta.name} (${meta.cefr})
학습 목표: ${meta.goal}
문장 길이: 반드시 ${meta.length} 범위 안에서만 작성 (이 범위를 벗어나면 안 됨)
사용 가능한 문법: ${meta.grammar}
난이도 참고 예문: "${meta.example}"
${meta.vocab ? "사용 어휘 제한: " + meta.vocab : ""}
${slangRules}

규칙:
- 위 문장 길이 범위와 문법 수준을 절대 벗어나지 말 것 (더 쉽거나 더 어렵게 만들지 말 것)
- 실제 원어민이 일상 대화에서 자연스럽게 쓰는 표현으로 만들 것 (교과서적이지 않게)
- 3개는 서로 다른 주제를 다룰 것
- 저작권 있는 특정 영화/드라마/노래 대사를 그대로 베끼지 말 것 (원본 문장을 새로 창작)
- 반드시 순수 JSON 배열만 응답하고 다른 설명은 절대 포함하지 마라.
형식: [{"en":"영어 문장","ko":"한글 뜻"},{"en":"...","ko":"..."},{"en":"...","ko":"..."}]`;
    const raw = await callAnthropicRaw(sys, `${meta.name} 수준(${meta.length}, ${meta.grammar})에 정확히 맞는 새로운 문장 3개를 만들어줘.`);
    const parsed = safeJsonParseServer(raw);
    if (!Array.isArray(parsed) || parsed.length < 3) throw new Error('AI 응답 형식이 올바르지 않습니다.');
    return parsed.slice(0, 3).map((p) => ({ en: String(p.en || '').trim(), ko: String(p.ko || '').trim() }));
  }

  if (type === 'pattern') {
    const isSlangLevel = level === 7;
    const slangPatternRules = isSlangLevel
      ? `\n특별 규칙 (이 레벨 전용): STEP1~3에 미국 MZ세대 슬랭/줄임말 표현을 하나 포함시킬 것 (예: no cap, bet, lowkey, bussin, slay, rizz, iykyk, fr fr, sus, hits different 등). 한글 뜻에는 슬랭의 의미를 괄호로 짧게 설명할 것. 욕설, 비속어, 성적이거나 공격적인 표현은 절대 포함하지 말 것 — 건전하고 캐주얼한 슬랭만 사용할 것.`
      : '';
    const sys = `너는 영어 학습 콘텐츠 제작자다. 아래 레벨 기준에 정확히 맞는 "패턴 학습" 세트 1개를 새로 만든다.
패턴 학습은 짧은 시작 표현이 점점 길어지는 3단계 문장 세트다. 예시 스타일(형식 참고용, 난이도는 아래 기준을 따를 것):
STEP1: "I'm the one who..." (짧은 시작 표현, 미완성)
STEP2: "I'm the one who called you." (완성된 짧은 문장)
STEP3: "I'm the one who called you yesterday." (더 길고 구체적인 문장)

레벨: ${meta.name} (${meta.cefr})
학습 목표: ${meta.goal}
최종(STEP3) 문장 길이: 반드시 ${meta.length} 범위 안에서 작성
사용 가능한 문법: ${meta.grammar}
난이도 참고 예문: "${meta.example}"
${meta.vocab ? "사용 어휘 제한: " + meta.vocab : ""}
${slangPatternRules}

규칙:
- STEP3의 최종 문장이 위 문장 길이 범위와 문법 수준을 벗어나지 말 것
- ${meta.cefr} 수준에 맞는 실용적인 회화 패턴으로 만들 것
- 저작권 있는 대사를 베끼지 말고 새로 창작할 것
- 반드시 순수 JSON 배열 3개 항목만 응답하고 다른 설명은 절대 포함하지 마라.
형식: [{"en":"STEP1 영어","ko":"STEP1 한글 뜻"},{"en":"STEP2 영어","ko":"STEP2 한글 뜻"},{"en":"STEP3 영어","ko":"STEP3 한글 뜻"}]`;
    const raw = await callAnthropicRaw(sys, `${meta.name} 수준(${meta.length}, ${meta.grammar})에 정확히 맞는 새로운 패턴 세트를 만들어줘.`);
    const parsed = safeJsonParseServer(raw);
    if (!Array.isArray(parsed) || parsed.length < 3) throw new Error('AI 응답 형식이 올바르지 않습니다.');
    return parsed.slice(0, 3).map((p) => ({ en: String(p.en || '').trim(), ko: String(p.ko || '').trim() }));
  }

  throw new Error('알 수 없는 type: ' + type);
}

// 오늘/이 레벨/이 타입의 콘텐츠를 가져온다. 캐시에 있으면 재사용하고, 없으면 AI로 새로 생성해 캐시에 저장한다.
// 같은 날 같은 레벨의 모든 학생이 동일한 콘텐츠를 공유하므로 AI 호출은 레벨당/타입당 하루 1회만 발생한다.
async function getOrCreateDailyContent(type, level) {
  const key = `${type}:${level}:${todayKST()}`;
  const existing = await pool.query('SELECT content FROM daily_content WHERE content_key = $1', [key]);
  if (existing.rows[0]) return existing.rows[0].content;

  let content;
  try {
    content = await generateDailyContent(type, level);
  } catch (e) {
    console.error(`일일 콘텐츠 생성 실패 (${key}):`, e.message);
    content = FALLBACK_CONTENT[type];
  }

  try {
    await pool.query(
      'INSERT INTO daily_content (content_key, content) VALUES ($1, $2) ON CONFLICT (content_key) DO NOTHING',
      [key, JSON.stringify(content)]
    );
  } catch (e) {
    console.error('일일 콘텐츠 저장 오류:', e);
  }
  // 동시에 여러 요청이 처음 생성을 시도했을 수 있으므로, 최종적으로 저장된(먼저 저장된) 버전을 다시 읽어 일관성 유지
  const final = await pool.query('SELECT content FROM daily_content WHERE content_key = $1', [key]);
  return final.rows[0] ? final.rows[0].content : content;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function verifyPassword(password, salt, expectedHash) {
  const hash = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createToken(username) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30일 유지
  const payload = `${username}:${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}
function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  let payload;
  try { payload = Buffer.from(payloadB64, 'base64').toString('utf8'); } catch (e) { return null; }
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [username, expStr] = payload.split(':');
  if (Date.now() > parseInt(expStr, 10)) return null;
  return username;
}

function defaultUserData(name) {
  return {
    name: (name || '').trim(),
    level: 3,
    levelChosen: false,
    xp: 0,
    streak: 0,
    active: true, // false로 바뀌면 수강 중지 상태 - 로그인/모든 API 접근이 막힌다
    progressDay: 1, // 실제로 그 날짜치를 완료해야만 다음 차수로 넘어가는 "진도" (달력 날짜와 무관)
    completed: { shadowing: false, dictation: false, pattern: false, scramble: false },
    usage: { date: todayKST(), shadowing: 0, dictation: 0 },
    joinDate: todayKST(),
    history: [] // 선생님이 볼 수 있는 학습 활동 기록 (문장, 점수, 작문 내용 등)
  };
}
// 날짜가 바뀌었으면 오늘 미션/사용량을 초기화한다. data 객체를 직접 수정(mutate)한다.
// 진도(progressDay)는 "이전 활동일에 쉐도잉/딕테이션을 하루치(3+3) 다 끝냈는가"에 따라서만 넘어간다.
// 못 끝냈으면 다음에 접속했을 때 같은 차수를 이어서 하도록 progressDay를 그대로 유지한다.
function rollUsageIfNeeded(data) {
  const today = todayKST();
  let changed = false;
  if (!data.usage || data.usage.date !== today) {
    const finishedLastActiveDay = !!data.usage &&
      data.usage.shadowing >= DAILY_LIMIT &&
      data.usage.dictation >= DAILY_LIMIT;
    if (finishedLastActiveDay) {
      data.progressDay = (data.progressDay || 1) + 1;
    }
    // 못 끝냈으면 progressDay는 그대로 두어, 이어서 같은 차수를 진행하게 한다.
    data.usage = { date: today, shadowing: 0, dictation: 0 };
    data.completed = { shadowing: false, dictation: false, pattern: false, scramble: false };
    changed = true;
  }
  if (!data.joinDate) {
    data.joinDate = today;
    changed = true;
  }
  if (!data.progressDay) {
    data.progressDay = 1;
    changed = true;
  }
  if (data.active === undefined) {
    data.active = true; // 기존 계정 호환
    changed = true;
  }
  if (!data.history) {
    data.history = []; // 기존 계정 호환
    changed = true;
  }
  if (data.completed && Object.prototype.hasOwnProperty.call(data.completed, 'diary') && !Object.prototype.hasOwnProperty.call(data.completed, 'scramble')) {
    // 영어일기 -> 문장 재구성 게임으로 교체된 기존 계정 호환
    data.completed.scramble = false;
    delete data.completed.diary;
    changed = true;
  }
  if (data.name === undefined) {
    data.name = ''; // 기존 계정 호환 (이름 필드 추가 이전 가입자)
    changed = true;
  }
  return changed;
}
function sanitizeUser(username, role, data) {
  return {
    username,
    name: data.name || '',
    role: role || 'student',
    level: data.level,
    levelChosen: !!data.levelChosen,
    xp: data.xp,
    streak: data.streak,
    active: data.active !== false,
    completed: data.completed,
    usage: data.usage,
    dailyLimit: DAILY_LIMIT,
    dayCount: data.progressDay || 1
  };
}

/* ================= DB 접근 헬퍼 ================= */
async function getUserRow(username) {
  const result = await pool.query('SELECT username, salt, password_hash, role, data FROM users WHERE username = $1', [username]);
  return result.rows[0] || null;
}
async function saveUserData(username, data) {
  await pool.query('UPDATE users SET data = $1 WHERE username = $2', [JSON.stringify(data), username]);
}
async function createUserRow(username, salt, passwordHash, role, data) {
  await pool.query(
    'INSERT INTO users (username, salt, password_hash, role, data) VALUES ($1, $2, $3, $4, $5)',
    [username, salt, passwordHash, role, JSON.stringify(data)]
  );
}

function requireDB(req, res, next) {
  if (!pool) {
    return res.status(500).json({ error: 'DATABASE_URL이 서버에 설정되어 있지 않습니다. 배포 환경변수를 확인하세요.' });
  }
  next();
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const username = verifyToken(token);
  if (!username) {
    return res.status(401).json({ error: '로그인이 필요하거나 세션이 만료됐어요. 다시 로그인해주세요.' });
  }
  try {
    const row = await getUserRow(username);
    if (!row) {
      return res.status(401).json({ error: '계정을 찾을 수 없어요. 다시 로그인해주세요.' });
    }
    if (row.role !== 'teacher' && row.data && row.data.active === false) {
      return res.status(403).json({ error: '수강이 중지된 계정이에요. 담당 선생님께 문의해주세요.' });
    }
    req.username = username;
    req.userRow = row; // { username, salt, password_hash, role, data }
    next();
  } catch (e) {
    console.error('DB 조회 오류:', e);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
}

function requireTeacher(req, res, next) {
  if (!req.userRow || req.userRow.role !== 'teacher') {
    return res.status(403).json({ error: '선생님 계정만 접근할 수 있어요.' });
  }
  next();
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ================= 인증 API ================= */
app.post('/api/auth/signup', requireDB, async (req, res) => {
  const { username, password } = req.body || {};
  const name = ((req.body && req.body.name) || '').trim();
  const teacherCode = ((req.body && req.body.teacherCode) || '').trim();
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }
  if (!name) {
    return res.status(400).json({ error: '이름을 입력해주세요.' });
  }
  if (name.length > 30) {
    return res.status(400).json({ error: '이름은 30자 이내로 입력해주세요.' });
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: '아이디는 영문/숫자/밑줄만 사용해 3~20자로 입력해주세요.' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: '비밀번호는 4자 이상이어야 해요.' });
  }
  if (teacherCode && teacherCode !== TEACHER_SIGNUP_CODE.trim()) {
    return res.status(400).json({ error: '선생님 코드가 올바르지 않아요.' });
  }

  try {
    const existing = await getUserRow(username);
    if (existing) {
      return res.status(409).json({ error: '이미 사용 중인 아이디예요.' });
    }

    const role = teacherCode !== '' && teacherCode === TEACHER_SIGNUP_CODE.trim() ? 'teacher' : 'student';
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const data = defaultUserData(name);
    await createUserRow(username, salt, passwordHash, role, data);

    res.json({ token: createToken(username), user: sanitizeUser(username, role, data) });
  } catch (e) {
    console.error('회원가입 오류:', e);
    res.status(500).json({ error: '회원가입 중 서버 오류가 발생했습니다.' });
  }
});

app.post('/api/auth/login', requireDB, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }
  try {
    const row = await getUserRow(username);
    if (!row || !verifyPassword(password, row.salt, row.password_hash)) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않아요.' });
    }
    const data = row.data;
    if (data.active === false) {
      return res.status(403).json({ error: '수강이 중지된 계정이에요. 담당 선생님께 문의해주세요.' });
    }
    if (rollUsageIfNeeded(data)) {
      await saveUserData(username, data);
    }
    res.json({ token: createToken(username), user: sanitizeUser(username, row.role, data) });
  } catch (e) {
    console.error('로그인 오류:', e);
    res.status(500).json({ error: '로그인 중 서버 오류가 발생했습니다.' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  const data = req.userRow.data;
  if (rollUsageIfNeeded(data)) {
    await saveUserData(req.username, data);
  }
  res.json({ user: sanitizeUser(req.username, req.userRow.role, data) });
});

app.post('/api/me/level', requireAuth, async (req, res) => {
  const { level } = req.body || {};
  if (!Number.isInteger(level) || level < 1 || level > 7) {
    return res.status(400).json({ error: '레벨은 1~7 사이 숫자여야 해요.' });
  }
  const data = req.userRow.data;
  data.level = level;
  data.levelChosen = true;
  await saveUserData(req.username, data);
  res.json({ user: sanitizeUser(req.username, req.userRow.role, data) });
});

app.post('/api/me/progress', requireAuth, async (req, res) => {
  const { xp, streak, completed } = req.body || {};
  const data = req.userRow.data;
  if (typeof xp === 'number') data.xp = xp;
  if (typeof streak === 'number') data.streak = streak;
  if (completed && typeof completed === 'object') data.completed = { ...data.completed, ...completed };
  await saveUserData(req.username, data);
  res.json({ user: sanitizeUser(req.username, req.userRow.role, data) });
});

const HISTORY_MAX_LENGTH = 100; // 학생당 최근 100개 활동만 보관 (너무 커지는 것 방지)

// 학습 활동 하나를 기록한다 (쉐도잉/딕테이션/패턴/일기 결과). 선생님이 학생 상세보기에서 확인할 수 있다.
app.post('/api/me/history', requireAuth, async (req, res) => {
  const { type, summary, detail, score } = req.body || {};
  if (!type || !summary) {
    return res.status(400).json({ error: 'type과 summary가 필요합니다.' });
  }
  const data = req.userRow.data;
  if (!Array.isArray(data.history)) data.history = [];
  data.history.unshift({
    type,
    summary: String(summary).slice(0, 500),
    detail: detail ? String(detail).slice(0, 1000) : '',
    score: typeof score === 'number' ? score : null,
    date: todayKST(),
    at: Date.now()
  });
  if (data.history.length > HISTORY_MAX_LENGTH) {
    data.history = data.history.slice(0, HISTORY_MAX_LENGTH);
  }
  await saveUserData(req.username, data);
  res.json({ ok: true });
});

// 쉐도잉/딕테이션 하루 3개 제한 체크 및 소모
app.post('/api/usage/increment', requireAuth, async (req, res) => {
  const { type } = req.body || {};
  if (type !== 'shadowing' && type !== 'dictation') {
    return res.status(400).json({ error: 'type은 shadowing 또는 dictation이어야 해요.' });
  }
  const data = req.userRow.data;
  rollUsageIfNeeded(data);
  if (data.usage[type] >= DAILY_LIMIT) {
    await saveUserData(req.username, data);
    return res.json({ allowed: false, remaining: 0, limit: DAILY_LIMIT });
  }
  data.usage[type] += 1;
  await saveUserData(req.username, data);
  res.json({ allowed: true, remaining: DAILY_LIMIT - data.usage[type], limit: DAILY_LIMIT });
});

// 오늘의 학습 콘텐츠(쉐도잉/딕테이션/패턴)를 가져온다. AI가 그날 처음 요청될 때 생성하고, 이후로는 캐시된 걸 재사용한다.
app.get('/api/content/:type/:level', requireAuth, async (req, res) => {
  const { type } = req.params;
  const level = parseInt(req.params.level, 10);
  if (!['shadowing', 'dictation', 'pattern', 'scramble'].includes(type)) {
    return res.status(400).json({ error: 'type은 shadowing, dictation, pattern, scramble 중 하나여야 해요.' });
  }
  if (!Number.isInteger(level) || level < 1 || level > 7) {
    return res.status(400).json({ error: 'level은 1~7 사이 숫자여야 해요.' });
  }
  try {
    const content = await getOrCreateDailyContent(type, level);
    res.json({ content });
  } catch (e) {
    console.error('콘텐츠 조회 오류:', e);
    res.status(500).json({ error: '콘텐츠를 불러오지 못했습니다.', content: FALLBACK_CONTENT[type] });
  }
});

/* ================= 선생님 API ================= */
app.get('/api/teacher/students', requireAuth, requireTeacher, async (req, res) => {
  try {
    const result = await pool.query("SELECT username, role, data FROM users WHERE role = 'student' ORDER BY username ASC");
    const students = [];
    for (const row of result.rows) {
      const data = row.data;
      if (rollUsageIfNeeded(data)) {
        await saveUserData(row.username, data);
      }
      students.push(sanitizeUser(row.username, row.role, data));
    }
    res.json({ students });
  } catch (e) {
    console.error('학생 목록 조회 오류:', e);
    res.status(500).json({ error: '학생 목록을 불러오지 못했습니다.' });
  }
});

// 학생 수강 중지/재개 (선생님 전용). 중지되면 그 학생은 로그인 및 모든 기능 접근이 즉시 막힌다.
app.post('/api/teacher/students/:username/active', requireAuth, requireTeacher, async (req, res) => {
  const targetUsername = req.params.username;
  const { active } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active 값은 true 또는 false여야 해요.' });
  }
  try {
    const row = await getUserRow(targetUsername);
    if (!row || row.role !== 'student') {
      return res.status(404).json({ error: '학생을 찾을 수 없어요.' });
    }
    const data = row.data;
    data.active = active;
    await saveUserData(targetUsername, data);
    res.json({ student: sanitizeUser(targetUsername, row.role, data) });
  } catch (e) {
    console.error('수강 상태 변경 오류:', e);
    res.status(500).json({ error: '수강 상태를 변경하지 못했습니다.' });
  }
});

// 특정 학생의 학습 활동 기록(문장별 점수, 작문 내용 등)을 선생님이 조회한다.
app.get('/api/teacher/students/:username/history', requireAuth, requireTeacher, async (req, res) => {
  const targetUsername = req.params.username;
  try {
    const row = await getUserRow(targetUsername);
    if (!row || row.role !== 'student') {
      return res.status(404).json({ error: '학생을 찾을 수 없어요.' });
    }
    const data = row.data;
    rollUsageIfNeeded(data);
    res.json({
      student: sanitizeUser(targetUsername, row.role, data),
      history: Array.isArray(data.history) ? data.history : []
    });
  } catch (e) {
    console.error('학생 기록 조회 오류:', e);
    res.status(500).json({ error: '학생 기록을 불러오지 못했습니다.' });
  }
});

// 학생 계정을 완전히 삭제한다 (되돌릴 수 없음). 삭제 후 같은 아이디로 다시 회원가입할 수 있다.
app.delete('/api/teacher/students/:username', requireAuth, requireTeacher, async (req, res) => {
  const targetUsername = req.params.username;
  try {
    const row = await getUserRow(targetUsername);
    if (!row || row.role !== 'student') {
      return res.status(404).json({ error: '학생을 찾을 수 없어요.' });
    }
    await pool.query('DELETE FROM users WHERE username = $1', [targetUsername]);
    res.json({ ok: true });
  } catch (e) {
    console.error('학생 삭제 오류:', e);
    res.status(500).json({ error: '학생 삭제에 실패했습니다.' });
  }
});

/* ================= AI 프록시 엔드포인트 ================= */
// 프론트엔드는 절대 API 키를 직접 다루지 않는다. 프론트엔드 -> 이 서버 -> Anthropic API 순서로만 호출된다.
app.post('/api/ai', requireAuth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY가 서버에 설정되어 있지 않습니다. .env 파일 또는 배포 환경변수를 확인하세요.'
    });
  }

  const { system, prompt } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: 'prompt가 필요합니다.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: system || undefined,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      let detail = errText;
      try {
        const parsed = JSON.parse(errText);
        detail = (parsed.error && parsed.error.message) || errText;
      } catch (_) { /* errText was not JSON, use as-is */ }
      return res.status(502).json({
        error: `AI 서비스 호출에 실패했습니다 (HTTP ${response.status}): ${detail}`
      });
    }

    const data = await response.json();
    const text = (data.content || [])
      .map((block) => block.text || '')
      .filter(Boolean)
      .join('\n');

    if (!text) {
      console.warn('Anthropic API returned no text content:', JSON.stringify(data));
      return res.status(502).json({ error: 'AI가 빈 응답을 반환했습니다. 다시 시도해주세요.' });
    }

    res.json({ text });
  } catch (err) {
    console.error('Server error calling Anthropic API:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 헬스체크 (배포 플랫폼이 앱 상태를 확인할 때 사용)
app.get('/api/health', async (req, res) => {
  let dbConnected = false;
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbConnected = true;
    } catch (e) {
      dbConnected = false;
    }
  }
  res.json({
    status: 'ok',
    ai_configured: !!ANTHROPIC_API_KEY,
    session_secret_configured: !!process.env.SESSION_SECRET,
    teacher_code_configured: !!process.env.TEACHER_SIGNUP_CODE,
    database_configured: !!DATABASE_URL,
    database_connected: dbConnected
  });
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Talk Pro server running on http://localhost:${PORT}`);
    if (!ANTHROPIC_API_KEY) {
      console.warn('⚠️  ANTHROPIC_API_KEY가 설정되지 않았습니다. AI 첨삭 기능이 동작하지 않습니다.');
    }
  });
});
