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

function defaultUserData() {
  return {
    level: 3,
    levelChosen: false,
    xp: 0,
    streak: 0,
    active: true, // false로 바뀌면 수강 중지 상태 - 로그인/모든 API 접근이 막힌다
    progressDay: 1, // 실제로 그 날짜치를 완료해야만 다음 차수로 넘어가는 "진도" (달력 날짜와 무관)
    completed: { shadowing: false, dictation: false, pattern: false, diary: false },
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
    data.completed = { shadowing: false, dictation: false, pattern: false, diary: false };
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
  return changed;
}
function sanitizeUser(username, role, data) {
  return {
    username,
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
  const teacherCode = ((req.body && req.body.teacherCode) || '').trim();
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
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
    const data = defaultUserData();
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
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    return res.status(400).json({ error: '레벨은 1~6 사이 숫자여야 해요.' });
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
