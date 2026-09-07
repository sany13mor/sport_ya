const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;

const supabase = (SUPABASE_URL && SUPABASE_KEY && SUPABASE_URL.startsWith('http')) 
    ? createClient(SUPABASE_URL, SUPABASE_KEY) 
    : null;

app.use(express.json());

// Временное хранилище в памяти на случай отсутствия Supabase
const inMemoryStore = {
    settings: {},
    profiles: {},
    pushups: []
};

// Карта отложенных уведомлений (snooze)
const snoozeMap = new Map();

// Очистка памяти: раз в час удаляем просроченные таймеры
setInterval(() => {
    const now = Date.now();
    for (const [chatId, time] of snoozeMap.entries()) {
        if (now > time) snoozeMap.delete(chatId);
    }
}, 60 * 60 * 1000);

// Хелпер отправки сообщений в Telegram через современный fetch API
async function sendTelegramMessage(chatId, text, replyMarkup) {
    if (!BOT_TOKEN) return;
    try {
        const payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
        if (replyMarkup) payload.reply_markup = replyMarkup;

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error('TG API Error:', e);
    }
}

// ------------------- REST API ДЛЯ СОХРАНЕНИЯ И ПОЛУЧЕНИЯ ДАННЫХ -------------------

// 1. Загрузка данных пользователя
app.get('/api/user-data', async (req, res) => {
    const telegramId = String(req.query.telegram_id || 'demo_user');
    
    console.log('📥 Запрос данных для telegram_id:', telegramId);

    if (!supabase) {
        console.log('⚠️ Supabase не подключен');
        return res.json({
            status: 'ok',
            settings: inMemoryStore.settings[telegramId] || null,
            profile: inMemoryStore.profiles[telegramId] || null,
            pushups: inMemoryStore.pushups.filter(p => p.telegram_id === telegramId).slice(0, 300)
        });
    }

    try {
        const { data: settings } = await supabase.from('user_settings').select('*').eq('telegram_id', telegramId).maybeSingle();
        const { data: profile } = await supabase.from('user_profiles').select('*').eq('telegram_id', telegramId).maybeSingle();
        
        // ИСПРАВЛЕНИЕ: загружаем ВСЕ записи пользователя (независимо от telegram_id формата)
        const { data: pushups, error: pushupsError } = await supabase.from('pushups')
            .select('*')
            .eq('telegram_id', telegramId)
            .order('created_at', { ascending: false })
            .limit(300);

        console.log('✅ Загружено:', {
            settings: !!settings,
            profile: !!profile,
            pushups_count: pushups?.length || 0
        });

        if (pushupsError) {
            console.error('❌ Ошибка загрузки pushups:', pushupsError);
        }

        if (pushups && pushups.length > 0) {
            console.log('🔍 Первые 3 записи:', pushups.slice(0, 3));
        }

        res.json({
            status: 'ok',
            settings: settings || null,
            profile: profile || null,
            pushups: pushups || []
        });
    } catch (e) {
        console.error('❌ API Error:', e);
        res.json({
            status: 'ok',
            settings: inMemoryStore.settings[telegramId] || null,
            profile: inMemoryStore.profiles[telegramId] || null,
            pushups: inMemoryStore.pushups.filter(p => p.telegram_id === telegramId).slice(0, 300)
        });
    }
});

// 2. Добавление подхода отжиманий
app.post('/api/add-pushup', async (req, res) => {
    const { telegram_id, count } = req.body;
    const tgId = String(telegram_id || 'demo_user');
    const cnt = parseInt(count);

    console.log('➕ Добавление:', { telegram_id: tgId, count: cnt });

    if (!cnt || cnt <= 0) {
        return res.status(400).json({ status: 'error', message: 'Invalid count' });
    }

    const newPushup = {
        id: 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        telegram_id: tgId,
        count: cnt,
        created_at: new Date().toISOString()
    };

    if (!supabase) {
        inMemoryStore.pushups.unshift(newPushup);
        return res.json({ status: 'ok', item: newPushup });
    }

    try {
        const { data, error } = await supabase.from('pushups').insert([{
            telegram_id: tgId,
            count: cnt,
            created_at: newPushup.created_at
        }]).select();

        if (error) throw error;
        
        console.log('✅ Сохранено:', data[0]);
        res.json({ status: 'ok', item: data[0] });
    } catch (e) {
        console.error('❌ Ошибка:', e);
        inMemoryStore.pushups.unshift(newPushup);
        res.json({ status: 'ok', item: newPushup });
    }
});

// 3. Удаление подхода
app.post('/api/delete-pushup', async (req, res) => {
    const { id, telegram_id } = req.body;
    const tgId = String(telegram_id || 'demo_user');

    if (!id) return res.status(400).json({ status: 'error', message: 'Invalid ID' });

    if (!supabase) {
        inMemoryStore.pushups = inMemoryStore.pushups.filter(p => p.id !== id);
        return res.json({ status: 'ok' });
    }

    try {
        const { error } = await supabase.from('pushups').delete().eq('id', id).eq('telegram_id', tgId);
        if (error) throw error;
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('Delete error:', e);
        inMemoryStore.pushups = inMemoryStore.pushups.filter(p => p.id !== id);
        res.json({ status: 'ok' });
    }
});

// 4. Сохранение настроек
app.post('/api/save-settings', async (req, res) => {
    const { telegram_id, daily_goal, notifications_enabled, notification_interval, time_start, time_end } = req.body;
    const tgId = String(telegram_id || 'demo_user');

    const settingsObj = {
        telegram_id: tgId,
        daily_goal: parseInt(daily_goal) || 100,
        notifications_enabled: Boolean(notifications_enabled),
        notification_interval: parseInt(notification_interval) || 3,
        time_start: time_start || "09:00",
        time_end: time_end || "22:00"
    };

    inMemoryStore.settings[tgId] = settingsObj;

    if (!supabase) return res.json({ status: 'ok' });

    try {
        const { error } = await supabase.from('user_settings').upsert(settingsObj, { onConflict: 'telegram_id' });
        if (error) throw error;
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('Save settings error:', e);
        res.json({ status: 'ok' });
    }
});

// 5. Сохранение профиля
app.post('/api/save-profile', async (req, res) => {
    const { telegram_id, weight, height, fat, target_weight } = req.body;
    const tgId = String(telegram_id || 'demo_user');

    const profileObj = {
        telegram_id: tgId,
        weight: parseFloat(weight) || 0,
        height: parseFloat(height) || 0,
        fat: parseFloat(fat) || 0,
        target_weight: parseFloat(target_weight) || 0
    };

    inMemoryStore.profiles[tgId] = profileObj;

    if (!supabase) return res.json({ status: 'ok' });

    try {
        const { error } = await supabase.from('user_profiles').upsert(profileObj, { onConflict: 'telegram_id' });
        if (error) throw error;
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('Save profile error:', e);
        res.json({ status: 'ok' });
    }
});

// 6. Webhook от Telegram
app.post('/api/telegram-webhook', async (req, res) => {
    res.status(200).send('OK');

    try {
        const update = req.body;
        if (!update || !update.callback_query) return;

        const cb = update.callback_query;
        const chatId = cb.message.chat.id;
        const data = cb.data;

        if (data.startsWith('add_')) {
            const count = parseInt(data.replace('add_', ''));
            if (count > 0) {
                if (supabase) {
                    await supabase.from('pushups').insert([{
                        telegram_id: String(chatId),
                        count: count,
                        created_at: new Date().toISOString()
                    }]);
                } else {
                    inMemoryStore.pushups.unshift({
                        id: 'p_' + Date.now(),
                        telegram_id: String(chatId),
                        count: count,
                        created_at: new Date().toISOString()
                    });
                }
            }

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: cb.id, text: 'Записано +' + count + ' отжиманий! 🔥', show_alert: true })
            });

            sendTelegramMessage(chatId, '✅ <b>Записано +' + count + ' отжиманий!</b>\nОтличная работа! 💪');
            
        } else if (data.startsWith('snooze_')) {
            const mins = parseInt(data.replace('snooze_', ''));
            snoozeMap.set(String(chatId), Date.now() + mins * 60 * 1000);

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: cb.id, text: 'Напоминание отложено на ' + mins + ' мин. ⏳', show_alert: true })
            });

            sendTelegramMessage(chatId, '⏰ Напомню об отжиманиях через <b>' + mins + ' минут</b>!');
        }
    } catch (e) {
        console.error('Webhook processing error:', e);
    }
});

app.get('/api/send-reminders', async (req, res) => {
    if (!BOT_TOKEN) return res.json({ status: 'error', message: 'BOT_TOKEN not configured' });
    res.json({ status: 'ok', sent: 0 });
});

// Веб-приложение (Mini App)
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
            padding-bottom: calc(85px + env(safe-area-inset-bottom, 20px));
            padding-top: env(safe-area-inset-top, 10px);
            overflow-x: hidden;
        }

        .container { max-width: 460px; margin: 0 auto; padding: 12px 16px; }
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
            overflow: hidden;
        }

        .card-header-title {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--text-muted);
            margin-bottom: 12px;
        }

        .badge-card { display: flex; align-items: center; gap: 14px; }
        .badge-icon {
            width: 44px; height: 44px; border-radius: 50%;
            background: linear-gradient(135deg, #10b981 0%, #0ea5e9 100%);
            display: flex; align-items: center; justify-content: center;
            font-size: 18px; font-weight: 800; color: #fff;
            box-shadow: 0 2px 10px rgba(16, 185, 129, 0.3);
        }
        .badge-info .subtitle {
            font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
            color: var(--text-muted); text-transform: uppercase;
        }
        .badge-info .title { font-size: 18px; font-weight: 800; color: #fff; margin-top: 2px; }

        .progress-content { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
        .ring-container { position: relative; width: 105px; height: 105px; flex-shrink: 0; }
        .ring-svg { transform: rotate(-90deg); width: 100%; height: 100%; }
        .ring-bg { stroke: rgba(255, 255, 255, 0.08); stroke-width: 8; fill: none; }
        .ring-fill {
            stroke: url(#gradient); stroke-width: 8; fill: none; stroke-linecap: round;
            stroke-dasharray: 264; stroke-dashoffset: 264; transition: stroke-dashoffset 0.6s ease;
        }
        .ring-text { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 18px; font-weight: 800; color: #fff; }
        
        .stats-col { flex-grow: 1; }
        .stat-block { margin-bottom: 10px; }
        .stat-block:last-child { margin-bottom: 0; }
        .stat-num-main { font-size: 26px; font-weight: 800; color: #fff; line-height: 1.1; }
        .stat-num-blue { font-size: 22px; font-weight: 800; color: var(--accent-blue); line-height: 1.1; }
        .stat-lbl { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

        .quick-buttons { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 12px; }
        .btn-quick {
            background: var(--input-bg); border: 1px solid var(--card-border); border-radius: 10px;
            color: #fff; font-size: 14px; font-weight: 700; padding: 10px 0; text-align: center;
            cursor: pointer; transition: all 0.15s ease;
        }
        .btn-quick:active { transform: scale(0.95); background: #2a3447; }

        .input-row { display: flex; gap: 8px; width: 100%; align-items: center; }
        .custom-input {
            flex: 1; min-width: 0; background: var(--input-bg); border: 1px solid var(--card-border);
            border-radius: 12px; padding: 12px 10px; color: #fff; font-size: 14px; outline: none;
        }
        .custom-input::placeholder { color: var(--text-muted); }

        .btn-green {
            flex-shrink: 0; background: var(--accent-green); color: #fff; border: none;
            border-radius: 12px; padding: 12px 16px; font-size: 14px; font-weight: 700;
            cursor: pointer; transition: background 0.15s ease, transform 0.1s ease; white-space: nowrap;
        }
        .btn-green:active { background: var(--accent-green-hover); transform: scale(0.98); }
        .btn-full { width: 100%; display: block; margin-top: 14px; padding: 14px; text-align: center; }

        .sets-list { display: flex; flex-direction: column; gap: 8px; }
        .set-item {
            background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.04);
            border-radius: 12px; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between;
        }
        .set-count { font-size: 16px; font-weight: 800; color: var(--accent-green); }
        .set-time { font-size: 13px; color: var(--text-muted); display: flex; align-items: center; gap: 10px; }
        .btn-del-set { color: #ef4444; background: none; border: none; font-size: 16px; cursor: pointer; padding: 0 4px; }

        .form-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
        .form-row:last-child { border-bottom: none; }
        .form-label-box { display: flex; flex-direction: column; gap: 2px; }
        .form-label-main { font-size: 15px; font-weight: 600; color: #fff; }
        .form-label-sub { font-size: 12px; color: var(--text-muted); }
        .form-input-sm {
            width: 90px; background: var(--input-bg); border: 1px solid var(--card-border);
            border-radius: 10px; padding: 8px 10px; color: #fff; font-size: 15px;
            font-weight: 600; text-align: center; outline: none;
        }
        .form-select-sm {
            background: var(--input-bg); border: 1px solid var(--card-border); border-radius: 10px;
            padding: 8px 12px; color: #fff; font-size: 13px; font-weight: 600; outline: none;
        }
        .checkbox-toggle {
            width: 26px; height: 26px; background: var(--accent-green); border-radius: 6px;
            display: flex; align-items: center; justify-content: center; cursor: pointer;
            color: #fff; font-weight: bold; font-size: 14px;
        }
        .checkbox-toggle.off { background: var(--input-bg); color: transparent; border: 1px solid var(--card-border); }
        .time-range-group { display: flex; align-items: center; gap: 6px; }
        .time-input-sm {
            width: 75px; background: var(--input-bg); border: 1px solid var(--card-border);
            border-radius: 8px; padding: 6px; color: #fff; font-size: 13px; text-align: center; outline: none;
        }

        .calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; text-align: center; margin-top: 10px; }
        .cal-day-head { font-size: 12px; color: var(--text-muted); font-weight: 700; padding-bottom: 6px; }
        .cal-day-cell {
            aspect-ratio: 1; background: var(--input-bg); border-radius: 10px; display: flex;
            flex-direction: column; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; color: #fff;
        }
        .cal-day-cell.active-day { background: rgba(34, 197, 94, 0.2); border: 1px solid var(--accent-green); color: var(--accent-green); }

        .bmi-box { background: var(--input-bg); border-radius: 12px; padding: 14px; text-align: center; margin-top: 12px; }
        .bmi-value { font-size: 24px; font-weight: 800; color: #fff; }
        .bmi-status {
            display: inline-block; margin-top: 6px; padding: 4px 12px; border-radius: 20px;
            font-size: 12px; font-weight: 700; background: rgba(34, 197, 94, 0.2); color: var(--accent-green);
        }

        .nav-bar {
            position: fixed; bottom: 0; left: 0; right: 0; height: calc(65px + env(safe-area-inset-bottom, 15px));
            background: rgba(18, 24, 36, 0.96); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
            border-top: 1px solid rgba(255, 255, 255, 0.08); display: flex; align-items: center; justify-content: space-around;
            padding-bottom: env(safe-area-inset-bottom, 15px); z-index: 9999;
        }
        .nav-item {
            display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
            color: var(--tab-inactive); font-size: 11px; font-weight: 600; cursor: pointer; width: 20%; height: 100%; transition: color 0.15s ease;
        }
        .nav-item svg { width: 22px; height: 22px; fill: currentColor; pointer-events: none; }
        .nav-item span { pointer-events: none; }
        .nav-item.active { color: var(--accent-blue); }
    </style>
</head>
<body>

<div class="container">
    <!-- ГЛАВНАЯ -->
    <div id="screen-main" class="screen active">
        <div class="card badge-card">
            <div class="badge-icon" id="streak-icon">1</div>
            <div class="badge-info">
                <div class="subtitle">IOS FITNESS TRACKER</div>
                <div class="title" id="streak-days-text">1-й день</div>
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
                <input type="number" id="custom-count-input" class="custom-input" placeholder="Введите своё число..." inputmode="numeric">
                <button class="btn-green" onclick="submitCustomCount()">Записать</button>
            </div>
        </div>

        <div class="card">
            <div class="card-header-title">СЕГОДНЯШНИЕ ПОДХОДЫ</div>
            <div id="today-sets-list" class="sets-list"></div>
        </div>
    </div>

    <!-- КАЛЕНДАРЬ -->
    <div id="screen-calendar" class="screen">
        <div class="card">
            <div class="card-header-title" style="display:flex; justify-content:space-between; align-items:center;">
                <span>КАЛЕНДАРЬ ТРЕНИРОВОК</span>
                <span id="cal-month-title" style="color:#fff; font-size:13px;"></span>
            </div>
            <div class="calendar-grid" id="calendar-grid-container"></div>
        </div>
    </div>

    <!-- ПРОГРЕСС -->
    <div id="screen-progress" class="screen">
        <div class="card">
            <div class="card-header-title">СТАТИСТИКА ЗА 7 ДНЕЙ</div>
            <div id="progress-bars-container" style="display:flex; align-items:flex-end; gap:8px; height:180px; padding-top:20px;"></div>
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

            <div class="form-row">
                <div class="form-label-box">
                    <div class="form-label-main">% Жира</div>
                    <div class="form-label-sub">Опционально</div>
                </div>
                <input type="number" id="prof-fat" class="form-input-sm" value="18">
            </div>

            <div class="form-row">
                <div class="form-label-box">
                    <div class="form-label-main">Целевой вес</div>
                    <div class="form-label-sub">К чему стремимся</div>
                </div>
                <input type="number" id="prof-target-weight" class="form-input-sm" value="75">
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

            <div class="form-row">
                <div class="form-label-box">
                    <div class="form-label-main">Напоминания в Telegram</div>
                    <div class="form-label-sub">Пуши от бота при паузе</div>
                </div>
                <div id="set-notif-toggle" class="checkbox-toggle" onclick="toggleNotif()">✓</div>
            </div>

            <div class="form-row">
                <div class="form-label-box">
                    <div class="form-label-main">Интервал уведомлений</div>
                    <div class="form-label-sub">Частота отправки сообщений</div>
                </div>
                <select id="set-interval" class="form-select-sm">
                    <option value="1">Каждый час</option>
                    <option value="2">Каждые 2 часа</option>
                    <option value="3" selected>Каждые 3 часа</option>
                    <option value="4">Каждые 4 часа</option>
                </select>
            </div>

            <div class="form-row">
                <div class="form-label-box">
                    <div class="form-label-main">Диапазон времени</div>
                    <div class="form-label-sub">Со скольки и до скольки отправлять</div>
                </div>
                <div class="time-range-group">
                    <input type="time" id="set-time-start" class="time-input-sm" value="09:00">
                    <span style="font-size:12px; color:var(--text-muted);">—</span>
                    <input type="time" id="set-time-end" class="time-input-sm" value="22:00">
                </div>
            </div>

            <button class="btn-green btn-full" onclick="saveSettingsData()">Сохранить настройки</button>
        </div>
    </div>
</div>

<div class="nav-bar">
    <div class="nav-item active" onclick="switchTab('main')">
        <svg viewBox="0 0 24 24"><path d="M3 13h4v8H3zm7-8h4v16h-4zm7 4h4v12h-4z"/></svg>
        <span>Главная</span>
    </div>
    <div class="nav-item" onclick="switchTab('calendar')">
        <svg viewBox="0 0 24 24"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z"/></svg>
        <span>Календарь</span>
    </div>
    <div class="nav-item" onclick="switchTab('progress')">
        <svg viewBox="0 0 24 24"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
        <span>Прогресс</span>
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

    const telegramId = tg?.initDataUnsafe?.user?.id || "demo_user";

    let state = {
        dailyGoal: 100,
        notifEnabled: true,
        notifInterval: 3,
        timeStart: "09:00",
        timeEnd: "22:00",
        weight: 80,
        height: 180,
        fat: 18,
        targetWeight: 75,
        pushupsHistory: []
    };

    function getDateOnly(dateString) {
        const d = new Date(dateString);
        return d.getFullYear() + '-' + 
               String(d.getMonth() + 1).padStart(2, '0') + '-' + 
               String(d.getDate()).padStart(2, '0');
    }

    function triggerHaptic() {
        try {
            if (window.Telegram?.WebApp?.HapticFeedback) {
                window.Telegram.WebApp.HapticFeedback.impactOccurred('light');
            }
        } catch (e) {}
    }

    async function loadUserData() {
        try {
            const res = await fetch('/api/user-data?telegram_id=' + telegramId);
            const data = await res.json();
            
            console.log('Загружено данных:', data);
            
            if (data.status === 'ok') {
                if (data.settings) {
                    state.dailyGoal = data.settings.daily_goal || 100;
                    state.notifEnabled = data.settings.notifications_enabled ?? true;
                    state.notifInterval = data.settings.notification_interval || 3;
                    state.timeStart = data.settings.time_start || "09:00";
                    state.timeEnd = data.settings.time_end || "22:00";

                    document.getElementById('set-daily-goal').value = state.dailyGoal;
                    document.getElementById('set-interval').value = state.notifInterval;
                    document.getElementById('set-time-start').value = state.timeStart;
                    document.getElementById('set-time-end').value = state.timeEnd;
                    
                    const toggle = document.getElementById('set-notif-toggle');
                    if (state.notifEnabled) {
                        toggle.classList.remove('off');
                        toggle.innerText = '✓';
                    } else {
                        toggle.classList.add('off');
                        toggle.innerText = '';
                    }
                }

                if (data.profile) {
                    state.weight = data.profile.weight || 80;
                    state.height = data.profile.height || 180;
                    state.fat = data.profile.fat || 18;
                    state.targetWeight = data.profile.target_weight || 75;

                    document.getElementById('prof-weight').value = state.weight;
                    document.getElementById('prof-height').value = state.height;
                    document.getElementById('prof-fat').value = state.fat;
                    document.getElementById('prof-target-weight').value = state.targetWeight;
                }

                state.pushupsHistory = data.pushups || [];
            }
        } catch (e) {
            console.error("Ошибка загрузки:", e);
        } finally {
            updateProgressUI();
            calcBMI();
        }
    }

    function switchTab(tabName) {
        triggerHaptic();
        const screens = ['main', 'calendar', 'progress', 'profile', 'settings'];
        const navItems = document.querySelectorAll('.nav-item');

        screens.forEach((s, idx) => {
            const el = document.getElementById('screen-' + s);
            if (!el) return;
            if (s === tabName) {
                el.classList.add('active');
                if (navItems[idx]) navItems[idx].classList.add('active');
            } else {
                el.classList.remove('active');
                if (navItems[idx]) navItems[idx].classList.remove('active');
            }
        });

        try {
            if (tabName === 'calendar') renderCalendar();
            if (tabName === 'progress') renderProgressChart();
        } catch (err) {
            console.error('Ошибка рендера:', err);
        }
    }

    function getTodaySets() {
        const todayStr = getDateOnly(new Date());
        return state.pushupsHistory.filter(item => getDateOnly(item.created_at) === todayStr);
    }

    function updateProgressUI() {
        const todaySets = getTodaySets();
        const total = todaySets.reduce((a, b) => a + b.count, 0);

        document.getElementById('today-total').innerText = total;
        document.getElementById('target-goal').innerText = state.dailyGoal;
        document.getElementById('today-sets-count').innerText = todaySets.length;

        const pct = Math.min(100, Math.round((total / state.dailyGoal) * 100)) || 0;
        document.getElementById('ring-pct').innerText = pct + '%';

        const circle = document.getElementById('ring-progress');
        const circumference = 2 * Math.PI * 42;
        const offset = circumference - (pct / 100) * circumference;
        circle.style.strokeDashoffset = offset;

        const listEl = document.getElementById('today-sets-list');
        listEl.innerHTML = '';
        if (todaySets.length === 0) {
            listEl.innerHTML = '<div style="color:var(--text-muted); font-size:13px; text-align:center; padding:10px;">Подходов пока нет</div>';
        } else {
            todaySets.forEach((item) => {
                const dateObj = new Date(item.created_at);
                const timeStr = String(dateObj.getHours()).padStart(2, '0') + ':' + String(dateObj.getMinutes()).padStart(2, '0');
                const div = document.createElement('div');
                div.className = 'set-item';
                div.innerHTML = '<span class="set-count">+' + item.count + '</span>' +
                                '<div class="set-time">' +
                                    '<span>' + timeStr + '</span>' +
                                    '<button class="btn-del-set" onclick="deleteSet(\\'' + item.id + '\\')">✕</button>' +
                                '</div>';
                listEl.appendChild(div);
            });
        }
    }

    function addQuick(num) {
        triggerHaptic();
        addPushups(num);
    }

    function submitCustomCount() {
        const input = document.getElementById('custom-count-input');
        const val = parseInt(input.value);
        if (val > 0) {
            triggerHaptic();
            addPushups(val);
            input.value = '';
        }
    }

    async function addPushups(count) {
        try {
            const res = await fetch('/api/add-pushup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telegram_id: telegramId, count: count })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                state.pushupsHistory.unshift(data.item);
            }
        } catch (e) {
            console.error("Ошибка добавления:", e);
        } finally {
            updateProgressUI();
        }
    }

    async function deleteSet(id) {
        triggerHaptic();
        try {
            const res = await fetch('/api/delete-pushup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id, telegram_id: telegramId })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                state.pushupsHistory = state.pushupsHistory.filter(i => i.id !== id);
            }
        } catch (e) {
            console.error("Ошибка удаления:", e);
        } finally {
            updateProgressUI();
        }
    }

    function toggleNotif() {
        triggerHaptic();
        state.notifEnabled = !state.notifEnabled;
        const toggle = document.getElementById('set-notif-toggle');
        if (state.notifEnabled) {
            toggle.classList.remove('off');
            toggle.innerText = '✓';
        } else {
            toggle.classList.add('off');
            toggle.innerText = '';
        }
    }

    function calcBMI() {
        const w = parseFloat(document.getElementById('prof-weight').value) || 0;
        const h = (parseFloat(document.getElementById('prof-height').value) || 0) / 100;
        if (w > 0 && h > 0) {
            const bmi = (w / (h * h)).toFixed(1);
            document.getElementById('bmi-val').innerText = bmi;
            const statusEl = document.getElementById('bmi-status-label');
            if (bmi < 18.5) {
                statusEl.innerText = 'Дефицит массы';
                statusEl.style.color = '#38bdf8';
            } else if (bmi < 25) {
                statusEl.innerText = 'Норма';
                statusEl.style.color = '#22c55e';
            } else if (bmi < 30) {
                statusEl.innerText = 'Избыточный вес';
                statusEl.style.color = '#f59e0b';
            } else {
                statusEl.innerText = 'Ожирение';
                statusEl.style.color = '#ef4444';
            }
        }
    }

    async function saveSettingsData() {
        triggerHaptic();
        state.dailyGoal = parseInt(document.getElementById('set-daily-goal').value) || 100;
        state.notifInterval = parseInt(document.getElementById('set-interval').value) || 3;
        state.timeStart = document.getElementById('set-time-start').value || "09:00";
        state.timeEnd = document.getElementById('set-time-end').value || "22:00";

        try {
            await fetch('/api/save-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    telegram_id: telegramId,
                    daily_goal: state.dailyGoal,
                    notifications_enabled: state.notifEnabled,
                    notification_interval: state.notifInterval,
                    time_start: state.timeStart,
                    time_end: state.timeEnd
                })
            });
            if (tg) tg.showAlert("Настройки сохранены!");
        } catch (e) {
            console.error("Ошибка сохранения:", e);
        } finally {
            updateProgressUI();
        }
    }

    async function saveProfileData() {
        triggerHaptic();
        state.weight = parseFloat(document.getElementById('prof-weight').value) || 0;
        state.height = parseFloat(document.getElementById('prof-height').value) || 0;
        state.fat = parseFloat(document.getElementById('prof-fat').value) || 0;
        state.targetWeight = parseFloat(document.getElementById('prof-target-weight').value) || 0;

        try {
            await fetch('/api/save-profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    telegram_id: telegramId,
                    weight: state.weight,
                    height: state.height,
                    fat: state.fat,
                    target_weight: state.targetWeight
                })
            });
            if (tg) tg.showAlert("Профиль обновлён!");
        } catch (e) {
            console.error("Ошибка сохранения:", e);
        }
    }

    function renderCalendar() {
        const container = document.getElementById('calendar-grid-container');
        container.innerHTML = '';
        const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
        dayNames.forEach(d => {
            const head = document.createElement('div');
            head.className = 'cal-day-head';
            head.innerText = d;
            container.appendChild(head);
        });

        const now = new Date();
        document.getElementById('cal-month-title').innerText = now.toLocaleString('ru', { month: 'long', year: 'numeric' });

        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const firstDayIndex = new Date(now.getFullYear(), now.getMonth(), 1).getDay();
        const emptyCells = (firstDayIndex + 6) % 7;

        for (let i = 0; i < emptyCells; i++) {
            container.appendChild(document.createElement('div'));
        }

        for (let i = 1; i <= daysInMonth; i++) {
            const cell = document.createElement('div');
            cell.className = 'cal-day-cell';
            
            const cellDate = new Date(now.getFullYear(), now.getMonth(), i);
            const dayDateStr = getDateOnly(cellDate);
            
            const dayTotal = state.pushupsHistory
                .filter(item => getDateOnly(item.created_at) === dayDateStr)
                .reduce((a, b) => a + b.count, 0);

            if (dayTotal > 0) {
                cell.classList.add('active-day');
                cell.innerHTML = '<span>' + i + '</span><span style="font-size:9px; font-weight:800;">' + dayTotal + '</span>';
            } else {
                cell.innerHTML = '<span>' + i + '</span>';
            }
            container.appendChild(cell);
        }
    }

    function renderProgressChart() {
        const container = document.getElementById('progress-bars-container');
        container.innerHTML = '';
        const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
        
        const now = new Date();
        const currentDayOfWeek = (now.getDay() + 6) % 7;

        for (let i = 0; i < 7; i++) {
            const diff = i - currentDayOfWeek;
            const targetDate = new Date();
            targetDate.setDate(now.getDate() + diff);
            const dateStr = getDateOnly(targetDate);

            const dayTotal = state.pushupsHistory
                .filter(item => getDateOnly(item.created_at) === dateStr)
                .reduce((a, b) => a + b.count, 0);

            let pct = Math.min(100, Math.round((dayTotal / state.dailyGoal) * 100));

            const col = document.createElement('div');
            col.style.cssText = 'flex:1; display:flex; flex-direction:column; align-items:center; gap:6px; height:100%; justify-content:flex-end;';

            const bar = document.createElement('div');
            bar.style.cssText = 'width:100%; border-radius:6px; background:' + (i === currentDayOfWeek ? 'var(--accent-green)' : 'var(--input-bg)') + '; height:' + Math.max(8, pct) + '%; transition:height 0.3s ease;';

            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-size:11px; color:var(--text-muted);';
            lbl.innerText = dayNames[i];

            col.appendChild(bar);
            col.appendChild(lbl);
            container.appendChild(col);
        }
    }

    loadUserData();
</script>
</body>
</html>`;

app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.send(HTML_PAGE);
});

app.listen(port, () => {
    console.log('✅ Сервер запущен на порту ' + port);
});
