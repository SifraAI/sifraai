const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const { askSifra, ProviderError } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;

// All Sifra request limits live here.
const LIMITS = {
  apiPerMinute: 120,
  chatPerMinute: 15,
  chatPerDay: 150,
  maxImages: 2,
  maxImageBytes: 1_500_000,
  maxTotalImageBytes: 2_700_000,
  maxMessages: 16,
  maxMessageChars: 7000,
  maxContextChars: 28_000,
  maxJsonBody: '4mb'
};

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));

app.use(express.json({
  limit: LIMITS.maxJsonBody,
  type: 'application/json'
}));

app.use((req, res, next) => {
  res.setHeader('X-Request-Id', crypto.randomUUID());
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// Simple in-process rate limiting. No Redis, no external database.
const buckets = new Map();

function clientId(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
}

function cleanupBuckets() {
  if (buckets.size < 3000) return;
  const now = Date.now();

  for (const [key, value] of buckets) {
    if (value.resetAt <= now) buckets.delete(key);
  }
}

function checkLimit(key, max, windowMs) {
  cleanupBuckets();

  const now = Date.now();
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    const fresh = {
      count: 1,
      resetAt: now + windowMs
    };

    buckets.set(key, fresh);

    return {
      allowed: true,
      limit: max,
      remaining: Math.max(0, max - 1),
      resetAt: fresh.resetAt
    };
  }

  current.count += 1;

  return {
    allowed: current.count <= max,
    limit: max,
    remaining: Math.max(0, max - current.count),
    resetAt: current.resetAt
  };
}

function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const id = clientId(req);
    const result = checkLimit(`${name}:${id}`, max, windowMs);

    res.setHeader('RateLimit-Limit', String(result.limit));
    res.setHeader('RateLimit-Remaining', String(result.remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((result.resetAt - Date.now()) / 1000)
      );

      res.setHeader('Retry-After', String(retryAfter));

      return res.status(429).json({
        error: 'שלחת יותר מדי בקשות. נסה שוב בעוד מעט.',
        code: 'rate_limited',
        retryAfter
      });
    }

    next();
  };
}

app.use('/api', rateLimit(
  'api',
  LIMITS.apiPerMinute,
  60_000
));

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

function validateImages(input) {
  if (input == null) return [];

  if (!Array.isArray(input)) {
    throw Object.assign(new Error('images must be an array'), {
      status: 400
    });
  }

  if (input.length > LIMITS.maxImages) {
    throw Object.assign(new Error('Too many images'), {
      status: 413
    });
  }

  let totalBytes = 0;

  return input.map((image) => {
    const dataUrl =
      typeof image?.dataUrl === 'string'
        ? image.dataUrl
        : '';

    const match = dataUrl.match(
      /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/
    );

    if (!match || !ALLOWED_IMAGE_TYPES.has(match[1])) {
      throw Object.assign(
        new Error('Unsupported image format'),
        { status: 400 }
      );
    }

    const bytes = Math.floor((match[2].length * 3) / 4);

    if (bytes > LIMITS.maxImageBytes) {
      throw Object.assign(
        new Error('Image is too large'),
        { status: 413 }
      );
    }

    totalBytes += bytes;

    if (totalBytes > LIMITS.maxTotalImageBytes) {
      throw Object.assign(
        new Error('Images are too large'),
        { status: 413 }
      );
    }

    return { dataUrl };
  });
}

function validateMessages(body) {
  let messages = body?.messages;

  if (!Array.isArray(messages)) {
    const message =
      typeof body?.message === 'string'
        ? body.message.trim()
        : '';

    messages = message
      ? [{ role: 'user', content: message }]
      : [];
  }

  if (!messages.length) {
    throw Object.assign(
      new Error('Missing message'),
      { status: 400 }
    );
  }

  if (messages.length > LIMITS.maxMessages) {
    messages = messages.slice(-LIMITS.maxMessages);
  }

  let totalChars = 0;

  const clean = messages.map((message) => {
    const role = message?.role;
    const content =
      typeof message?.content === 'string'
        ? message.content.trim()
        : '';

    if (!['user', 'assistant'].includes(role) || !content) {
      throw Object.assign(
        new Error('Invalid chat message'),
        { status: 400 }
      );
    }

    if (content.length > LIMITS.maxMessageChars) {
      throw Object.assign(
        new Error('Message is too long'),
        { status: 413 }
      );
    }

    totalChars += content.length;

    return {
      role,
      content
    };
  });

  if (totalChars > LIMITS.maxContextChars) {
    throw Object.assign(
      new Error('Conversation is too long'),
      { status: 413 }
    );
  }

  if (clean[clean.length - 1].role !== 'user') {
    throw Object.assign(
      new Error('Last message must be from user'),
      { status: 400 }
    );
  }

  return clean;
}

app.post(
  '/api/chat',
  rateLimit(
    'chat-minute',
    LIMITS.chatPerMinute,
    60_000
  ),
  rateLimit(
    'chat-day',
    LIMITS.chatPerDay,
    86_400_000
  ),
  async (req, res) => {
    const abortController = new AbortController();

    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    try {
      const messages = validateMessages(req.body);
      const images = validateImages(req.body?.images);

      const result = await askSifra({
        messages,
        images,
        signal: abortController.signal
      });

      return res.json({
        answer: result.answer,
        model: result.model
      });
    } catch (error) {
      if (abortController.signal.aborted) return;

      if (error instanceof ProviderError) {
        console.error('AI provider error:', {
          status: error.status,
          code: error.code
        });

        if (error.status === 429) {
          return res.status(503).json({
            error: 'המודל עמוס כרגע. נסה שוב בעוד כמה שניות.',
            code: 'provider_busy'
          });
        }

        if (error.status === 402) {
          return res.status(503).json({
            error: 'שירות ה-AI אינו זמין כרגע.',
            code: 'provider_billing'
          });
        }

        if (error.status === 504) {
          return res.status(504).json({
            error: 'התגובה לקחה יותר מדי זמן. נסה שוב.',
            code: 'timeout'
          });
        }

        return res.status(502).json({
          error: 'לא הצלחתי לקבל תשובה כרגע. נסה שוב בעוד רגע.',
          code: 'provider_error'
        });
      }

      const status = Number(error?.status) || 500;

      const publicErrors = {
        400: 'הבקשה לא תקינה.',
        413: 'ההודעה או התמונה גדולות מדי.'
      };

      console.error(
        'Chat error:',
        error?.message || error
      );

      return res.status(status).json({
        error:
          publicErrors[status] ||
          'אירעה שגיאה. נסה שוב.',
        code: 'request_error'
      });
    }
  }
);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'sifra'
  });
});

app.use(express.static(
  path.join(__dirname, 'public'),
  {
    extensions: ['html'],
    maxAge:
      process.env.NODE_ENV === 'production'
        ? '1h'
        : 0,
    etag: true
  }
));

app.get('*', (_req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'הבקשה גדולה מדי.',
      code: 'payload_too_large'
    });
  }

  if (
    error instanceof SyntaxError &&
    'body' in error
  ) {
    return res.status(400).json({
      error: 'JSON לא תקין.',
      code: 'invalid_json'
    });
  }

  console.error(
    'Unhandled server error:',
    error
  );

  return res.status(500).json({
    error: 'אירעה שגיאה בשרת.',
    code: 'server_error'
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `Sifra running on http://localhost:${PORT}`
    );
  });
}

module.exports = app;
