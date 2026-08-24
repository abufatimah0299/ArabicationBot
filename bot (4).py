"""
Arabication — Telegram bot uchun /start skripti
-------------------------------------------------
Bu skript /start bosilganda foydalanuvchiga salomlashuv matnini va
Mini App'ni ochadigan tugmani yuboradi.

O'RNATISH (bir marta):
    pip install python-telegram-bot==21.4

SOZLASH:
    1) Pastdagi BOT_TOKEN ni @BotFather dan olingan tokeningizga almashtiring.
    2) WEBAPP_URL ni platformangiz joylashgan HTTPS manzilga almashtiring
       (masalan, https://arabication.uz kabi — Telegram Mini App faqat
       HTTPS manzillar bilan ishlaydi, GitHub Pages/Vercel/Netlify mos keladi).
    3. Terminalda: python bot.py

Eslatma: Bu kod doim ishlab turishi kerak bo'lsa (foydalanuvchilar /start
bosganda javob olishi uchun), uni bir serverda (masalan Render.com,
Railway.app yoki VPS) doimiy ishlaydigan qilib joylashtirish kerak.
Kompyuteringizni o'chirsangiz, bot ham to'xtaydi.
"""

import os
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import Application, CommandHandler, ContextTypes

logging.basicConfig(level=logging.INFO)

# Tokenni GitHub'dagi kodga yozib qo'ymang! Hosting xizmatida (Render/Railway)
# "Environment Variables" bo'limiga BOT_TOKEN va WEBAPP_URL nomlari bilan qo'shasiz.
BOT_TOKEN = os.environ["BOT_TOKEN"]
WEBAPP_URL = os.environ["WEBAPP_URL"]

WELCOME_TEXT = (
    "Assalomu alaykum, {name}!\n\n"
    "Arabication — arab tilini o'rganish uchun mutlaqo bepul platforma. "
    "Test va mashqlarni bajaring, bilimlaringizni mustahkamlang, "
    "natijalaringizni kuzating va arab tilini bosqichma-bosqich rivojlantiring."
)

BUTTON_TEXT = "🚀 Platformani ochish"


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    name = user.first_name or "do'stim"

    keyboard = InlineKeyboardMarkup(
        [[InlineKeyboardButton(BUTTON_TEXT, web_app=WebAppInfo(url=WEBAPP_URL))]]
    )

    await update.message.reply_text(
        WELCOME_TEXT.format(name=name),
        reply_markup=keyboard,
    )


def main() -> None:
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    print("Bot ishga tushdi...")
    app.run_polling()


if __name__ == "__main__":
    main()
