import os
import asyncio
import logging
import aiohttp
from aiohttp import web
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.error import Forbidden, BadRequest
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BOT_TOKEN = os.environ["BOT_TOKEN"]
WEBAPP_URL = os.environ["WEBAPP_URL"]
ADMIN_ID = int(os.environ["ADMIN_ID"])  # sizning shaxsiy Telegram ID'ingiz (masalan @userinfobot orqali bilib oling)
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_KEY"]  # service_role key tavsiya etiladi (bu faqat serverda, xavfsiz)

# /admin ro'yxatida bittada ko'rsatiladigan maksimal user soni (Telegram tugma cheklovi tufayli)
MAX_LISTED_USERS = 50

WELCOME_TEXT = (
    "Assalomu alaykum, {name}!\n\n"
    "Arabication — arab tilini o'rganish uchun mutlaqo bepul platforma. "
    "Test va mashqlarni bajaring, bilimlaringizni mustahkamlang, "
    "natijalaringizni kuzating va arab tilini bosqichma-bosqich rivojlantiring."
)
BUTTON_TEXT = "🚀 Platformani ochish"

# admin_id -> "ALL" yoki nishon foydalanuvchi ID (str). Kim kimga yozayotganini vaqtincha eslab turadi.
reply_target: dict[int, str] = {}


# --------------------------- foydalanuvchilar bazasi (Supabase) ---------------------------
async def fetch_users_from_supabase() -> list[dict]:
    """Supabase'dagi public.users jadvalidan barcha foydalanuvchilarni o'qiydi."""
    url = f"{SUPABASE_URL}/rest/v1/users?select=id,first_name,username&order=created_at.desc"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    logger.warning(f"Supabase'dan userlarni olishda xato ({resp.status}): {body}")
                    return []
                return await resp.json()
    except Exception as e:
        logger.warning(f"Supabase'ga ulanishda xato: {e}")
        return []


def is_admin(user_id: int) -> bool:
    return user_id == ADMIN_ID


# --------------------------- /start ---------------------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    # Foydalanuvchilar allaqachon WebApp orqali Supabase'ga yoziladi, bot alohida yozmaydi.
    name = user.first_name or "do'stim"

    keyboard = InlineKeyboardMarkup(
        [[InlineKeyboardButton(BUTTON_TEXT, web_app=WebAppInfo(url=WEBAPP_URL))]]
    )
    await update.message.reply_text(WELCOME_TEXT.format(name=name), reply_markup=keyboard)


# --------------------------- /admin ---------------------------
async def admin_panel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_admin(update.effective_user.id):
        return  # admin bo'lmagan odamga hech narsa qaytarmaymiz

    users = await fetch_users_from_supabase()
    if not users:
        await update.message.reply_text(
            "Foydalanuvchilar topilmadi (yoki Supabase'ga ulanishda xato). "
            "SUPABASE_URL / SUPABASE_KEY to'g'ri sozlanganini tekshiring."
        )
        return

    shown = users[:MAX_LISTED_USERS]
    buttons = []
    for u in shown:
        uid = u["id"]
        name = u.get("first_name") or "Noma'lum"
        username = u.get("username")
        label = f"👤 {name}" + (f" (@{username})" if username else "")
        buttons.append([InlineKeyboardButton(label, callback_data=f"user_{uid}")])

    buttons.insert(0, [InlineKeyboardButton("📢 Hammaga xabar (ALL)", callback_data="broadcast_all")])

    note = ""
    if len(users) > MAX_LISTED_USERS:
        note = f"\n\n(Faqat oxirgi {MAX_LISTED_USERS} tasi ko'rsatildi, jami {len(users)} ta bor)"

    await update.message.reply_text(
        f"Ro'yxatdagi foydalanuvchilar: {len(users)} ta{note}\n\nKimga xabar yubormoqchisiz?",
        reply_markup=InlineKeyboardMarkup(buttons),
    )


# --------------------------- tugma bosilganda ---------------------------
async def admin_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()

    if not is_admin(query.from_user.id):
        return

    data = query.data
    if data == "broadcast_all":
        reply_target[query.from_user.id] = "ALL"
        await query.edit_message_text(
            "✍️ Endi HAMMAGA yubormoqchi bo'lgan xabaringizni yozing (matn, rasm, video — hammasi bo'ladi).\n"
            "Bekor qilish uchun /cancel yuboring."
        )
    elif data.startswith("user_"):
        uid = data.split("_", 1)[1]
        reply_target[query.from_user.id] = uid
        await query.edit_message_text(
            f"✍️ Endi ID: {uid} ga yubormoqchi bo'lgan xabaringizni yozing.\n"
            "Bekor qilish uchun /cancel yuboring."
        )


# --------------------------- /cancel ---------------------------
async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if is_admin(update.effective_user.id):
        reply_target.pop(update.effective_user.id, None)
        await update.message.reply_text("Bekor qilindi.")


# --------------------------- barcha oddiy xabarlarni yo'naltirish ---------------------------
async def relay_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    sender_id = update.effective_user.id
    message = update.effective_message
    if message is None:
        return

    if is_admin(sender_id):
        # Admin xabar yozyapti — bu xabar kimgadir yo'naltirilishi kutilyaptimi?
        target = reply_target.get(sender_id)
        if not target:
            return  # admin oddiy shunchaki yozgan, hech kimga yo'naltirmaymiz

        if target == "ALL":
            users = await fetch_users_from_supabase()
            sent, failed = 0, 0
            failed_users = []
            for u in users:
                try:
                    await context.bot.copy_message(
                        chat_id=int(u["id"]),
                        from_chat_id=message.chat_id,
                        message_id=message.message_id,
                    )
                    sent += 1
                except (Forbidden, BadRequest):
                    failed += 1
                    failed_users.append(u)
                await asyncio.sleep(0.05)  # Telegram flood-limitiga tushmaslik uchun

            await message.reply_text(f"✅ Yuborildi: {sent} ta\n⚠️ Yetib bormadi: {failed} ta (bot bloklangan bo'lishi mumkin)")

            if failed_users:
                lines = []
                for u in failed_users:
                    name = u.get("first_name") or "Noma'lum"
                    username = u.get("username")
                    tag = f" (@{username})" if username else ""
                    lines.append(f"• {name}{tag} — ID: {u['id']}")
                # Telegram xabar uzunligi cheklovi (4096) sabab, ro'yxatni bo'laklarga bo'lib yuboramiz
                chunk = "🚫 Botni bloklagan/yetib bormagan foydalanuvchilar:\n\n"
                for line in lines:
                    if len(chunk) + len(line) > 3800:
                        await message.reply_text(chunk)
                        chunk = ""
                    chunk += line + "\n"
                if chunk.strip():
                    await message.reply_text(chunk)
        else:
            try:
                await context.bot.copy_message(
                    chat_id=int(target),
                    from_chat_id=message.chat_id,
                    message_id=message.message_id,
                )
                await message.reply_text("✅ Xabar yuborildi.")
            except (Forbidden, BadRequest):
                await message.reply_text(
                    f"⚠️ Yuborib bo'lmadi — ID: {target} bo'lgan foydalanuvchi botni bloklagan bo'lishi mumkin."
                )

        reply_target.pop(sender_id, None)

    else:
        # Oddiy foydalanuvchidan xabar keldi — adminga yo'naltiramiz
        user = update.effective_user
        header = (
            "✉️ Yangi xabar\n"
            f"👤 {user.first_name or ''} (@{user.username or 'username yoq'})\n"
            f"🆔 ID: {user.id}"
        )
        try:
            await context.bot.send_message(chat_id=ADMIN_ID, text=header)
            await context.bot.copy_message(
                chat_id=ADMIN_ID,
                from_chat_id=message.chat_id,
                message_id=message.message_id,
                reply_markup=InlineKeyboardMarkup(
                    [[InlineKeyboardButton("↩️ Javob berish", callback_data=f"user_{user.id}")]]
                ),
            )
        except Exception as e:
            logger.warning(f"Adminga yuborishda xato: {e}")


# --------------------------- Render uchun soxta veb-server ---------------------------
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
    await run_dummy_server()

    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("admin", admin_panel))
    app.add_handler(CommandHandler("cancel", cancel))
    app.add_handler(CallbackQueryHandler(admin_callback, pattern=r"^(user_|broadcast_all)"))
    app.add_handler(MessageHandler(filters.ALL & ~filters.COMMAND, relay_message))

    await app.initialize()
    await app.start()
    await app.updater.start_polling()
    print("Bot muvaffaqiyatli ishga tushdi...")

    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
