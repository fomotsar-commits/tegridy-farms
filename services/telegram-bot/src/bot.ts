import TelegramBot from 'node-telegram-bot-api';
import { formatEther, parseEther } from 'viem';
import { config } from './config.js';
import { startBind, completeBind } from './bind.js';
import type { Storage } from './storage.js';

/**
 * Telegram-side surface — commands the user can run in DM:
 *
 *   /start          — welcome + help
 *   /bind           — issue a signing challenge
 *   /bind 0x… 0x…   — submit address + signature
 *   /status         — show bound wallet (if any)
 *   /unbind         — drop the binding
 *   /threshold N    — set the restake-reward notification threshold (in ETH)
 *   /help           — list commands
 *
 * Everything else is ignored. Bot only replies in DMs (private chats).
 */
export function createBot(storage: Storage): TelegramBot {
  const bot = new TelegramBot(config.telegramBotToken, { polling: true });

  const reply = (chatId: number, text: string) =>
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', disable_web_page_preview: true });

  bot.onText(/^\/start\b/, (msg) => {
    void reply(
      msg.chat.id,
      [
        "*Welcome to the Tegridy Farms bot.*",
        "",
        "I'll DM you when on-chain events touch your wallet — lending offers filled, drops you minted selling out, gauge votes counted, restake rewards above your threshold.",
        "",
        "To bind your wallet:",
        "  1. `/bind` — I'll send you a challenge message.",
        "  2. Sign that exact message in your wallet.",
        "  3. `/bind <0xaddress> <0xsignature>` — I'll verify it.",
        "",
        "Type `/help` for the full command list.",
      ].join('\n'),
    );
  });

  bot.onText(/^\/help\b/, (msg) => {
    void reply(
      msg.chat.id,
      [
        "*Commands*",
        "`/start` — welcome + intro",
        "`/bind` — start binding a wallet",
        "`/bind 0x… 0x…` — complete binding with address + signature",
        "`/status` — show bound wallet",
        "`/unbind` — drop the binding",
        "`/threshold <eth>` — set restake-reward notification threshold (e.g. `/threshold 0.1`)",
      ].join('\n'),
    );
  });

  bot.onText(/^\/status\b/, (msg) => {
    const wallet = storage.getWallet(String(msg.chat.id));
    if (!wallet) {
      void reply(msg.chat.id, "No wallet bound. Run `/bind` to start.");
      return;
    }
    const threshold = storage.getRestakeMinWei(String(msg.chat.id));
    void reply(
      msg.chat.id,
      [
        `Bound wallet: \`${wallet}\``,
        `Restake-reward threshold: \`${formatEther(threshold)} ETH\``,
      ].join('\n'),
    );
  });

  bot.onText(/^\/unbind\b/, (msg) => {
    storage.unbind(String(msg.chat.id));
    void reply(msg.chat.id, "Binding cleared. I'll stop notifying this chat.");
  });

  // Three forms:
  //   /bind                                — issues a challenge
  //   /bind <address> <signature>          — completes the bind
  // We dispatch by argument count after the command word.
  bot.onText(/^\/bind(?:\s+(\S+)(?:\s+(\S+))?)?$/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const arg1 = match?.[1];
    const arg2 = match?.[2];
    if (!arg1 && !arg2) {
      const { message } = startBind(storage, chatId);
      void reply(
        msg.chat.id,
        [
          "Sign this exact message in your wallet (do not edit):",
          "",
          "```",
          message,
          "```",
          "",
          "Then send `/bind <address> <signature>` here. The challenge expires in 10 minutes.",
        ].join('\n'),
      );
      return;
    }
    if (!arg1 || !arg2) {
      void reply(msg.chat.id, "Usage: `/bind <address> <signature>`");
      return;
    }
    const result = await completeBind(storage, chatId, arg1, arg2);
    if (result.ok) {
      void reply(msg.chat.id, `Bound \`${result.address}\` to this chat. I'll DM you when relevant events fire.`);
    } else {
      const why: Record<typeof result.reason, string> = {
        'no-pending': "No pending challenge. Run `/bind` first.",
        'bad-address': "That doesn't look like a valid 0x address.",
        'bad-signature': "Signature couldn't be parsed.",
        'mismatch': "Signature doesn't match the challenge for this chat. Re-run `/bind` and try again.",
      };
      void reply(msg.chat.id, why[result.reason]);
    }
  });

  bot.onText(/^\/threshold\s+(\S+)$/, (msg, match) => {
    const ethStr = match?.[1];
    if (!ethStr) {
      void reply(msg.chat.id, "Usage: `/threshold <eth>` (example: `/threshold 0.1`)");
      return;
    }
    let wei: bigint;
    try {
      wei = parseEther(ethStr);
    } catch {
      void reply(msg.chat.id, "Couldn't parse that as ETH. Try `/threshold 0.05`.");
      return;
    }
    storage.setRestakeMinWei(String(msg.chat.id), wei);
    void reply(msg.chat.id, `Threshold set to \`${formatEther(wei)} ETH\`. I'll DM when claimable restake rewards exceed this.`);
  });

  bot.on('polling_error', (err) => {
    console.warn('[telegram] polling error:', err);
  });

  return bot;
}
