const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const { Redis } = require('@upstash/redis');
const { Ratelimit } = require('@upstash/ratelimit');
const { askSifra, ProviderError } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '4mb', type: 'application/json' }));

app.use((req, res, next) => {
  res.setHeader('X-Request-Id', crypto.randomUUID());
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

const hasUpstash = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
let globalLimiter = null;
let chatMinuteLimiter = null;
let chatDayLimiter = null;

if (hasUpstash) {
  const redis = Redis.fromEnv();
  globalLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(Number(process.env.API_RATE_LIMIT || 120), '1 m'),
    prefix: 'sifra:api:global',
    enableTelemetry: false
  });
  chatMinuteLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(Number(process.env.CHAT_RATE_LIMIT_MINUTE || 15), '1 m'),
    prefix: 'sifra:chat:minute',
    enableTelemetry: false
  });
  chatDayLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(Number(process.env.CHAT_RATE_LIMIT_DAY || 150), '24 h'),
    prefix: 'sifra:chat:day',
    enableTelemetry: false
  });
} else if (process.env.NODE_ENV === 'production') {
  console.warn('Sifra: Upstash is not configured. Falling back to per-instance memory rate limits.');
}

const memoryBuckets = new Map();

function getClientId(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
}

function memoryLimit(key, limit, windowMs) {
  const now = Date.now();
  const current = memoryBuckets.get(key);

  if (!current || current.reset <= now) {
    const next = { count: 1, reset: now + windowMs };
    memoryBuckets.set(key, next);
    return { success: true, limit, remaining: limit - 1, reset: next.reset };
  }

  current.count += 1;
  return {
    success: current.count <= limit,
    limit,
    remaining: Math.max(0, limit - current.count),
    reset: current.reset
  };
}

function trimMemoryBuckets() {
  if (memoryBuckets.size < 2000) return;
  const now = Date.now();
  for (const [key, value] of memoryBuckets) {
    if (value.reset <= now) memoryBuckets.delete(key);
  }
}

async function runLimiter(limiter, fallbackKey, fallbackLimit, fallbackWindowMs, id) {
  if (limiter) return limiter.limit(id);
  trimMemoryBuckets();
  return memoryLimit(`${fallbackKey}:${id}`, fallbackLimit, fallbackWindowMs);
}

function rateLimitMiddleware(kind) {
  return async (req, res, next) => {
    try {
      const id = getClientId(req);
      let result;

      if (kind === 'global') {
        const limit = Number(process.env.API_RATE_LIMIT || 120);
        result = await runLimiter(globalLimiter, 'api', limit, 60_000, id);
      } else if (kind === 'chat-minute') {
        const limit = Number(process.env.CHAT_RATE_LIMIT_MINUTE || 15);
        result = await runLimiter(chatMinuteLimiter, 'chat-minute', limit, 60_000, id);
      } else {
        const limit = Number(process.env.CHAT_RATE_LIMIT_DAY || 150);
        result = await runLimiter(chatDayLimiter, 'chat-day', limit, 86_400_000, id);
      }

      res.setHeader('RateLimit-Limit', String(result.limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, result.remaining ?? 0)));
      res.setHeader('RateLimit-Reset', String(Math.ceil((result.reset || Date.now()) / 1000)));

      if (!result.success) {
        const retrySeconds = Math.max(1, Math.ceil(((result.reset || Date.now() + 1000) - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retrySeconds));
        return res.status(429).json({
          error: 'שלחת יותר מדי בקשות. נסה שוב בעוד מעט.',
          code: 'rate_limited',
          retryAfter: retrySeconds
        });
      }

      next();
    } catch (error) {
      console.error('Rate limiter failed:', error?.message || error);
      return res.status(503).json({ error: 'השירות עמוס כרגע. נסה שוב בעוד רגע.', code: 'rate_limit_unavailable' });
    }
  };
}

app.use('/api', rateLimitMiddleware('global'));

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_TOTAL_IMAGE_BYTES = 2_700_000;
const MAX_IMAGES = 2;
const MAX_MESSAGES = 16;
const MAX_MESSAGE_CHARS = 7000;
const MAX_CONTEXT_CHARS = 28_000;

function validateImages(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw Object.assign(new Error('images must be an array'), { status: 400 });
  if (input.length > MAX_IMAGES) throw Object.assign(new Error(`Maximum ${MAX_IMAGES} images per message`), { status: 413 });

  let totalBytes = 0;

  return input.map((image) => {
    const dataUrl = typeof image?.dataUrl === 'string' ? image.dataUrl : '';
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match || !ALLOWED_IMAGE_TYPES.has(match[1])) {
      throw Object.assign(new Error('Unsupported image format'), { status: 400 });
    }

    const bytes = Math.floor((match[2].length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) throw Object.assign(new Error('Image is too large'), { status: 413 });
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw Object.assign(new Error('Images are too large'), { status: 413 });

    return { dataUrl };
  });
}

function validateMessages(body) {
  let messages = body?.messages;

  if (!Array.isArray(messages)) {
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    messages = message ? [{ role: 'user', content: message }] : [];
  }

  if (!messages.length) throw Object.assign(new Error('Missing message'), { status: 400 });
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);

  let totalChars = 0;
  const clean = messages.map((message) => {
    const role = message?.role;
    const content = typeof message?.content === 'string' ? message.content.trim() : '';

    if (!['user', 'assistant'].includes(role) || !content) {
      throw Object.assign(new Error('Invalid chat message'), { status: 400 });
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      throw Object.assign(new Error('Message is too long'), { status: 413 });
    }

    totalChars += content.length;
    return { role, content };
  });

  if (totalChars > MAX_CONTEXT_CHARS) {
    throw Object.assign(new Error('Conversation is too long'), { status: 413 });
  }
  if (clean[clean.length - 1].role !== 'user') {
    throw Object.assign(new Error('Last message must be from the user'), { status: 400 });
  }

  return clean;
}

app.post(
  '/api/chat',
  rateLimitMiddleware('chat-minute'),
  rateLimitMiddleware('chat-day'),
  async (req, res) => {
    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abortController.abort();
    });

    try {
      const messages = validateMessages(req.body);
      const images = validateImages(req.body?.images);
      const result = await askSifra({ messages, images, signal: abortController.signal });

      res.json({
        answer: result.answer,
        model: result.model
      });
    } catch (error) {
      if (abortController.signal.aborted) return;

      if (error instanceof ProviderError) {
        console.error('AI provider error:', { status: error.status, code: error.code });

        if (error.status === 429) {
          return res.status(503).json({ error: 'המודל עמוס כרגע. נסה שוב בעוד כמה שניות.', code: 'provider_busy' });
        }
        if (error.status === 402) {
          return res.status(503).json({ error: 'שירות ה-AI אינו זמין כרגע.', code: 'provider_billing' });
        }
        if (error.status === 504) {
          return res.status(504).json({ error: 'התגובה לקחה יותר מדי זמן. נסה שוב.', code: 'timeout' });
        }

        return res.status(502).json({ error: 'לא הצלחתי לקבל תשובה כרגע. נסה שוב בעוד רגע.', code: 'provider_error' });
      }

      const status = Number(error?.status) || 500;
      const messages = {
        400: 'הבקשה לא תקינה.',
        413: 'ההודעה או התמונה גדולות מדי.'
      };

      console.error('Chat error:', error?.message || error);
      return res.status(status).json({ error: messages[status] || 'אירעה שגיאה. נסה שוב.', code: 'request_error' });
    }
  }
);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'sifra' });
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true
}));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'הבקשה גדולה מדי.', code: 'payload_too_large' });
  }
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'JSON לא תקין.', code: 'invalid_json' });
  }

  console.error('Unhandled server error:', error);
  res.status(500).json({ error: 'אירעה שגיאה בשרת.', code: 'server_error' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Sifra running on http://localhost:${PORT}`));
}

module.exports = app;
