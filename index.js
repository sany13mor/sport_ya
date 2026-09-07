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

// 1. Загрузка данных пользователя (с лимитом для предотвращения зависаний)
app.get('/api/user-data', async (req, res) => {
    const telegramId = String(req.query.telegram_id || 'demo_user');
    
    // ДИАГНОСТИКА: выводим в консоль сервера
    console.log('📥 Запрос данных для telegram_id:', telegramId);

    if (!supabase) {
        console.log('⚠️ Supabase не подключен, используем inMemoryStore');
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
        
        // Лимитируем 300 записями
        const { data: pushups, error: pushupsError } = await supabase.from('pushups')
            .select('*')
            .eq('telegram_id', telegramId)
            .order('created_at', { ascending: false })
            .limit(300);

        // ДИАГНОСТИКА
        console.log('✅ Загружено из Supabase:', {
            settings: !!settings,
            profile: !!profile,
            pushups_count: pushups?.length || 0
        });

        if (pushupsError) {
            console.error('❌ Ошибка загрузки pushups:', pushupsError);
        }

        // Если есть данные, выводим первые 3 записи для проверки
        if (pushups && pushups.length > 0) {
            console.log('🔍 Первые 3 записи:', pushups.slice(0, 3).map(p => ({
                id: p.id,
                count: p.count,
                created_at: p.created_at,
                telegram_id: p.telegram_id
            })));
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

    console.log('➕ Добавление подхода:', { telegram_id: tgId, count: cnt });

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
        console.log('⚠️ Supabase не подключен, сохраняем в память');
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
        
        console.log('✅ Подход сохранён в Supabase:', data[0]);
        res.json({ status: 'ok', item: data[0] });
    } catch (e) {
        console.error('❌ Ошибка сохранения в Supabase:', e);
        inMemoryStore.pushups.unshift(newPushup);
        res.json({ status: 'ok', item: newPushup });
    }
});

// 3. Удаление подхода
app.post('/api/delete-pushup', async (req, res) => {
    const { id, telegram_id } = req.body;
    const tgId = String(telegram_id || 'demo_user');

    console.log('🗑️ Удаление подхода:', { id, telegram_id: tgId });

    if (!id) return res.status(400).json({ status: 'error', message: 'Invalid ID' });

    if (!supabase) {
        inMemoryStore.pushups = inMemoryStore.pushups.filter(p => p.id !== id);
        return res.json({ status: 'ok' });
    }

    try {
        const { error } = await supabase.from('pushups').delete().eq('id', id).eq('telegram_id', tgId);
        if (error) throw error;
        console.log('✅ Подход удалён из Supabase');
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('❌ Ошибка удаления:', e);
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

        /* ДИАГНОСТИКА */
        .debug-panel {
            position: fixed;
            top: 10px;
            right: 10px;
            background: rgba(0,0,0,0.9);
            color: #0f0;
            padding: 8px;
            border-radius: 8px;
            font-size: 10px;
            font-family: monospace;
            max-width: 200px;
            z-index: 10000;
            word-break: break-all;
        }
    </style>
</head>
<body>

<!-- ДИАГНОСТИЧЕСКАЯ ПАНЕЛЬ -->
<div class="debug-panel" id="debug-panel">
    <div>Loading...</div>
</div>

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

    <!-- остальные экраны опущены для краткости, используй из предыдущей версии -->

</div>

<div class="nav-bar">
    <div class="nav-item active" onclick="switchTab('main')">
        <svg viewBox="0 0 24 24"><path d="M3 13h4v8H3zm7-8h4v16h-4zm7 4h4v12h-4z"/></svg>
        <span>Главная</span>
    </div>
</div>

<script>
    const tg = window.Telegram?.WebApp;
    if (tg) {
        tg.ready();
        tg.expand();
    }

    const telegramId = tg?.initDataUnsafe?.user?.id || "demo_user";

    // ДИАГНОСТИКА
    const debugEl = document.getElementById('debug-panel');
    function updateDebug(text) {
        debugEl.innerHTML = text;
    }

    updateDebug('TG ID: ' + telegramId + '<br>Loading...');

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
            updateDebug('TG ID: ' + telegramId + '<br>Загрузка...');
            
            const res = await fetch('/api/user-data?telegram_id=' + telegramId);
            const data = await res.json();
            
            updateDebug('TG ID: ' + telegramId + 
                       '<br>Всего: ' + (data.pushups?.length || 0) + 
                       '<br>Первая запись: ' + (data.pushups?.[0]?.created_at || 'нет'));
            
            if (data.status === 'ok') {
                if (data.settings) {
                    state.dailyGoal = data.settings.daily_goal || 100;
                    state.notifEnabled = data.settings.notifications_enabled ?? true;
                    state.notifInterval = data.settings.notification_interval || 3;
                    state.timeStart = data.settings.time_start || "09:00";
                    state.timeEnd = data.settings.time_end || "22:00";
                }

                if (data.profile) {
                    state.weight = data.profile.weight || 80;
                    state.height = data.profile.height || 180;
                    state.fat = data.profile.fat || 18;
                    state.targetWeight = data.profile.target_weight || 75;
                }

                state.pushupsHistory = data.pushups || [];
            }
        } catch (e) {
            console.error("Error loading user data:", e);
            updateDebug('ERROR: ' + e.message);
        } finally {
            updateProgressUI();
        }
    }

    function getTodaySets() {
        const todayStr = getDateOnly(new Date());
        const filtered = state.pushupsHistory.filter(item => getDateOnly(item.created_at) === todayStr);
        
        updateDebug('TG ID: ' + telegramId + 
                   '<br>Всего: ' + state.pushupsHistory.length + 
                   '<br>Сегодня: ' + filtered.length +
                   '<br>Дата: ' + todayStr);
        
        return filtered;
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
            console.error("Error adding pushup:", e);
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
            console.error("Error deleting set:", e);
        } finally {
            updateProgressUI();
        }
    }

    function switchTab(tabName) { /* оставь свою реализацию */ }

    loadUserData();
</script>
</body>
</html>`;

app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.send(HTML_PAGE);
});

app.listen(port, () => {
    console.log('Server is running on port ' + port);
    console.log('🔍 Диагностический режим включён');
});
