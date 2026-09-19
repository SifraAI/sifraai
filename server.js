require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const { streamSifra, ProviderError } = require('./ai');
const {
  renderLesson,
  ensureVideoEnvironment,
  removeJobFiles
} = require('./video');

const app = express();
const PORT = process.env.PORT || 3000;

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
  videoPerHour: 6,
  maxVideoJobs: 24,
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
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
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

      const result =
        await streamSifra({
          messages,
          images,
          signal:
            abortController.signal,
          onToken: async (token) => {
            // Write every provider token immediately, in the same order
            // it is streamed to the browser.
            await appendContext(token);

            sendEvent(
              'token',
              { text: token }
            );
          }
        });

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


const videoJobs = new Map();
let videoQueue = Promise.resolve();
let videoEnvironmentPromise = null;

function videoEnvironment() {
  if (!videoEnvironmentPromise) {
    videoEnvironmentPromise =
      ensureVideoEnvironment()
        .catch((error) => ({
          ok: false,
          results: [{
            command: 'environment',
            ok: false,
            error:
              error?.message ||
              String(error)
          }]
        }));
  }

  return videoEnvironmentPromise;
}

function videoJobPublic(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    fileUrl:
      job.status === 'ready'
        ? '/api/video/render/' +
          job.id +
          '/file'
        : null,
    posterUrl:
      job.status === 'ready'
        ? '/api/video/render/' +
          job.id +
          '/poster'
        : null,
    metadata:
      job.status === 'ready'
        ? job.metadata
        : null
  };
}

async function cleanupVideoJobs() {
  const now = Date.now();

  const removable =
    Array.from(videoJobs.values())
      .filter((job) => (
        (
          job.status === 'ready' ||
          job.status === 'error'
        ) &&
        now - job.createdAt >
          2 * 60 * 60 * 1000
      ));

  for (const job of removable) {
    videoJobs.delete(job.id);

    try {
      await removeJobFiles(job.id);
    } catch {}
  }

  if (
    videoJobs.size <=
    LIMITS.maxVideoJobs
  ) {
    return;
  }

  const oldest =
    Array.from(videoJobs.values())
      .filter((job) => (
        job.status === 'ready' ||
        job.status === 'error'
      ))
      .sort((a, b) =>
        a.createdAt - b.createdAt
      );

  while (
    videoJobs.size >
      LIMITS.maxVideoJobs &&
    oldest.length
  ) {
    const job = oldest.shift();

    videoJobs.delete(job.id);

    try {
      await removeJobFiles(job.id);
    } catch {}
  }
}

function queueVideoRender(job, lesson) {
  const task = async () => {
    job.status = 'checking';
    job.startedAt = Date.now();
    job.progress = 0.01;
    job.message =
      'בודק את מנוע הווידאו…';

    try {
      const environment =
        await videoEnvironment();

      if (!environment.ok) {
        const detail =
          environment.results
            ?.filter((item) => !item.ok)
            .map((item) =>
              item.command +
              ': ' +
              item.error
            )
            .join(' | ');

        throw new Error(
          'מנוע הווידאו לא מוכן. ' +
          (
            detail ||
            'בדוק FFmpeg, Node 22 ו-Hyperframes.'
          )
        );
      }

      job.status = 'rendering';

      const result =
        await renderLesson({
          lesson,
          jobId: job.id,
          onProgress(progress, message) {
            job.progress =
              Math.max(
                job.progress,
                Math.min(
                  1,
                  Number(progress) || 0
                )
              );

            if (message) {
              job.message =
                String(message);
            }
          }
        });

      job.status = 'ready';
      job.progress = 1;
      job.message = 'הסרטון מוכן';
      job.finishedAt = Date.now();
      job.outputPath =
        result.outputPath;
      job.posterPath =
        result.posterPath;
      job.metadata = {
        width:
          result.probe?.width ||
          1280,
        height:
          result.probe?.height ||
          720,
        duration:
          result.probe?.duration ||
          result.lesson?.duration ||
          null,
        codec:
          result.probe?.codec ||
          null,
        bytes:
          result.size ||
          null,
        renderer:
          'hyperframes'
      };
    } catch (error) {
      console.error(
        'Video render job failed:',
        {
          id: job.id,
          error:
            error?.message ||
            error
        }
      );

      job.status = 'error';
      job.progress = 1;
      job.finishedAt = Date.now();
      job.error =
        String(
          error?.message ||
          'יצירת הסרטון נכשלה.'
        )
        .slice(0, 1200);

      job.message =
        'יצירת הסרטון נכשלה';
    }
  };

  videoQueue =
    videoQueue
      .catch(() => {})
      .then(task);

  return videoQueue;
}

app.post(
  '/api/video/render',
  rateLimit(
    'video-hour',
    LIMITS.videoPerHour,
    60 * 60 * 1000
  ),
  async (req, res) => {
    await cleanupVideoJobs();

    const lesson =
      req.body?.lesson;

    if (
      !lesson ||
      typeof lesson !== 'object' ||
      !Array.isArray(lesson.scenes) ||
      !lesson.scenes.length
    ) {
      return res.status(400).json({
        error:
          'נתוני הסרטון לא תקינים.',
        code:
          'invalid_video_lesson'
      });
    }

    const id =
      crypto.randomUUID();

    const job = {
      id,
      status: 'queued',
      progress: 0,
      message:
        'ממתין למנוע הווידאו…',
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      outputPath: null,
      posterPath: null,
      metadata: null
    };

    videoJobs.set(
      id,
      job
    );

    queueVideoRender(
      job,
      lesson
    );

    return res
      .status(202)
      .json(
        videoJobPublic(job)
      );
  }
);

app.get(
  '/api/video/render/:id',
  (req, res) => {
    const job =
      videoJobs.get(
        req.params.id
      );

    if (!job) {
      return res.status(404).json({
        error:
          'הסרטון לא נמצא או שפג תוקפו.',
        code:
          'video_job_not_found'
      });
    }

    return res.json(
      videoJobPublic(job)
    );
  }
);

app.get(
  '/api/video/render/:id/file',
  (req, res) => {
    const job =
      videoJobs.get(
        req.params.id
      );

    if (
      !job ||
      job.status !== 'ready' ||
      !job.outputPath
    ) {
      return res.status(404).json({
        error:
          'קובץ הווידאו עדיין לא מוכן.',
        code:
          'video_file_not_ready'
      });
    }

    res.setHeader(
      'Content-Type',
      'video/mp4'
    );

    res.setHeader(
      'Content-Disposition',
      'inline; filename="sifra-' +
      job.id +
      '.mp4"'
    );

    return res.sendFile(
      job.outputPath
    );
  }
);

app.get(
  '/api/video/render/:id/poster',
  (req, res) => {
    const job =
      videoJobs.get(
        req.params.id
      );

    if (
      !job ||
      job.status !== 'ready' ||
      !job.posterPath
    ) {
      return res.status(404).end();
    }

    res.setHeader(
      'Content-Type',
      'image/jpeg'
    );

    return res.sendFile(
      job.posterPath
    );
  }
);

app.get(
  '/api/video/health',
  async (_req, res) => {
    const environment =
      await videoEnvironment();

    return res
      .status(
        environment.ok
          ? 200
          : 503
      )
      .json(environment);
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
