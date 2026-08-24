import os
import asyncio
import logging
from aiohttp import web
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


# Render port talab qilgani uchun soxta veb-sahifa
async def health_check(request):
    return web.Response(text="Bot ishlayapti!")


async def run_dummy_server():
    port = int(os.environ.get("PORT", 8080))
    server = web.Application()
    server.router.add_get("/", health_check)
    runner = web.AppRunner(server)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()


async def main() -> None:
    # 1. Port ochish (Render Web Service bepul ishlashi uchun)
    await run_dummy_server()

    # 2. Botni ishga tushirish
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    
    await app.initialize()
    await app.start()
    await app.updater.start_polling()
    print("Bot muvaffaqiyatli ishga tushdi...")

    # Doimiy fonda ushlab turish
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
