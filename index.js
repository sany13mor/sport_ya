const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;

const supabase = (SUPABASE_URL && SUPABASE_KEY && SUPABASE_URL.startsWith('http')) 
    ? createClient(SUPABASE_URL, SUPABASE_KEY) 
    : null;

app.use(express.json());

// Карта отложенных уведомлений (snooze)
const snoozeMap = new Map();

// Хелпер отправки сообщений в Telegram
function sendTelegramMessage(chatId, text, replyMarkup) {
    if (!BOT_TOKEN) return;
    const payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const data = JSON.stringify(payload);
    const req = https.request({
        hostname: 'api.telegram.org',
        path: '/bot' + BOT_TOKEN + '/sendMessage',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    });
    req.on('error', (e) => console.error('TG API Error:', e));
    req.write(data);
    req.end();
}

// ---------------- API ДЛЯ РАБОТЫ С SUPABASE ----------------

// 1. Получение всех данных пользователя (профиль, настройки, отжимания за сегодня)
app.get('/api/user-data', async (req, res) => {
    const telegramId = req.query.telegram_id;
    if (!telegramId || !supabase) {
        return res.json({ status: 'error', message: 'No telegram_id or Supabase connection' });
    }

    try {
        // Настройки и профиль
        let { data: userSettings } = await supabase
            .from('user_settings')
            .select('*')
            .eq('telegram_id', String(telegramId))
            .single();

        // Записи отжиманий за сегодня (МСК / UTC)
        const startOfDay = new Date();
        startOfDay.setUTCHours(0,0,0,0);

        let { data: pushups } = await supabase
            .from('pushups')
            .select('*')
            .eq('telegram_id', String(telegramId))
            .gte('created_at', startOfDay.toISOString())
            .order('created_at', { ascending: false });

        res.json({
            status: 'ok',
            settings: userSettings || { weight: 80, height: 180, daily_goal: 100 },
            pushups: pushups || []
        });
    } catch (e) {
        console.error('Error fetching user data:', e);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 2. Сохранение параметров профиля (Вес и Рост)
app.post('/api/save-profile', async (req, res) => {
    const { telegram_id, weight, height } = req.body;
    if (!telegram_id || !supabase) {
        return res.status(400).json({ status: 'error', message: 'Invalid data' });
    }

    try {
        const { error } = await supabase
            .from('user_settings')
            .upsert({ 
                telegram_id: String(telegram_id), 
                weight: parseFloat(weight), 
                height: parseFloat(height) 
            }, { onConflict: 'telegram_id' });

        if (error) throw error;
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('Save profile error:', e);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 3. Сохранение настроек (Дневная цель)
app.post('/api/save-settings', async (req, res) => {
    const { telegram_id, daily_goal } = req.body;
    if (!telegram_id || !supabase) {
        return res.status(400).json({ status: 'error', message: 'Invalid data' });
    }

    try {
        const { error } = await supabase
            .from('user_settings')
            .upsert({ 
                telegram_id: String(telegram_id), 
                daily_goal: parseInt(daily_goal) 
            }, { onConflict: 'telegram_id' });

        if (error) throw error;
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('Save settings error:', e);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 4. Добавление подхода отжиманий
app.post('/api/add-pushup', async (req, res) => {
    const { telegram_id, count } = req.body;
    if (!telegram_id || !supabase || !count) {
        return res.status(400).json({ status: 'error', message: 'Invalid data' });
    }

    try {
        const { data, error } = await supabase
            .from('pushups')
            .insert([{ 
                telegram_id: String(telegram_id), 
                count: parseInt(count), 
                created_at: new Date().toISOString() 
            }])
            .select();

        if (error) throw error;
        res.json({ status: 'ok', record: data[0] });
    } catch (e) {
        console.error('Add pushup error:', e);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 5. Удаление подхода отжиманий
app.post('/api/delete-pushup', async (req, res) => {
    const { id } = req.body;
    if (!id || !supabase) {
        return res.status(400).json({ status: 'error', message: 'Invalid data' });
    }

    try {
        const { error } = await supabase
            .from('pushups')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('Delete pushup error:', e);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Webhook от Telegram для обработки кнопок в пушах
app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const update = req.body;
        if (update && update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;
            const data = cb.data;

            if (data.startsWith('add_')) {
                const count = parseInt(data.replace('add_', ''));
                if (supabase && count > 0) {
                    await supabase.from('pushups').insert([{
                        telegram_id: String(chatId),
                        count: count,
                        created_at: new Date().toISOString()
                    }]);
                }
                const ackPayload = JSON.stringify({
                    callback_query_id: cb.id,
                    text: 'Записано +' + count + ' отжиманий! 🔥',
                    show_alert: true
                });
                const ackReq = https.request({
                    hostname: 'api.telegram.org',
                    path: '/bot' + BOT_TOKEN + '/answerCallbackQuery',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ackPayload) }
                });
                ackReq.write(ackPayload);
                ackReq.end();

                sendTelegramMessage(chatId, '✅ <b>Записано +' + count + ' отжиманий!</b>\nОтличная работа! 💪');
            } else if (data.startsWith('snooze_')) {
                const mins = parseInt(data.replace('snooze_', ''));
                snoozeMap.set(String(chatId), Date.now() + mins * 60 * 1000);

                const ackPayload = JSON.stringify({
                    callback_query_id: cb.id,
                    text: 'Напоминание отложено на ' + mins + ' мин. ⏳',
                    show_alert: true
                });
                const ackReq = https.request({
                    hostname: 'api.telegram.org',
                    path: '/bot' + BOT_TOKEN + '/answerCallbackQuery',
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ackPayload) }
                });
                ackReq.write(ackPayload);
                ackReq.end();

                sendTelegramMessage(chatId, '⏰ Напомню об отжиманиях через <b>' + mins + ' минут</b>!');
            }
        }
        res.status(200).send('OK');
    } catch (e) {
        console.error('Webhook error:', e);
        res.status(500).send('Error');
    }
});

// Роут для рассылки пушей
app.get('/api/send-reminders', async (req, res) => {
    if (!supabase || !BOT_TOKEN) {
        return res.json({ status: 'error', message: 'Supabase or BOT_TOKEN not configured' });
    }
    try {
        const { data: users, error } = await supabase.from('user_settings').select('*');
        if (error) throw error;

        const now = new Date();
        const currentHour = (now.getUTCHours() + 3) % 24; // МСК (UTC+3)
        const currentMins = now.getUTCMinutes();
        const currentHM = (currentHour < 10 ? '0' : '') + currentHour + ':' + (currentMins < 10 ? '0' : '') + currentMins;

        let sentCount = 0;
        for (const user of users || []) {
            if (!user.notifications_enabled || !user.telegram_id) continue;

            const start = user.time_start || "09:00";
            const end = user.time_end || "22:00";

            if (currentHM < start || currentHM > end) continue;

            const snoozeUntil = snoozeMap.get(String(user.telegram_id));
            if (snoozeUntil && Date.now() < snoozeUntil) continue;

            const text = "🏋️ <b>Пора отжаться!</b>\nВыберите количество выполненных подходов или отложите уведомление:";
            const replyMarkup = {
                inline_keyboard: [
                    [
                        { text: "+10 🏋️", callback_data: "add_10" },
                        { text: "+20 🏋️", callback_data: "add_20" },
                        { text: "+30 🏋️", callback_data: "add_30" }
                    ],
                    [
                        { text: "⏳ 15 мин", callback_data: "snooze_15" },
                        { text: "⏳ 30 мин", callback_data: "snooze_30" },
                        { text: "⏳ 45 мин", callback_data: "snooze_45" },
                        { text: "⏳ 1 час", callback_data: "snooze_60" }
                    ]
                ]
            };
            sendTelegramMessage(user.telegram_id, text, replyMarkup);
            sentCount++;
        }
        res.json({ status: 'ok', sent: sentCount });
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// ---------------- MINI APP HTML ----------------
const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Fitness Tracker</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root {
            --bg-color: #0b0e14;
            --card-bg: #151b26;
            --card-border: rgba(255, 255, 255, 0.08);
            --input-bg: #1f2736;
            --text-main: #ffffff;
            --text-muted: #738194;
            --accent-green: #22c55e;
            --accent-green-hover: #16a34a;
            --accent-blue: #38bdf8;
            --tab-inactive: #64748b;
            --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            user-select: none;
            -webkit-user-select: none;
            -webkit-tap-highlight-color: transparent;
        }

        body {
            background-color: var(--bg-color);
            background-image: 
                radial-gradient(circle at 10% 0%, rgba(34, 197, 94, 0.12) 0%, transparent 40%),
                radial-gradient(circle at 90% 10%, rgba(56, 189, 248, 0.1) 0%, transparent 40%);
            color: var(--text-main);
            font-family: var(--font-family);
            min-height: 100vh;
            padding-bottom: calc(75px + env(safe-area-inset-bottom, 20px));
            padding-top: env(safe-area-inset-top, 10px);
            overflow-x: hidden;
        }

        .container {
            max-width: 460px;
            margin: 0 auto;
            padding: 12px 16px;
        }

        .screen { display: none; }
        .screen.active { display: block; animation: fadeIn 0.2s ease-in-out; }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 18px;
            padding: 16px;
            margin-bottom: 14px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.25);
        }

        .card-header-title {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--text-muted);
            margin-bottom: 12px;
        }

        .badge-card {
            display: flex;
            align-items: center;
            gap: 14px;
        }
        .badge-icon {
            width: 44px;
            height: 44px;
            border-radius: 50%;
            background: linear-gradient(135deg, #10b981 0%, #0ea5e9 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            font-weight: 800;
            color: #fff;
            box-shadow: 0 2px 10px rgba(16, 185, 129, 0.3);
        }
        .badge-info .subtitle {
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.6px;
            color: var(--text-muted);
            text-transform: uppercase;
        }
        .badge-info .title {
            font-size: 18px;
            font-weight: 800;
            color: #fff;
            margin-top: 2px;
        }

        .progress-content {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
        }
        .ring-container {
            position: relative;
            width: 105px;
            height: 105px;
            flex-shrink: 0;
        }
        .ring-svg {
            transform: rotate(-90deg);
            width: 100%;
            height: 100%;
        }
        .ring-bg {
            stroke: rgba(255, 255, 255, 0.08);
            stroke-width: 8;
            fill: none;
        }
        .ring-fill {
            stroke: url(#gradient);
            stroke-width: 8;
            fill: none;
            stroke-linecap: round;
            stroke-dasharray: 264;
            stroke-dashoffset: 264;
            transition: stroke-dashoffset 0.6s ease;
        }
        .ring-text {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 18px;
            font-weight: 800;
            color: #fff;
        }
        .stats-col { flex-grow: 1; }
        .stat-block { margin-bottom: 10px; }
        .stat-block:last-child { margin-bottom: 0; }
        .stat-num-main {
            font-size: 26px;
            font-weight: 800;
            color: #fff;
            line-height: 1.1;
        }
        .stat-num-blue {
            font-size: 22px;
            font-weight: 800;
            color: var(--accent-blue);
            line-height: 1.1;
        }
        .stat-lbl {
            font-size: 12px;
            color: var(--text-muted);
            margin-top: 2px;
        }

        .quick-buttons {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 8px;
            margin-bottom: 12px;
        }
        .btn-quick {
            background: var(--input-bg);
            border: 1px solid var(--card-border);
            border-radius: 10px;
            color: #fff;
            font-size: 14px;
            font-weight: 700;
            padding: 10px 0;
            text-align: center;
            cursor: pointer;
            transition: all 0.15s ease;
        }
        .btn-quick:active {
            transform: scale(0.95);
            background: #2a3447;
        }

        .input-row {
            display: flex;
            gap: 10px;
        }
        .custom-input {
            flex-grow: 1;
            background: var(--input-bg);
            border: 1px solid var(--card-border);
            border-radius: 12px;
            padding: 12px 14px;
            color: #fff;
            font-size: 15px;
            outline: none;
        }
        .custom-input::placeholder { color: var(--text-muted); }

        .btn-green {
            background: var(--accent-green);
            color: #fff;
            border: none;
            border-radius: 12px;
            padding: 12px 20px;
            font-size: 15px;
            font-weight: 700;
            cursor: pointer;
            transition: background 0.15s ease, transform 0.1s ease;
            white-space: nowrap;
        }
        .btn-green:active {
            background: var(--accent-green-hover);
            transform: scale(0.98);
        }
        .btn-full {
            width: 100%;
            display: block;
            margin-top: 14px;
            padding: 14px;
            text-align: center;
        }

        .sets-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .set-item {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.04);
            border-radius: 12px;
            padding: 12px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .set-count {
            font-size: 16px;
            font-weight: 800;
            color: var(--accent-green);
        }
        .set-time {
            font-size: 13px;
            color: var(--text-muted);
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .btn-del-set {
            color: #ef4444;
            background: none;
            border: none;
            font-size: 16px;
            cursor: pointer;
            padding: 0 4px;
        }

        .form-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        .form-row:last-child { border-bottom: none; }
        .form-label-box {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .form-label-main {
            font-size: 15px;
            font-weight: 600;
            color: #fff;
        }
        .form-label-sub {
            font-size: 12px;
            color: var(--text-muted);
        }
        .form-input-sm {
            width: 90px;
            background: var(--input-bg);
            border: 1px solid var(--card-border);
            border-radius: 10px;
            padding: 8px 10px;
            color: #fff;
            font-size: 15px;
            font-weight: 600;
            text-align: center;
            outline: none;
        }

        .bmi-box {
            background: var(--input-bg);
            border-radius: 12px;
            padding: 14px;
            text-align: center;
            margin-top: 12px;
        }
        .bmi-value {
            font-size: 24px;
            font-weight: 800;
            color: #fff;
        }
        .bmi-status {
            display: inline-block;
            margin-top: 6px;
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 700;
            background: rgba(34, 197, 94, 0.2);
            color: var(--accent-green);
        }

        .nav-bar {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            height: calc(65px + env(safe-area-inset-bottom, 15px));
            background: rgba(18, 24, 36, 0.94);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            display: flex;
            align-items: center;
            justify-content: space-around;
            padding-bottom: env(safe-area-inset-bottom, 15px);
            z-index: 999;
        }
        .nav-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 4px;
            color: var(--tab-inactive);
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            width: 20%;
            transition: color 0.15s ease;
        }
        .nav-item svg { width: 22px; height: 22px; fill: currentColor; }
        .nav-item.active { color: var(--accent-blue); }
    </style>
</head>
<body>

<div class="container">

    <!-- ГЛАВНАЯ -->
    <div id="screen-main" class="screen active">
        <div class="card badge-card">
            <div class="badge-icon">1</div>
            <div class="badge-info">
                <div class="subtitle">IOS FITNESS TRACKER</div>
                <div class="title" id="streak-days-text">Активный трекер</div>
            </div>
        </div>

        <div class="card">
            <div class="card-header-title">ДНЕВНОЙ ПРОГРЕСС</div>
            <div class="progress-content">
                <div class="ring-container">
                    <svg class="ring-svg" viewBox="0 0 100 100">
                        <defs>
                            <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stop-color="#22c55e" />
                                <stop offset="100%" stop-color="#38bdf8" />
                            </linearGradient>
                        </defs>
                        <circle class="ring-bg" cx="50" cy="50" r="42"></circle>
                        <circle id="ring-progress" class="ring-fill" cx="50" cy="50" r="42"></circle>
                    </svg>
                    <div class="ring-text" id="ring-pct">0%</div>
                </div>

                <div class="stats-col">
                    <div class="stat-block">
                        <div class="stat-num-main"><span id="today-total">0</span> / <span id="target-goal">100</span></div>
                        <div class="stat-lbl">Отжиманий сегодня</div>
                    </div>
                    <div class="stat-block">
                        <div class="stat-num-blue" id="today-sets-count">0</div>
                        <div class="stat-lbl">Выполнено подходов</div>
                    </div>
                </div>
            </div>
        </div>

        <div class="card">
            <div class="card-header-title">БЫСТРЫЙ ВВОД</div>
            <div class="quick-buttons">
                <div class="btn-quick" onclick="addQuick(15)">+15</div>
                <div class="btn-quick" onclick="addQuick(20)">+20</div>
                <div class="btn-quick" onclick="addQuick(25)">+25</div>
                <div class="btn-quick" onclick="addQuick(30)">+30</div>
                <div class="btn-quick" onclick="addQuick(35)">+35</div>
            </div>
            <div class="input-row">
                <input type="number" id="custom-count-input" class="custom-input" placeholder="Введите свое число..." inputmode="numeric">
                <button class="btn-green" onclick="submitCustomCount()">Записать</button>
            </div>
        </div>

        <div class="card">
            <div class="card-header-title">СЕГОДНЯШНИЕ ПОДХОДЫ</div>
            <div id="today-sets-list" class="sets-list"></div>
        </div>
    </div>

    <!-- ПРОФИЛЬ -->
    <div id="screen-profile" class="screen">
        <div class="card">
            <div class="card-header-title">КАРТОЧКА СПОРТСМЕНА</div>
            <div class="form-row">
                <div class="form-label-box">
                    <div class="form-label-main">Текущий вес</div>
                    <div class="form-label-sub">В килограммах</div>
                </div>
                <input type="number" id="prof-weight" class="form-input-sm" value="80" oninput="calcBMI()">
            </div>
            <div class="form-row">
                <div class="form-label-box">
                    <div class="form-label-main">Рост</div>
                    <div class="form-label-sub">В сантиметрах</div>
                </div>
                <input type="number" id="prof-height" class="form-input-sm" value="180" oninput="calcBMI()">
            </div>
            <div class="bmi-box">
                <div style="font-size:12px; color:var(--text-muted);">Индекс массы тела (ИМТ)</div>
                <div class="bmi-value" id="bmi-val">24.7</div>
                <div class="bmi-status" id="bmi-status-label">Норма</div>
            </div>
            <button class="btn-green btn-full" onclick="saveProfileData()">Сохранить профиль</button>
        </div>
    </div>

    <!-- НАСТРОЙКИ -->
    <div id="screen-settings" class="screen">
        <div class="card">
            <div class="card-header-title">ПАРАМЕТРЫ ТРЕНИРОВОК</div>
            <div class="form-row">
                <div class="form-label-box">
                    <div class="form-label-main">Дневная цель</div>
                    <div class="form-label-sub">Количество отжиманий</div>
                </div>
                <input type="number" id="set-daily-goal" class="form-input-sm" value="100">
            </div>
            <button class="btn-green btn-full" onclick="saveSettingsData()">Сохранить настройки</button>
        </div>
    </div>

</div>

<!-- Панель навигации -->
<div class="nav-bar">
    <div class="nav-item active" onclick="switchTab('main')">
        <svg viewBox="0 0 24 24"><path d="M3 13h4v8H3zm7-8h4v16h-4zm7 4h4v12h-4z"/></svg>
        <span>Главная</span>
    </div>
    <div class="nav-item" onclick="switchTab('profile')">
        <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        <span>Профиль</span>
    </div>
    <div class="nav-item" onclick="switchTab('settings')">
        <svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6-3.6 3.6z"/></svg>
        <span>Настройки</span>
    </div>
</div>

<script>
    const tg = window.Telegram?.WebApp;
    if (tg) {
        tg.ready();
        tg.expand();
    }

    // Извлечение Telegram ID
    const telegramId = tg?.initDataUnsafe?.user?.id || 123456789;

    let state = {
        dailyGoal: 100,
        todaySets: []
    };

    function triggerHaptic() {
        if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    }

    function switchTab(tabName) {
        triggerHaptic();
        const screens = ['main', 'profile', 'settings'];
        const navItems = document.querySelectorAll('.nav-item');

        screens.forEach((s, idx) => {
            const el = document.getElementById('screen-' + s);
            if (s === tabName) {
                el.classList.add('active');
                navItems[idx].classList.add('active');
            } else {
                el.classList.remove('active');
                navItems[idx].classList.remove('active');
            }
        });
    }

    // Загрузка данных из БД при открытии
    async function loadUserData() {
        try {
            const res = await fetch('/api/user-data?telegram_id=' + telegramId);
            const data = await res.json();
            
            if (data.status === 'ok') {
                if (data.settings) {
                    state.dailyGoal = data.settings.daily_goal || 100;
                    document.getElementById('prof-weight').value = data.settings.weight || 80;
                    document.getElementById('prof-height').value = data.settings.height || 180;
                    document.getElementById('set-daily-goal').value = state.dailyGoal;
                    calcBMI();
                }

                if (data.pushups) {
                    state.todaySets = data.pushups.map(item => ({
                        id: item.id,
                        count: item.count,
                        time: new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    }));
                }

                updateProgressUI();
            }
        } catch (e) {
            console.error('Data load error:', e);
        }
    }

    function updateProgressUI() {
        const total = state.todaySets.reduce((a, b) => a + b.count, 0);
        document.getElementById('today-total').innerText = total;
        document.getElementById('target-goal').innerText = state.dailyGoal;
        document.getElementById('today-sets-count').innerText = state.todaySets.length;

        const pct = Math.min(100, Math.round((total / state.dailyGoal) * 100)) || 0;
        document.getElementById('ring-pct').innerText = pct + '%';

        const circle = document.getElementById('ring-progress');
        const circumference = 2 * Math.PI * 42;
        const offset = circumference - (pct / 100) * circumference;
        circle.style.strokeDashoffset = offset;

        const listEl = document.getElementById('today-sets-list');
        listEl.innerHTML = '';
        if (state.todaySets.length === 0) {
            listEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px; text-align:center; padding:10px;">Подходов пока нет</div>';
        } else {
            state.todaySets.forEach((item, index) => {
                const div = document.createElement('div');
                div.className = 'set-item';
                div.innerHTML = '<span class="set-count">+' + item.count + '</span>' +
                                '<div class="set-time">' +
                                    '<span>' + item.time + '</span>' +
                                    '<button class="btn-del-set" onclick="deleteSet(' + index + ')">✕</button>' +
                                '</div>';
                listEl.appendChild(div);
            });
        }
    }

    async function addQuick(count) {
        triggerHaptic();
        try {
            const res = await fetch('/api/add-pushup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telegram_id: telegramId, count: count })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                const now = new Date();
                const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                state.todaySets.unshift({ id: data.record?.id, count: count, time: timeStr });
                updateProgressUI();
            }
        } catch (e) {
            console.error('Error adding pushup:', e);
        }
    }

    function submitCustomCount() {
        const input = document.getElementById('custom-count-input');
        const val = parseInt(input.value);
        if (val && val > 0) {
            addQuick(val);
            input.value = '';
        }
    }

    async function deleteSet(index) {
        triggerHaptic();
        const item = state.todaySets[index];
        if (item && item.id) {
            try {
                await fetch('/api/delete-pushup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: item.id })
                });
            } catch (e) {
                console.error('Error deleting pushup:', e);
            }
        }
        state.todaySets.splice(index, 1);
        updateProgressUI();
    }

    function calcBMI() {
        const w = parseFloat(document.getElementById('prof-weight').value);
        const h = parseFloat(document.getElementById('prof-height').value) / 100;
        if (w > 0 && h > 0) {
            const bmi = (w / (h * h)).toFixed(1);
            document.getElementById('bmi-val').innerText = bmi;
        }
    }

    // Сохранение веса и роста
    async function saveProfileData() {
        triggerHaptic();
        const weight = document.getElementById('prof-weight').value;
        const height = document.getElementById('prof-height').value;

        try {
            const res = await fetch('/api/save-profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telegram_id: telegramId, weight: weight, height: height })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                if (tg) tg.showAlert('Профиль успешно сохранен!');
            } else {
                if (tg) tg.showAlert('Ошибка сохранения: ' + data.message);
            }
        } catch (e) {
            console.error('Save error:', e);
        }
    }

    // Сохранение дневной цели
    async function saveSettingsData() {
        triggerHaptic();
        const newGoal = parseInt(document.getElementById('set-daily-goal').value);

        try {
            const res = await fetch('/api/save-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telegram_id: telegramId, daily_goal: newGoal })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                state.dailyGoal = newGoal;
                updateProgressUI();
                if (tg) tg.showAlert('Настройки сохранены!');
            }
        } catch (e) {
            console.error('Save settings error:', e);
        }
    }

    // Запуск при открытии
    loadUserData();
</script>
</body>
</html>`;

app.get('/webapp', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(HTML_PAGE);
});

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(HTML_PAGE);
});

app.listen(port, () => {
    console.log(`Server started on port ${port}`);
});
