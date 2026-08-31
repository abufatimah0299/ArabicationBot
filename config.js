// Vercel serverless function: /api/config.js
// Vercel'da /api ichidagi har bir fayl avtomatik serverless endpoint bo'ladi,
// shuning uchun bu yerda alohida vercel.json sozlash shart emas.
export default function handler(req, res) {
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
  res.setHeader('Content-Type', 'application/javascript');
  res.status(200).send(`window.APP_CONFIG = ${JSON.stringify(config)};`);
}
