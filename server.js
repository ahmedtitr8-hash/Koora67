// Koora67 — أداة تسجيل فقط (بدون بث مباشر، بدون لوقو). تشتغل جوّا GitHub Actions،
// تسجّل من رابط تُعطى له، وعند الإيقاف تقسّم الفيديو النهائي لأجزاء تحت 50 ميجا
// وترفع كل جزء كفيديو حقيقي مباشرة لقناة تيليجرام.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const SOURCE_URL = process.env.SOURCE_URL;
const RECORDING_ID = process.env.RECORDING_ID || String(Date.now());
const RECORDING_LABEL = process.env.RECORDING_LABEL || RECORDING_ID;

const TEMP_DIR = path.join(__dirname, 'temp', RECORDING_ID); // مسار منفصل لكل تسجيل
const SEGMENT_DIR = path.join(TEMP_DIR, 'segments');
const SEGMENT_SECONDS = 600; // 10 دقايق لكل مقطع محلي (نفس مبدأ BarMi)
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024; // هامش أمان تحت حد تيليجرام (50 ميجا)

fs.mkdirSync(SEGMENT_DIR, { recursive: true });

function tgApi() {
  return `https://api.telegram.org/bot${BOT_TOKEN}`;
}

async function sendMessage(text, extra = {}) {
  try {
    const res = await fetch(`${tgApi()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHANNEL_ID_FOR_STATUS(), text, parse_mode: 'HTML', ...extra }),
    });
    return await res.json();
  } catch (err) {
    console.error(`[telegram] فشل إرسال رسالة: ${err.message}`);
  }
}

// رسائل الحالة (بدء/انتهاء/خطأ) تُرسل لنفس الشات اللي طلب التسجيل (STATUS_CHAT_ID)،
// بينما الفيديو النهائي يترفع لقناة العرض (CHANNEL_ID) — قد يكونان نفس الشيء
function CHANNEL_ID_FOR_STATUS() {
  return process.env.STATUS_CHAT_ID || CHANNEL_ID;
}

async function uploadVideoPartToChannel(localPath, caption) {
  const form = new FormData();
  form.append('chat_id', CHANNEL_ID);
  form.append('caption', caption);
  form.append('supports_streaming', 'true');
  form.append('video', fs.createReadStream(localPath));
  const contentLength = await new Promise((resolve, reject) => {
    form.getLength((err, length) => (err ? reject(err) : resolve(length)));
  });
  const res = await fetch(`${tgApi()}/sendVideo`, {
    method: 'POST',
    body: form,
    headers: { ...form.getHeaders(), 'Content-Length': String(contentLength) },
    duplex: 'half',
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error(`رد غير متوقع من تيليجرام (status ${res.status}): ${raw.slice(0, 300) || '(فاضي)'}`);
  }
  if (!data.ok) throw new Error(`فشل رفع الفيديو: ${data.description || res.status}`);
  return data.result;
}

/** يعيد محاولة الرفع عدة مرات بفاصل متصاعد — ما يستسلم بسرعة */
async function forceUpload(fn, label, maxAttempts = 15) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(`[force-upload] ${label} — محاولة ${attempt}/${maxAttempts} فشلت: ${err.message}`);
      if (attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, Math.min(5000 + attempt * 3000, 30000)));
    }
  }
  throw new Error(`فشل ${label} نهائيًا بعد ${maxAttempts} محاولة: ${lastErr?.message}`);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

/** يتفقد كل فترة هل انطلب إيقاف هالتسجيل تحديدًا (من زر البوت) — بدل الاعتماد على
 *  إلغاء المهمة نفسها (اللي وقتها قصير جدًا وما يكفي لإكمال الدمج والرفع بأمان) */
async function checkStopRequested() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/recordings?recording_id=eq.${RECORDING_ID}&select=status`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return rows[0]?.status === 'stop_requested';
  } catch (_) {
    return false; // فشل الاتصال مؤقتًا؟ نكمل التسجيل عادي، نحاول تاني بعد شوي
  }
}
async function markStatus(status) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/recordings?recording_id=eq.${RECORDING_ID}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status }),
    });
  } catch (_) {}
}

function runFfmpeg(args, logLabel) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    proc.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-2000); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${logLabel} فشل (code ${code}): ${stderrTail.slice(-400)}`));
    });
  });
}

function ffprobeDurationSeconds(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('close', () => {
      const sec = parseFloat(out.trim());
      Number.isNaN(sec) ? reject(new Error('تعذر قراءة مدة الفيديو')) : resolve(sec);
    });
  });
}

/** يسجّل من الرابط المُعطى، مقسّم لمقاطع محلية 10 دقايق، لين ما تنقطع أو توقف يدويًا
 *  (SIGTERM من إلغاء المهمة عن طريق Supabase) */
function startRecording() {
  const args = [
    '-y',
    '-re', '-fflags', '+genpts', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', SOURCE_URL,
    '-c', 'copy',
    '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-reset_timestamps', '1',
    '-segment_list', path.join(TEMP_DIR, 'list.txt'), '-segment_list_type', 'flat',
    path.join(SEGMENT_DIR, 'part_%03d.mp4'),
  ];
  return spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function finalize() {
  const listPath = path.join(TEMP_DIR, 'list.txt');
  let fileNames = [];
  try {
    fileNames = fs.readFileSync(listPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (_) {}

  if (!fileNames.length) {
    await sendMessage(`⚠️ <b>${RECORDING_LABEL}</b> — لم يُسجَّل أي مقطع، تأكد أن رابط البث صحيح ويعمل.`);
    return;
  }

  const concatListPath = path.join(TEMP_DIR, 'concat.txt');
  const concatContent = fileNames
    .map((f) => `file '${path.join(SEGMENT_DIR, f).replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(concatListPath, concatContent, 'utf8');

  const finalPath = path.join(TEMP_DIR, 'final.mp4');
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatListPath, '-c', 'copy', finalPath], 'دمج المقاطع');

  const stats = fs.statSync(finalPath);
  const partsPaths = [];
  if (stats.size > MAX_UPLOAD_BYTES) {
    const numParts = Math.ceil(stats.size / MAX_UPLOAD_BYTES);
    const durationSec = await ffprobeDurationSeconds(finalPath);
    const chunkSec = Math.ceil(durationSec / numParts);
    for (let i = 0; i < numParts; i++) {
      const chunkPath = path.join(TEMP_DIR, `part${i + 1}.mp4`);
      await runFfmpeg([
        '-y', '-ss', String(i * chunkSec), '-i', finalPath, '-t', String(chunkSec),
        '-c', 'copy', '-movflags', '+faststart', chunkPath,
      ], `تقسيم جزء ${i + 1}`);
      partsPaths.push(chunkPath);
    }
  } else {
    partsPaths.push(finalPath);
  }

  await sendMessage(`⬆️ <b>${RECORDING_LABEL}</b> — جاري رفع ${partsPaths.length} جزء لقناة تيليجرام...`);

  for (let i = 0; i < partsPaths.length; i++) {
    const caption = partsPaths.length > 1
      ? `${RECORDING_LABEL} — الجزء ${i + 1}/${partsPaths.length}`
      : RECORDING_LABEL;
    await forceUpload(() => uploadVideoPartToChannel(partsPaths[i], caption), `رفع الجزء ${i + 1}`);
  }

  await sendMessage(`✅ <b>${RECORDING_LABEL}</b> — اكتمل الرفع (${partsPaths.length} جزء) بالقناة.`);
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

async function main() {
  if (!SOURCE_URL) {
    await sendMessage('❌ ما فيه رابط بث محدد — تأكد من إرساله صح.');
    process.exit(1);
  }
  await markStatus('recording');
  await sendMessage(`🔴 <b>${RECORDING_LABEL}</b> — بدأ التسجيل.`);

  const proc = startRecording();

  // نتفقد كل 10 ثواني هل انطلب إيقاف من زر البوت — لو نعم، نوقف ffmpeg بلطف
  // (يقفل الملف الحالي بشكل سليم بدل ما يُقطع فجأة ويفسد آخر مقطع)
  const pollInterval = setInterval(async () => {
    if (await checkStopRequested()) {
      clearInterval(pollInterval);
      try { proc.stdin && proc.stdin.write('q'); } catch (_) {}
      setTimeout(() => { try { proc.kill('SIGTERM'); } catch (_) {} }, 5000);
    }
  }, 10000);

  await new Promise((resolve) => proc.on('close', resolve));
  clearInterval(pollInterval);
  await finalize();
  await markStatus('done');
}

main().catch(async (err) => {
  console.error(err);
  await sendMessage(`❌ <b>${RECORDING_LABEL}</b> — خطأ غير متوقع: ${err.message}`);
  process.exit(1);
});
