import { config } from "../config.js";

/** No-op if Telegram isn't configured — never blocks or throws on the caller's behalf. */
export async function sendTelegramMessage(text: string): Promise<void> {
  const { botToken, chatIds } = config.telegram;
  if (!botToken || chatIds.length === 0) return;

  await Promise.all(chatIds.map((chatId) => sendToOne(botToken, chatId, text)));
}

async function sendToOne(botToken: string, chatId: string, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!res.ok) {
      console.error(`Telegram notify failed for chat ${chatId}: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error(`Telegram notify failed for chat ${chatId}:`, err);
  }
}
