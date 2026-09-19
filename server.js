require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const { streamSifra, ProviderError } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || '');
let supabaseOrigin = null;

try {
  if (SUPABASE_URL) supabaseOrigin = new URL(SUPABASE_URL).origin;
} catch (_error) {
  console.error('SUPABASE_URL is not a valid URL.');
}

const LOGGING_TO_FILE = /^(?:1|true|yes|on)$/i.test(
  String(
    process.env.logging_to_file ??
    process.env.LOGGING_TO_FILE ??
    ''
  )
);

const CONTEXT_FILE =
  path.join(__dirname, 'context.md');

let contextStream = null;
let contextStreamFailed = false;

function ensureContextFile() {
  if (!LOGGING_TO_FILE) return;

  try {
    fs.closeSync(
      fs.openSync(CONTEXT_FILE, 'a')
    );
  } catch (error) {
    contextStreamFailed = true;
    console.error(
      'Failed to create context.md:',
      error?.message || error
    );
  }
}

function getContextStream() {
  if (
    !LOGGING_TO_FILE ||
    contextStreamFailed
  ) {
    return null;
  }

  if (!contextStream) {
    contextStream =
      fs.createWriteStream(
        CONTEXT_FILE,
        {
          flags: 'a',
          encoding: 'utf8'
        }
      );

    contextStream.on(
      'error',
      (error) => {
        contextStreamFailed = true;
        console.error(
          'context.md logging failed:',
          error?.message || error
        );
      }
    );
  }

  return contextStream;
}

function appendContext(text) {
  if (
    !LOGGING_TO_FILE ||
    contextStreamFailed ||
    !text
  ) {
    return Promise.resolve();
  }

  const stream =
    getContextStream();

  if (!stream) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    stream.write(
      String(text),
      'utf8',
      resolve
    );
  });
}

function sessionHeader({
  id,
  mode
}) {
  const now =
    new Date().toISOString();

  return (
    '\n\n---\n\n' +
    '# Sifra Session\n\n' +
    '- started: ' + now + '\n' +
    '- mode: ' + mode + '\n' +
    '- session: ' + id + '\n\n'
  );
}

ensureContextFile();

if (
  LOGGING_TO_FILE &&
  !process.env.SIFRA_SESSION_ID
) {
  fs.appendFileSync(
    CONTEXT_FILE,
    sessionHeader({
      id: 'server-' + process.pid,
      mode: 'npm start / direct'
    }),
    'utf8'
  );
}

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
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "blob:", ...(supabaseOrigin ? [supabaseOrigin] : [])],
      connectSrc: ["'self'", ...(supabaseOrigin ? [supabaseOrigin] : [])],
      mediaSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
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

function cleanChatName(value) {
  const words = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^["'״׳`]+|["'״׳`]+$/g, '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 3);

  return words.join(' ').slice(0, 72).trim();
}

function fallbackChatName(messages) {
  const firstUser = messages.find((message) => message.role === 'user');
  return cleanChatName(firstUser?.content) || 'שיחה חדשה';
}

function createChatNameFilter({ onText, onName }) {
  const openTag = '<setchatname>';
  const closeTag = '</setchatname>';
  let buffer = '';
  let insideTag = false;
  let foundName = false;

  function matchingSuffixLength(value, target) {
    const lower = value.toLowerCase();
    const maximum = Math.min(lower.length, target.length - 1);
    for (let length = maximum; length > 0; length -= 1) {
      if (lower.endsWith(target.slice(0, length))) return length;
    }
    return 0;
  }

  async function feed(token) {
    buffer += String(token || '');

    while (buffer) {
      if (insideTag) {
        const closeIndex = buffer.toLowerCase().indexOf(closeTag);
        if (closeIndex === -1) return;

        const name = cleanChatName(buffer.slice(0, closeIndex));
        buffer = buffer.slice(closeIndex + closeTag.length);
        insideTag = false;

        if (name && !foundName) {
          foundName = true;
          await onName(name);
        }
        continue;
      }

      const openIndex = buffer.toLowerCase().indexOf(openTag);
      if (openIndex !== -1) {
        if (openIndex > 0) await onText(buffer.slice(0, openIndex));
        buffer = buffer.slice(openIndex + openTag.length);
        insideTag = true;
        continue;
      }

      const held = matchingSuffixLength(buffer, openTag);
      const visibleLength = buffer.length - held;
      if (visibleLength > 0) await onText(buffer.slice(0, visibleLength));
      buffer = buffer.slice(visibleLength);
      return;
    }
  }

  async function finish() {
    if (!insideTag && buffer) await onText(buffer);
    buffer = '';
    return foundName;
  }

  return { feed, finish };
}

async function requireAuthenticatedUser(req, res, next) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({
      error: 'האימות עדיין לא הוגדר בשרת.',
      code: 'auth_not_configured'
    });
  }

  const authorization = String(req.get('authorization') || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({
      error: 'צריך להתחבר כדי להמשיך.',
      code: 'authentication_required'
    });
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${match[1]}`
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      return res.status(401).json({
        error: 'ההתחברות פגה. התחבר שוב.',
        code: 'invalid_session'
      });
    }

    const user = await response.json();
    if (!user?.id) throw new Error('Supabase returned an invalid user');
    req.user = { id: user.id };
    return next();
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      return res.status(503).json({
        error: 'שירות ההתחברות לא זמין כרגע.',
        code: 'auth_unavailable'
      });
    }

    console.error('Supabase auth verification failed:', error?.message || error);
    return res.status(503).json({
      error: 'לא ניתן לאמת את ההתחברות כרגע.',
      code: 'auth_unavailable'
    });
  }
}

app.post(
  '/api/chat',
  requireAuthenticatedUser,
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
    const abortController =
      new AbortController();

    let streamStarted = false;
    let contextRequestStarted = false;
    let contextRequestId = null;

    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    function sendEvent(
      event,
      payload
    ) {
      if (res.writableEnded) return;

      if (!streamStarted) {
        res.status(200);
        res.setHeader(
          'Content-Type',
          'text/event-stream; charset=utf-8'
        );
        res.setHeader(
          'Cache-Control',
          'no-cache, no-transform'
        );
        res.setHeader(
          'X-Accel-Buffering',
          'no'
        );

        streamStarted = true;
      }

      res.write(
        `event: ${event}\n` +
        `data: ${JSON.stringify(payload)}\n\n`
      );
    }

    try {
      const messages =
        validateMessages(req.body);

      const images =
        validateImages(req.body?.images);

      const firstResponse =
        req.body?.requestChatName === true &&
        !messages.some((message) => message.role === 'assistant');

      const requestedSubject =
        typeof req.body?.subject === 'string'
          ? req.body.subject
          : 'math';

      const subject =
        ['math', 'physics', 'chemistry'].includes(requestedSubject)
          ? requestedSubject
          : 'math';

      contextRequestId =
        String(
          res.getHeader('X-Request-Id') ||
          crypto.randomUUID()
        );

      if (LOGGING_TO_FILE) {
        const latestUser =
          messages
            .slice()
            .reverse()
            .find(
              (message) =>
                message.role === 'user'
            );

        await appendContext(
          '\n\n## Request — ' +
          new Date().toISOString() +
          '\n\n' +
          '- request: ' +
          contextRequestId +
          '\n' +
          '- images: ' +
          images.length +
          '\n' +
          '- subject: ' +
          subject +
          '\n\n' +
          '**User:**\n\n' +
          (
            latestUser?.content ||
            ''
          ) +
          '\n\n' +
          '**Assistant (live):**\n\n'
        );

        contextRequestStarted = true;
      }

      let emittedChatName = false;
      const emitVisibleToken = async (token) => {
        await appendContext(token);
        sendEvent('token', { text: token });
      };
      const emitChatName = async (name) => {
        if (emittedChatName) return;
        emittedChatName = true;
        sendEvent('chat_name', { name });
      };
      const chatNameFilter = firstResponse
        ? createChatNameFilter({ onText: emitVisibleToken, onName: emitChatName })
        : null;

      const result =
        await streamSifra({
          messages,
          images,
          firstResponse,
          subject,
          signal:
            abortController.signal,
          onToken: async (token) => {
            if (chatNameFilter) await chatNameFilter.feed(token);
            else await emitVisibleToken(token);
          }
        });

      if (chatNameFilter) {
        const foundName = await chatNameFilter.finish();
        if (!foundName) await emitChatName(fallbackChatName(messages));
      }

      if (
        LOGGING_TO_FILE &&
        contextRequestStarted
      ) {
        await appendContext(
          '\n\n**Model:** `' +
          String(
            result.model ||
            'unknown'
          ) +
          '`\n\n' +
          '<!-- end-request:' +
          contextRequestId +
          ' -->\n'
        );
      }

      sendEvent('done', {
        model: result.model
      });

      return res.end();
    } catch (error) {
      if (
        LOGGING_TO_FILE &&
        contextRequestStarted
      ) {
        await appendContext(
          '\n\n> [request error] ' +
          String(
            error?.message ||
            error ||
            'unknown error'
          ) +
          '\n\n<!-- end-request:' +
          contextRequestId +
          ' -->\n'
        );
      }

      if (
        abortController.signal.aborted
      ) {
        return;
      }

      if (error instanceof ProviderError) {
        console.error(
          'AI provider error:',
          {
            status: error.status,
            code: error.code
          }
        );

        let publicMessage =
          'לא הצלחתי לקבל תשובה כרגע. נסה שוב בעוד רגע.';

        let publicCode =
          'provider_error';

        if (
          error.status === 429 ||
          error.status === 503
        ) {
          publicMessage =
            'המודל עמוס כרגע. נסה שוב בעוד כמה שניות.';

          publicCode =
            'provider_busy';
        } else if (
          error.status === 402
        ) {
          publicMessage =
            'שירות ה-AI אינו זמין כרגע.';

          publicCode =
            'provider_billing';
        } else if (
          error.status === 504
        ) {
          publicMessage =
            'התגובה לקחה יותר מדי זמן. נסה שוב.';

          publicCode =
            'timeout';
        }

        if (streamStarted) {
          sendEvent('error', {
            error: publicMessage,
            code: publicCode
          });

          return res.end();
        }

        return res
          .status(
            error.status === 504
              ? 504
              : 503
          )
          .json({
            error: publicMessage,
            code: publicCode
          });
      }

      const status =
        Number(error?.status) || 500;

      const publicErrors = {
        400: 'הבקשה לא תקינה.',
        413: 'ההודעה או התמונה גדולות מדי.'
      };

      console.error(
        'Chat error:',
        error?.message || error
      );

      if (streamStarted) {
        sendEvent('error', {
          error:
            publicErrors[status] ||
            'אירעה שגיאה. נסה שוב.',
          code: 'request_error'
        });

        return res.end();
      }

      return res
        .status(status)
        .json({
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

app.get('/api/config', (_req, res) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(503).json({
      error: 'Supabase is not configured',
      code: 'supabase_not_configured'
    });
  }

  return res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY
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
