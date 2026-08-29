import os
import json
import asyncio
import logging
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

USERS_FILE = "users.json"

WELCOME_TEXT = (
    "Assalomu alaykum, {name}!\n\n"
    "Arabication — arab tilini o'rganish uchun mutlaqo bepul platforma. "
    "Test va mashqlarni bajaring, bilimlaringizni mustahkamlang, "
    "natijalaringizni kuzating va arab tilini bosqichma-bosqich rivojlantiring."
)
BUTTON_TEXT = "🚀 Platformani ochish"

# admin_id -> "ALL" yoki nishon foydalanuvchi ID (str). Kim kimga yozayotganini vaqtincha eslab turadi.
reply_target: dict[int, str] = {}


# --------------------------- foydalanuvchilar bazasi (JSON fayl) ---------------------------
def load_users() -> dict:
    if not os.path.exists(USERS_FILE):
        return {}
    try:
        with open(USERS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_users(users: dict) -> None:
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump(users, f, ensure_ascii=False, indent=2)


def register_user(user) -> None:
    users = load_users()
    users[str(user.id)] = {
        "id": user.id,
        "first_name": user.first_name or "",
        "username": user.username or "",
    }
    save_users(users)


def is_admin(user_id: int) -> bool:
    return user_id == ADMIN_ID


# --------------------------- /start ---------------------------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    register_user(user)
    name = user.first_name or "do'stim"

    keyboard = InlineKeyboardMarkup(
        [[InlineKeyboardButton(BUTTON_TEXT, web_app=WebAppInfo(url=WEBAPP_URL))]]
    )
    await update.message.reply_text(WELCOME_TEXT.format(name=name), reply_markup=keyboard)


# --------------------------- /admin ---------------------------
async def admin_panel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_admin(update.effective_user.id):
        return  # admin bo'lmagan odamga hech narsa qaytarmaymiz

    users = load_users()
    if not users:
        await update.message.reply_text("Hozircha ro'yxatdan o'tgan foydalanuvchi yo'q.")
        return

    buttons = []
    for uid, u in users.items():
        label = f"👤 {u['first_name']}" + (f" (@{u['username']})" if u["username"] else "")
        buttons.append([InlineKeyboardButton(label, callback_data=f"user_{uid}")])

    buttons.insert(0, [InlineKeyboardButton("📢 Hammaga xabar (ALL)", callback_data="broadcast_all")])

    await update.message.reply_text(
        f"Ro'yxatdagi foydalanuvchilar: {len(users)} ta\n\nKimga xabar yubormoqchisiz?",
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
        users = load_users()
        u = users.get(uid)
        name = u["first_name"] if u else uid
        reply_target[query.from_user.id] = uid
        await query.edit_message_text(
            f"✍️ Endi {name} ga yubormoqchi bo'lgan xabaringizni yozing.\n"
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

        users = load_users()
        if target == "ALL":
            sent, failed = 0, 0
            for uid in list(users.keys()):
                try:
                    await context.bot.copy_message(
                        chat_id=int(uid),
                        from_chat_id=message.chat_id,
                        message_id=message.message_id,
                    )
                    sent += 1
                except (Forbidden, BadRequest):
                    failed += 1
            await message.reply_text(f"✅ Yuborildi: {sent} ta\n⚠️ Yetib bormadi: {failed} ta (bot bloklangan bo'lishi mumkin)")
        else:
            try:
                await context.bot.copy_message(
                    chat_id=int(target),
                    from_chat_id=message.chat_id,
                    message_id=message.message_id,
                )
                await message.reply_text("✅ Xabar yuborildi.")
            except (Forbidden, BadRequest):
                await message.reply_text("⚠️ Yuborib bo'lmadi — foydalanuvchi botni bloklagan bo'lishi mumkin.")

        reply_target.pop(sender_id, None)

    else:
        # Oddiy foydalanuvchidan xabar keldi — adminga yo'naltiramiz
        register_user(update.effective_user)
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
