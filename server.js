require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// AI 프록시 엔드포인트: 프론트엔드는 절대 API 키를 직접 다루지 않는다.
// 프론트엔드 -> 이 서버 -> Anthropic API 순서로만 호출된다.
app.post('/api/ai', async (req, res) => {
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
      return res.status(502).json({ error: 'AI 서비스 호출에 실패했습니다.', detail: errText });
    }

    const data = await response.json();
    const text = (data.content || [])
      .map((block) => block.text || '')
      .filter(Boolean)
      .join('\n');

    res.json({ text });
  } catch (err) {
    console.error('Server error calling Anthropic API:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 헬스체크 (배포 플랫폼이 앱 상태를 확인할 때 사용)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ai_configured: !!ANTHROPIC_API_KEY });
});

app.listen(PORT, () => {
  console.log(`Talk Pro server running on http://localhost:${PORT}`);
  if (!ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY가 설정되지 않았습니다. AI 첨삭 기능이 동작하지 않습니다.');
  }
});
