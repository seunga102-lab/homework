require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET 환경변수가 설정되어 있지 않습니다. 서버가 재시작되면 모든 로그인 세션이 초기화됩니다.');
}

const DAILY_LIMIT = 3;

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

function readDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return { users: {} };
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('DB 읽기 오류:', e);
    return { users: {} };
  }
}
function writeDB(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function todayKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function daysSince(dateStr) {
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
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30;
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

function defaultUserState() {
  return {
    level: 3,
    levelChosen: false,
    xp: 0,
    streak: 0,
    completed: { shadowing: false, dictation: false, pattern: false, diary: false },
    usage: { date: todayKST(), shadowing: 0, dictation: 0 },
    joinDate: todayKST()
  };
}
function rollUsageIfNeeded(user) {
  const today = todayKST();
  if (!user.usage || user.usage.date !== today) {
    user.usage = { date: today, shadowing: 0, dictation: 0 };
    user.completed = { shadowing: false, dictation: false, pattern: false, diary: false };
  }
  if (!user.joinDate) {
    user.joinDate = today;
  }
}
function sanitizeUser(username, user) {
  return {
    username,
    level: user.level,
    levelChosen: !!user.levelChosen,
    xp: user.xp,
    streak: user.streak,
    completed: user.completed,
    usage: user.usage,
    dailyLimit: DAILY_LIMIT,
    dayCount: daysSince(user.joinDate || todayKST())
  };
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const username = verifyToken(token);
  if (!username) {
    return res.status(401).json({ error: '로그인이 필요하거나 세션이 만료됐어요. 다시 로그인해주세요.' });
  }
  const db = readDB();
  if (!db.users[username]) {
    return res.status(401).json({ error: '계정을 찾을 수 없어요. 다시 로그인해주세요.' });
  }
  req.username = username;
  req.db = db;
  next();
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/signup', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: '아이디는 영문/숫자/밑줄만 사용해 3~20자로 입력해주세요.' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: '비밀번호는 4자 이상이어야 해요.' });
  }

  const db = readDB();
  if (db.users[username]) {
    return res.status(409).json({ error: '이미 사용 중인 아이디예요.' });
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  db.users[username] = { salt, passwordHash, ...defaultUserState() };
  writeDB(db);

  res.json({ token: createToken(username), user: sanitizeUser(username, db.users[username]) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }
  const db = readDB();
  const user = db.users[username];
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않아요.' });
  }
  rollUsageIfNeeded(user);
  writeDB(db);
  res.json({ token: createToken(username), user: sanitizeUser(username, user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = req.db.users[req.username];
  rollUsageIfNeeded(user);
  writeDB(req.db);
  res.json({ user: sanitizeUser(req.username, user) });
});

app.post('/api/me/level', requireAuth, (req, res) => {
  const { level } = req.body || {};
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    return res.status(400).json({ error: '레벨은 1~6 사이 숫자여야 해요.' });
  }
  const user = req.db.users[req.username];
  user.level = level;
  user.levelChosen = true;
  writeDB(req.db);
  res.json({ user: sanitizeUser(req.username, user) });
});

app.post('/api/me/progress', requireAuth, (req, res) => {
  const { xp, streak, completed } = req.body || {};
  const user = req.db.users[req.username];
  if (typeof xp === 'number') user.xp = xp;
  if (typeof streak === 'number') user.streak = streak;
  if (completed && typeof completed === 'object') user.completed = { ...user.completed, ...completed };
  writeDB(req.db);
  res.json({ user: sanitizeUser(req.username, user) });
});

app.post('/api/usage/increment', requireAuth, (req, res) => {
  const { type } = req.body || {};
  if (type !== 'shadowing' && type !== 'dictation') {
    return res.status(400).json({ error: 'type은 shadowing 또는 dictation이어야 해요.' });
  }
  const user = req.db.users[req.username];
  rollUsageIfNeeded(user);
  if (user.usage[type] >= DAILY_LIMIT) {
    writeDB(req.db);
    return res.json({ allowed: false, remaining: 0, limit: DAILY_LIMIT });
  }
  user.usage[type] += 1;
  writeDB(req.db);
  res.json({ allowed: true, remaining: DAILY_LIMIT - user.usage[type], limit: DAILY_LIMIT });
});

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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ai_configured: !!ANTHROPIC_API_KEY, session_secret_configured: !!process.env.SESSION_SECRET });
});

app.listen(PORT, () => {
  console.log(`Talk Pro server running on http://localhost:${PORT}`);
  if (!ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY가 설정되지 않았습니다. AI 첨삭 기능이 동작하지 않습니다.');
  }
});
