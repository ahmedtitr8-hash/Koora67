// بوت التسجيل — دائم الاستماع (Webhook)، وظيفته بس: يبدأ التسجيل (يطلب الرابط،
// يشغّل Action)، ويوقفه (يعلّم الحالة "stop_requested" — السيرفر الشغّال نفسه يشوفها
// ويوقف بلطف ويرفع). ما يحتاج "يتبدّل" بين وضعين إطلاقًا — نفس الطريقة دايمًا.

const BOT_TOKEN = Deno.env.get("BOT_TOKEN") || "";
const CHANNEL_ID = Deno.env.get("CHANNEL_ID") || "";
const GH_PAT = Deno.env.get("GH_PAT") || "";
const GH_REPO = "ahmedtitr8-hash/Koora67";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
function sb(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: (init.headers as any)?.["Prefer"] || "return=representation",
      ...(init.headers || {}),
    },
  });
}
async function sbJson(path: string, init: RequestInit = {}) {
  const r = await sb(path, init);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function getSession(chatId: number) {
  const rows = await sbJson(`bot_sessions?chat_id=eq.${chatId}&select=*`);
  return rows[0] || null;
}
async function setSession(chatId: number, state: string, data: Record<string, unknown> = {}) {
  await sb(`bot_sessions`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ chat_id: chatId, state, data, updated_at: new Date().toISOString() }),
  });
}
async function clearSession(chatId: number) {
  await sb(`bot_sessions?chat_id=eq.${chatId}`, { method: "DELETE" });
}

const startKeyboard = {
  inline_keyboard: [[{ text: "🔴 بدء تسجيل", callback_data: "start_rec" }]],
};
function stopKeyboard(recordingId: string) {
  return { inline_keyboard: [[{ text: "⏹ إيقاف تسجيل", callback_data: `stop_rec:${recordingId}` }]] };
}

async function handleStart(chatId: number) {
  await clearSession(chatId);
  await tg("sendMessage", {
    chat_id: chatId,
    text: "أهلاً 👋 هذا بوت التسجيل — اضغط الزر تحت عشان تبدأ.",
    reply_markup: startKeyboard,
  });
}

async function triggerRecordingAction(recordingId: string, sourceUrl: string, chatId: number, label: string) {
  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/actions/workflows/record.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GH_PAT}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: "main",
        inputs: {
          source_url: sourceUrl,
          recording_id: recordingId,
          recording_label: label,
          status_chat_id: String(chatId),
        },
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`فشل تشغيل GitHub Action (status ${res.status}): ${text.slice(0, 300)}`);
  }
}

async function handleCallback(cb: any) {
  const chatId = cb.message.chat.id;
  const data: string = cb.data;
  await tg("answerCallbackQuery", { callback_query_id: cb.id });

  if (data === "start_rec") {
    await setSession(chatId, "awaiting_url", {});
    await tg("sendMessage", { chat_id: chatId, text: "أرسل رابط البث/الفيديو المطلوب تسجيله:" });
    return;
  }

  if (data.startsWith("stop_rec:")) {
    const recordingId = data.split(":")[1];
    await sb(`recordings?recording_id=eq.${recordingId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "stop_requested" }),
    });
    await tg("sendMessage", {
      chat_id: chatId,
      text: "⏳ طلب الإيقاف استُلم — بيوقف بلطف ويرفع خلال شوي.",
    });
    return;
  }
}

async function handleText(chatId: number, text: string, session: any) {
  if (!session || session.state !== "awaiting_url") return;
  const url = text.trim();
  const recordingId = `rec${Date.now()}`;
  const label = `تسجيل ${new Date().toLocaleString("ar-SA")}`;

  await sbJson(`recordings`, {
    method: "POST",
    body: JSON.stringify({ recording_id: recordingId, chat_id: chatId, label, status: "pending" }),
  });
  await clearSession(chatId);

  try {
    await triggerRecordingAction(recordingId, url, chatId, label);
    await tg("sendMessage", {
      chat_id: chatId,
      text: `🚀 جاري تجهيز التسجيل... بتوصلك رسالة "بدأ التسجيل" خلال دقيقة تقريبًا.`,
      reply_markup: stopKeyboard(recordingId),
    });
  } catch (err) {
    await tg("sendMessage", { chat_id: chatId, text: `❌ فشل بدء التسجيل: ${(err as Error).message}` });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok");
  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return new Response("ok");
    }

    const msg = update.message;
    if (!msg) return new Response("ok");
    const chatId = msg.chat.id;
    const text: string = msg.text || "";

    if (text === "/start" || text === "/help") {
      await handleStart(chatId);
    } else {
      const session = await getSession(chatId);
      await handleText(chatId, text, session);
    }
  } catch (e) {
    console.error(e);
  }

  return new Response("ok");
});
