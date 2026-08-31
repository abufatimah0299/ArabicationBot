import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Frontend uchun kerakli sozlamalarni .env fayldan o'qib, brauzerga
// window.APP_CONFIG sifatida beradi. Shu tufayli SUPABASE_URL, SUPABASE_ANON_KEY va
// ADMIN_TELEGRAM_IDS kabi qiymatlar js/app.js faylida qattiq yozilmaydi va
// GitHub'ga sir sifatida push qilinmaydi (ular faqat serverda .env orqali saqlanadi).
app.get('/config.js', (req, res) => {
  const config = {
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
    BOT_USERNAME: process.env.BOT_USERNAME || 'arabicationbot',
    WEBAPP_SHORT_NAME: process.env.WEBAPP_SHORT_NAME || '',
    ADMIN_TELEGRAM_IDS: (process.env.ADMIN_TELEGRAM_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number),
  };
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = ${JSON.stringify(config)};`);
});

// Serve static files from root directory and public directory
app.use(express.static(__dirname));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Fallback all routes to index.html for SPA support
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Arabication server running at http://${HOST}:${PORT}`);
});
