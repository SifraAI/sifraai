const express = require('express');
const path = require('path');
const { askSifra } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));

app.post('/api/chat', async (req, res) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'חסרה שאלה.' });
    if (message.length > 12000) return res.status(413).json({ error: 'השאלה ארוכה מדי.' });

    const answer = await askSifra(message);
    res.json({ answer });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'לא הצלחתי לקבל תשובה כרגע. נסה שוב בעוד רגע.' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Sifra running on http://localhost:${PORT}`));
}

module.exports = app;
