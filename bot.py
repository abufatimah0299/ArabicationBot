"""
Arabication — Telegram bot uchun /start skripti
-------------------------------------------------
"""

import os
import asyncio
import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import Application, CommandHandler, ContextTypes

logging.basicConfig(level=logging.INFO)

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
    # Python 3.14 dagi asyncio event loop xatoligini oldini olish
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    print("Bot ishga tushdi...")
    app.run_polling()


if __name__ == "__main__":
    main()
