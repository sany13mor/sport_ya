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

const inMemoryStore = {
    settings: {},
    profiles: {},
    pushups: []
};

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

app.get('/api/user-data', async (req, res) => {
    const telegramIdRaw = req.query.telegram_id || 'demo_user';
    const userIdInt = parseInt(telegramIdRaw) || 0;
    const userIdStr = String(telegramIdRaw);
    
    if (!supabase) {
        return res.json({
            status: 'ok',
            settings: inMemoryStore.settings[userIdStr] || null,
            profile: inMemoryStore.profiles[userIdStr] || null,
            pushups: inMemoryStore.pushups.filter(p => p.user_id === userIdInt).slice(0, 500)
        });
    }

    try {
        const { data: pushups, error: pushupsError } = await supabase
            .from('pushups')
            .select('*')
            .eq('user_id', userIdInt)
            .order('created_at', { ascending: false });

        if (pushupsError) console.error('❌ SQL Error (pushups):', pushupsError);

        let settingsData = null;
        try {
            const { data } = await supabase.from('user_settings').select('*').eq('user_id', userIdStr).maybeSingle();
            settingsData = data;
        } catch (e) { console.error('Настроек нет'); }

        let profileData = null;
        try {
            const { data } = await supabase.from('user_profiles').select('*').eq('user_id', userIdStr).maybeSingle();
            profileData = data;
        } catch (e) { console.error('Профиля нет'); }

        res.json({
            status: 'ok',
            settings: settingsData || inMemoryStore.settings[userIdStr] || null,
            profile: profileData || inMemoryStore.profiles[userIdStr] || null,
            pushups: (pushups || []).slice(0, 500)
        });
    } catch (e) {
        console.error('❌ API Error:', e);
        res.json({ status: 'error', message: 'Database error' });
    }
});

app.post('/api/add-pushup', async (req, res) => {
    const { telegram_id, count } = req.body;
    const userId = parseInt(telegram_id || 0);
    const cnt = parseInt(count);

    if (!cnt || cnt <= 0 || !userId) {
        return res.status(400).json({ status: 'error', message: 'Invalid input' });
    }

    const newPushup = {
        user_id: userId,
        count: cnt,
        created_at: new Date().toISOString(),
        exercise_type: 'pushups',
        note: '',
        rpe: 0
    };

    if (!supabase) {
        newPushup.id = Date.now();
        inMemoryStore.pushups.unshift(newPushup);
        return res.json({ status: 'ok', item: newPushup });
    }

    try {
        const { data, error } = await supabase.from('pushups').insert([newPushup]).select();
        if (error) throw error;
        res.json({ status: 'ok', item: data[0] });
    } catch (e) {
        console.error('❌ Add Error:', e);
        res.status(500).json({ status: 'error', message: 'DB Error' });
    }
});

app.post('/api/delete-pushup', async (req, res) => {
    const { id, telegram_id } = req.body;
    const userId = parseInt(telegram_id || 0);

    if (!id || !userId) return res.status(400).json({ status: 'error', message: 'Invalid ID' });

    if (!supabase) {
        inMemoryStore.pushups = inMemoryStore.pushups.filter(p => p.id !== id);
        return res.json({ status: 'ok' });
    }

    try {
        const { error } = await supabase.from('pushups').delete().eq('id', id).eq('user_id', userId);
        if (error) throw error;
        res.json({ status: 'ok' });
    } catch (e) {
        console.error('❌ Delete error:', e);
        res.status(500).json({ status: 'error' });
    }
});

app.post('/api/save-settings', async (req, res) => {
    const { telegram_id, daily_goal, notifications_enabled, notification_interval, time_start, time_end } = req.body;
    const userId = String(telegram_id || 'demo_user');

    const settingsObj = {
        user_id: userId,
        daily_goal: parseInt(daily_goal) || 100,
        notifications_enabled: Boolean(notifications_enabled),
        notification_interval: parseInt(notification_interval) || 3,
        time_start: time_start || "09:00",
        time_end: time_end || "22:00"
    };

    inMemoryStore.settings[userId] = settingsObj;
    if (!supabase) return res.json({ status: 'ok' });

    try {
        const { error } = await supabase.from('user_settings').upsert(settingsObj, { onConflict: 'user_id' });
        if (error) throw error;
        res.json({ status: 'ok' });
    } catch (e) {
        console.error(e);
        res.json({ status: 'error' });
    }
});

app.post('/api/save-profile', async (req, res) => {
    const { telegram_id, weight, height, fat, target_weight } = req.body;
    const userId = String(telegram_id || 'demo_user');

    const profileObj = {
        user_id: userId,
        weight: parseFloat(weight) || 0,
        height: parseFloat(height) || 0,
        fat: parseFloat(fat) || 0,
        target_weight: parseFloat(target_weight) || 0
    };

    inMemoryStore.profiles[userId] = profileObj;
    if (!supabase) return res.json({ status: 'ok' });

    try {
        const { error } = await supabase.from('user_profiles').upsert(profileObj, { onConflict: 'user_id' });
        if (error) throw error;
        res.json({ status: 'ok' });
    } catch (e) {
        console.error(e);
        res.json({ status: 'error' });
    }
});

const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Fitness</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root {
            --bg-color: #000000;
            --card-bg: #1C1C1E;
            --card-bg-light: #2C2C2E;
            --text-primary: #FFFFFF;
            --text-secondary: #8E8E93;
            --text-tertiary: #48484A;
            --ring-red: #FF2D55;
            --ring-green: #34C759;
            --ring-blue: #0A84FF;
            --ring-orange: #FF9500;
            --accent-green: #34C759;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            -webkit-tap-highlight-color: transparent;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
        }

        html, body {
            width: 100%;
            height: 100%;
            background-color: var(--bg-color);
            color: var(--text-primary);
            overflow: hidden;
            position: fixed;
        }

        .app-wrapper {
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .content-area {
            flex: 1;
            overflow-y: auto;
            padding: 16px 16px 110px 16px;
            -webkit-overflow-scrolling: touch;
        }

        .screen { display: none; animation: fadeIn 0.15s ease; }
        .screen.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        /* Apple Fitness Large Header Style */
        .page-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            margin-bottom: 20px;
            padding-top: 8px;
        }
        .page-title {
            font-size: 34px;
            font-weight: 800;
            letter-spacing: 0.38px;
            color: var(--text-primary);
        }

        /* Apple Fitness Cards */
        .fitness-card {
            background: var(--card-bg);
            border-radius: 20px;
            padding: 16px;
            margin-bottom: 14px;
            border: 1px solid rgba(255, 255, 255, 0.04);
        }

        .section-header {
            font-size: 13px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.8px;
            margin-bottom: 12px;
            font-weight: 600;
        }

        /* Concentric Activity Rings widget */
        .rings-container {
            display: flex;
            align-items: center;
            gap: 20px;
        }
        .rings-graphic {
            position: relative;
            width: 96px;
            height: 96px;
            flex-shrink: 0;
        }
        .ring-svg {
            width: 100%;
            height: 100%;
            transform: rotate(-90deg);
        }
        .ring-bg {
            fill: none;
            stroke-width: 9;
            stroke: rgba(255, 255, 255, 0.1);
        }
        .ring-fill {
            fill: none;
            stroke-width: 9;
            stroke-linecap: round;
            transition: stroke-dashoffset 0.5s ease;
        }
        .ring-center-icon {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 20px;
        }

        .ring-metrics {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .metric-row {
            display: flex;
            flex-direction: column;
        }
        .metric-label {
            font-size: 13px;
            font-weight: 700;
            display: flex;
            justify-content: space-between;
        }
        .metric-val {
            font-size: 15px;
            font-weight: 600;
            color: var(--text-secondary);
        }

        /* Quick actions pills */
        .quick-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 8px;
            margin-bottom: 12px;
        }
        .quick-pill {
            background: var(--card-bg-light);
            border: none;
            border-radius: 14px;
            padding: 12px 0;
            color: var(--text-primary);
            font-weight: 700;
            font-size: 15px;
            cursor: pointer;
            text-align: center;
            transition: transform 0.1s, background 0.15s;
        }
        .quick-pill:active { transform: scale(0.94); background: #3a3a3c; }

        .input-row {
            display: flex;
            gap: 10px;
        }
        .ios-input {
            flex: 1;
            background: var(--card-bg-light);
            border: none;
            border-radius: 14px;
            padding: 14px 16px;
            color: var(--text-primary);
            font-size: 16px;
            outline: none;
        }
        .ios-input::placeholder { color: var(--text-secondary); }

        .btn-action {
            background: var(--ring-green);
            border: none;
            border-radius: 14px;
            padding: 0 22px;
            color: #000;
            font-weight: 700;
            font-size: 15px;
            cursor: pointer;
            flex-shrink: 0;
            transition: transform 0.1s;
        }
        .btn-action:active { transform: scale(0.94); opacity: 0.85; }

        .exercise-row {
            background: var(--card-bg-light);
            border-radius: 14px;
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .exercise-row:last-child { margin-bottom: 0; }

        /* Calendar Styles */
        .cal-header-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            font-weight: 700;
            font-size: 18px;
        }
        .cal-grid {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            gap: 6px;
            text-align: center;
        }
        .cal-wd {
            font-size: 11px;
            color: var(--text-secondary);
            font-weight: 600;
            padding-bottom: 6px;
        }
        .cal-day {
            aspect-ratio: 1;
            background: var(--card-bg-light);
            border-radius: 12px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: 600;
            position: relative;
        }
        .cal-day.empty { background: transparent; }
        .cal-day.completed {
            background: rgba(52, 199, 89, 0.2);
            border: 1px solid var(--ring-green);
            color: var(--ring-green);
        }
        .cal-day.today {
            border: 1.5px solid var(--ring-blue);
        }

        /* Analytics & Charts */
        .chart-tabs {
            display: flex;
            background: var(--card-bg-light);
            border-radius: 12px;
            padding: 3px;
            margin-bottom: 16px;
        }
        .chart-tab {
            flex: 1;
            text-align: center;
            padding: 8px;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-secondary);
            border-radius: 10px;
            cursor: pointer;
            transition: 0.2s;
        }
        .chart-tab.active {
            background: var(--card-bg);
            color: var(--text-primary);
        }
        .stats-2col {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-bottom: 12px;
        }
        .stat-card-inner {
            background: var(--card-bg-light);
            border-radius: 16px;
            padding: 14px;
        }
        .stat-num {
            font-size: 22px;
            font-weight: 800;
            margin-top: 6px;
            color: var(--text-primary);
        }
        .chart-bars-box {
            width: 100%;
            height: 180px;
            display: flex;
            align-items: flex-end;
            gap: 6px;
            padding-top: 20px;
        }
        .bar-wrapper {
            flex: 1;
            height: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-end;
        }
        .bar-column {
            width: 100%;
            max-width: 22px;
            background: var(--card-bg-light);
            border-radius: 6px 6px 0 0;
            transition: height 0.4s ease;
        }
        .bar-column.filled { background: linear-gradient(180deg, var(--ring-green), #248a3d); }
        .bar-column.active-bar { background: linear-gradient(180deg, var(--ring-red), #c91c3f); }
        .bar-lbl {
            font-size: 10px;
            color: var(--text-secondary);
            margin-top: 6px;
            text-align: center;
        }

        /* Settings Form Styles */
        .form-item { margin-bottom: 16px; }
        .form-label-top {
            display: block;
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 8px;
            text-transform: uppercase;
            font-weight: 600;
            letter-spacing: 0.5px;
        }
        .form-control {
            width: 100%;
            background: var(--card-bg-light);
            border: none;
            border-radius: 14px;
            padding: 14px 16px;
            color: var(--text-primary);
            font-size: 16px;
            outline: none;
        }

        .toggle-wrap {
            width: 52px; height: 30px;
            background: var(--card-bg-light);
            border-radius: 15px;
            position: relative;
            cursor: pointer;
            transition: 0.3s;
        }
        .toggle-wrap.on { background: var(--ring-green); }
        .toggle-circle {
            width: 26px; height: 26px;
            background: white; border-radius: 50%;
            position: absolute; top: 2px; left: 2px;
            transition: 0.3s;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }
        .toggle-wrap.on .toggle-circle { left: 24px; }

        /* Apple Fitness Bottom Navigation Bar */
        .apple-nav {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            height: 80px;
            background: rgba(28, 28, 30, 0.92);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            display: flex;
            justify-content: space-around;
            align-items: flex-start;
            padding-top: 10px;
            border-top: 0.5px solid rgba(255, 255, 255, 0.15);
            padding-bottom: env(safe-area-inset-bottom);
            z-index: 100;
        }
        .nav-btn {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            color: var(--text-secondary);
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            width: 25%;
            background: none;
            border: none;
        }
        .nav-btn.active { color: var(--ring-green); }
        .nav-icon { width: 26px; height: 26px; fill: currentColor; }
    </style>
</head>
<body>

<div class="app-wrapper">
    <div class="content-area">
        
        <!-- СВОДКА (SUMMARY) -->
        <div id="screen-summary" class="screen active">
            <div class="page-header">
                <div class="page-title">Summary</div>
                <div style="font-size: 13px; color: var(--text-secondary); font-weight: 600;" id="current-date-header"></div>
            </div>

            <div class="fitness-card">
                <div class="section-header">Activity</div>
                <div class="rings-container">
                    <div class="rings-graphic">
                        <svg class="ring-svg" viewBox="0 0 100 100">
                            <circle class="ring-bg" cx="50" cy="50" r="42" style="stroke: rgba(255,45,85,0.15);"></circle>
                            <circle id="ring-move" class="ring-fill" cx="50" cy="50" r="42" style="stroke: var(--ring-red); stroke-dasharray: 264; stroke-dashoffset: 264;"></circle>
                            <circle class="ring-bg" cx="50" cy="50" r="32" style="stroke: rgba(52,199,89,0.15);"></circle>
                            <circle id="ring-exercise" class="ring-fill" cx="50" cy="50" r="32" style="stroke: var(--ring-green); stroke-dasharray: 201; stroke-dashoffset: 201;"></circle>
                        </svg>
                        <div class="ring-center-icon">🔥</div>
                    </div>
                    <div class="ring-metrics">
                        <div class="metric-row">
                            <div class="metric-label" style="color: var(--ring-red);">
                                <span>Move</span>
                                <span id="today-total-ui">0 / 100</span>
                            </div>
                            <div class="metric-val">повторений сегодня</div>
                        </div>
                        <div class="metric-row" style="margin-top: 4px;">
                            <div class="metric-label" style="color: var(--ring-green);">
                                <span>Sets</span>
                                <span id="today-sets-count-ui">0</span>
                            </div>
                            <div class="metric-val">выполнено подходов</div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="fitness-card">
                <div class="section-header">Быстрый ввод</div>
                <div class="quick-grid">
                    <button class="quick-pill" onclick="addQuick(15)">+15</button>
                    <button class="quick-pill" onclick="addQuick(20)">+20</button>
                    <button class="quick-pill" onclick="addQuick(25)">+25</button>
                    <button class="quick-pill" onclick="addQuick(30)">+30</button>
                    <button class="quick-pill" onclick="addQuick(35)">+35</button>
                </div>
                <div class="input-row">
                    <input type="number" id="custom-count" class="ios-input" placeholder="Другое число..." inputmode="numeric">
                    <button class="btn-action" onclick="submitCustom()">Записать</button>
                </div>
            </div>

            <div class="fitness-card">
                <div class="section-header">Подходы за сегодня</div>
                <div id="today-sets-list"></div>
            </div>
        </div>

        <!-- КАЛЕНДАРЬ (CALENDAR) -->
        <div id="screen-calendar" class="screen">
            <div class="page-header">
                <div class="page-title">Calendar</div>
            </div>
            <div class="fitness-card">
                <div class="cal-header-row" id="calendar-month-title"></div>
                <div class="cal-grid" id="calendar-grid"></div>
            </div>
        </div>

        <!-- ПРОГРЕСС / АНАЛИТИКА (PROGRESS) -->
        <div id="screen-progress" class="screen">
            <div class="page-header">
                <div class="page-title">Trends</div>
            </div>
            <div class="fitness-card">
                <div class="chart-tabs">
                    <div class="chart-tab active" id="tab-daily" onclick="setChartMode('daily')">Дни</div>
                    <div class="chart-tab" id="tab-weekly" onclick="setChartMode('weekly')">Недели</div>
                    <div class="chart-tab" id="tab-monthly" onclick="setChartMode('monthly')">Месяцы</div>
                </div>

                <div class="stats-2col">
                    <div class="stat-card-inner">
                        <div class="section-header" style="margin-bottom: 2px;">Серия дней</div>
                        <div class="stat-num" id="stat-streak" style="color: var(--ring-green);">0 дней</div>
                    </div>
                    <div class="stat-card-inner">
                        <div class="section-header" style="margin-bottom: 2px;">В среднем / день</div>
                        <div class="stat-num" id="stat-avg">0</div>
                    </div>
                </div>

                <div class="chart-bars-box" id="chart-bars-area"></div>
            </div>

            <div class="fitness-card">
                <div class="section-header">Сводка за всё время</div>
                <div style="font-size: 15px; color: var(--text-secondary); line-height: 1.8;">
                    Всего подходов: <span id="stat-total-sets" style="color: var(--text-primary); font-weight: 700;">0</span><br>
                    Суммарно повторений: <span id="stat-total-reps" style="color: var(--ring-green); font-weight: 700;">0</span><br>
                    Рекорд за день: <span id="stat-max-day" style="color: var(--ring-red); font-weight: 700;">0</span>
                </div>
            </div>
        </div>

        <!-- НАСТРОЙКИ (SETTINGS) -->
        <div id="screen-settings" class="screen">
            <div class="page-header">
                <div class="page-title">Settings</div>
            </div>
            <div class="fitness-card">
                <div class="section-header">Цель и уведомления</div>
                <div class="form-item">
                    <label class="form-label-top">Дневная цель (повторений)</label>
                    <input type="number" id="set-daily-goal" class="form-control" value="100">
                </div>
                <div class="form-item" style="display: flex; justify-content: space-between; align-items: center;">
                    <label class="form-label-top" style="margin:0;">Уведомления</label>
                    <div id="set-notif-toggle" class="toggle-wrap on" onclick="toggleNotif()">
                        <div class="toggle-circle"></div>
                    </div>
                </div>
                <div class="form-item">
                    <label class="form-label-top">Интервал напоминаний</label>
                    <select id="set-notif-interval" class="form-control">
                        <option value="1">Каждый 1 час</option>
                        <option value="2">Каждые 2 часа</option>
                        <option value="3" selected>Каждые 3 часа</option>
                        <option value="4">Каждые 4 часа</option>
                        <option value="5">Каждые 5 часов</option>
                    </select>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                    <div class="form-item">
                        <label class="form-label-top">Начало</label>
                        <input type="time" id="set-time-start" class="form-control" value="09:00">
                    </div>
                    <div class="form-item">
                        <label class="form-label-top">Конец</label>
                        <input type="time" id="set-time-end" class="form-control" value="22:00">
                    </div>
                </div>
                <button class="btn-action" onclick="saveSettingsData()" style="width: 100%; padding: 14px; margin-top: 10px; background: var(--ring-green); color: #000;">Сохранить настройки</button>
            </div>

            <div class="fitness-card">
                <div class="section-header">Антропометрия</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                    <div class="form-item">
                        <label class="form-label-top">Вес (кг)</label>
                        <input type="number" id="prof-weight" class="form-control" step="0.1">
                    </div>
                    <div class="form-item">
                        <label class="form-label-top">Рост (см)</label>
                        <input type="number" id="prof-height" class="form-control">
                    </div>
                    <div class="form-item">
                        <label class="form-label-top">% Жира</label>
                        <input type="number" id="prof-fat" class="form-control" step="0.1">
                    </div>
                    <div class="form-item">
                        <label class="form-label-top">Цель (кг)</label>
                        <input type="number" id="prof-target-weight" class="form-control" step="0.1">
                    </div>
                </div>
                <button class="btn-action" onclick="saveProfileData()" style="width: 100%; padding: 14px; margin-top: 10px; background: var(--ring-blue); color: white;">Сохранить профиль</button>
            </div>
        </div>

    </div>

    <!-- Apple Fitness Bottom Navigation Bar -->
    <div class="apple-nav">
        <button class="nav-btn active" onclick="switchTab('summary', event)">
            <svg class="nav-icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H7c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.04-.42 1.99-1.07 2.75z"/></svg>
            <span>Summary</span>
        </button>
        <button class="nav-btn" onclick="switchTab('calendar', event)">
            <svg class="nav-icon" viewBox="0 0 24 24"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/></svg>
            <span>Calendar</span>
        </button>
        <button class="nav-btn" onclick="switchTab('progress', event)">
            <svg class="nav-icon" viewBox="0 0 24 24"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
            <span>Trends</span>
        </button>
        <button class="nav-btn" onclick="switchTab('settings', event)">
            <svg class="nav-icon" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
            <span>Settings</span>
        </button>
    </div>
</div>

<script>
    const tg = window.Telegram?.WebApp;
    if (tg) { tg.ready(); tg.expand(); }

    const telegramId = tg?.initDataUnsafe?.user?.id || "demo_user";

    let state = {
        dailyGoal: 100,
        notifEnabled: true,
        notificationInterval: 3,
        timeStart: "09:00",
        timeEnd: "22:00",
        pushupsHistory: [],
        chartMode: 'daily'
    };

    const optionsDate = { weekday: 'long', month: 'short', day: 'numeric' };
    document.getElementById('current-date-header').innerText = new Date().toLocaleDateString('en-US', optionsDate);

    function triggerHaptic() {
        if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    }

    function switchTab(tab, event) {
        triggerHaptic();
        document.querySelectorAll('.screen').forEach(function(el) { el.classList.remove('active'); });
        document.querySelectorAll('.nav-btn').forEach(function(el) { el.classList.remove('active'); });
        document.getElementById('screen-' + tab).classList.add('active');
        if (event && event.currentTarget) {
            event.currentTarget.classList.add('active');
        }
        if (tab === 'calendar') {
            renderCalendar();
        } else if (tab === 'progress') {
            renderChartsAndStats();
        }
    }

    async function loadUserData() {
        try {
            const res = await fetch('/api/user-data?telegram_id=' + telegramId);
            const data = await res.json();
            
            if (data.status === 'ok') {
                state.pushupsHistory = data.pushups || [];
                
                if (data.settings) {
                    state.dailyGoal = data.settings.daily_goal || 100;
                    state.notifEnabled = data.settings.notifications_enabled !== false;
                    state.notificationInterval = data.settings.notification_interval || 3;
                    state.timeStart = data.settings.time_start || "09:00";
                    state.timeEnd = data.settings.time_end || "22:00";

                    document.getElementById('set-daily-goal').value = state.dailyGoal;
                    document.getElementById('set-notif-interval').value = state.notificationInterval;
                    document.getElementById('set-time-start').value = state.timeStart;
                    document.getElementById('set-time-end').value = state.timeEnd;
                    
                    const toggle = document.getElementById('set-notif-toggle');
                    if (state.notifEnabled) toggle.classList.add('on');
                    else toggle.classList.remove('on');
                }

                if (data.profile) {
                    document.getElementById('prof-weight').value = data.profile.weight || '';
                    document.getElementById('prof-height').value = data.profile.height || '';
                    document.getElementById('prof-fat').value = data.profile.fat || '';
                    document.getElementById('prof-target-weight').value = data.profile.target_weight || '';
                }
            }
        } catch (e) {
            console.error("Ошибка загрузки:", e);
        } finally {
            updateProgressUI();
        }
    }

    function updateProgressUI() {
        const todayStr = new Date().toISOString().split('T')[0];
        const todaySets = state.pushupsHistory.filter(function(i) {
            return i.created_at && i.created_at.startsWith(todayStr);
        });
        const total = todaySets.reduce(function(a, b) { return a + b.count; }, 0);

        document.getElementById('today-total-ui').innerText = total + ' / ' + state.dailyGoal;
        document.getElementById('today-sets-count-ui').innerText = todaySets.length;

        const movePct = Math.min(100, Math.round((total / state.dailyGoal) * 100)) || 0;
        const moveOffset = 264 - (movePct / 100) * 264;
        document.getElementById('ring-move').style.strokeDashoffset = moveOffset;

        const setsPct = Math.min(100, Math.round((todaySets.length / 10) * 100)) || 0;
        const setsOffset = 201 - (setsPct / 100) * 201;
        document.getElementById('ring-exercise').style.strokeDashoffset = setsOffset;

        const listEl = document.getElementById('today-sets-list');
        listEl.innerHTML = '';
        if (todaySets.length === 0) {
            listEl.innerHTML = '<div style="text-align: center; color: var(--text-secondary); font-size: 14px; padding: 10px;">Нет подходов за сегодня</div>';
        } else {
            todaySets.forEach(function(item) {
                const timeStr = new Date(item.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                listEl.innerHTML += '<div class="exercise-row">' +
                    '<span style="color: var(--ring-green); font-size: 16px; font-weight: 800;">+' + item.count + '</span>' +
                    '<div style="display: flex; gap: 14px; align-items: center;">' +
                        '<span style="color: var(--text-secondary); font-size: 14px;">' + timeStr + '</span>' +
                        '<button style="background: none; border: none; color: var(--text-secondary); padding: 4px; font-size: 16px; cursor: pointer;" onclick="deleteSet(\'' + item.id + '\')">✕</button>' +
                    '</div>' +
                '</div>';
            });
        }
    }

    async function addQuick(count) {
        triggerHaptic();
        
        const tempId = 'temp_' + Date.now();
        const tempItem = {
            id: tempId,
            user_id: telegramId,
            count: count,
            created_at: new Date().toISOString()
        };
        
        state.pushupsHistory.unshift(tempItem);
        updateProgressUI();

        try {
            const res = await fetch('/api/add-pushup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telegram_id: telegramId, count: count })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                const idx = state.pushupsHistory.findIndex(function(i) { return i.id === tempId; });
                if (idx !== -1) {
                    state.pushupsHistory[idx] = data.item;
                }
            }
        } catch (e) {
            console.error(e);
            state.pushupsHistory = state.pushupsHistory.filter(function(i) { return i.id !== tempId; });
        }
        updateProgressUI();
    }

    function submitCustom() {
        const inputEl = document.getElementById('custom-count');
        const val = parseInt(inputEl.value);
        if (val > 0) {
            addQuick(val);
            inputEl.value = '';
        }
    }

    async function deleteSet(id) {
        triggerHaptic();
        state.pushupsHistory = state.pushupsHistory.filter(function(i) { return String(i.id) !== String(id); });
        updateProgressUI();

        try {
            await fetch('/api/delete-pushup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id, telegram_id: telegramId })
            });
        } catch (e) { console.error(e); }
    }

    function toggleNotif() {
        triggerHaptic();
        state.notifEnabled = !state.notifEnabled;
        document.getElementById('set-notif-toggle').classList.toggle('on');
    }

    async function saveSettingsData() {
        triggerHaptic();
        const goal = parseInt(document.getElementById('set-daily-goal').value) || 100;
        const interval = parseInt(document.getElementById('set-notif-interval').value) || 3;
        const timeStart = document.getElementById('set-time-start').value || "09:00";
        const timeEnd = document.getElementById('set-time-end').value || "22:00";

        state.dailyGoal = goal;
        state.notificationInterval = interval;
        state.timeStart = timeStart;
        state.timeEnd = timeEnd;
        
        await fetch('/api/save-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                telegram_id: telegramId, 
                daily_goal: goal, 
                notifications_enabled: state.notifEnabled,
                notification_interval: interval,
                time_start: timeStart,
                time_end: timeEnd
            })
        });
        if(tg) tg.showAlert("Настройки сохранены!");
        updateProgressUI();
    }

    async function saveProfileData() {
        triggerHaptic();
        await fetch('/api/save-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                telegram_id: telegramId,
                weight: document.getElementById('prof-weight').value,
                height: document.getElementById('prof-height').value,
                fat: document.getElementById('prof-fat').value,
                target_weight: document.getElementById('prof-target-weight').value
            })
        });
        if(tg) tg.showAlert("Профиль обновлен!");
    }

    function setChartMode(mode) {
        triggerHaptic();
        state.chartMode = mode;
        document.querySelectorAll('.chart-tab').forEach(function(el) { el.classList.remove('active'); });
        document.getElementById('tab-' + mode).classList.add('active');
        renderChartsAndStats();
    }

    function renderChartsAndStats() {
        const dailyMap = {};
        state.pushupsHistory.forEach(function(item) {
            if (item.created_at) {
                const dayStr = item.created_at.split('T')[0];
                dailyMap[dayStr] = (dailyMap[dayStr] || 0) + item.count;
            }
        });

        const totalReps = state.pushupsHistory.reduce(function(a, b) { return a + b.count; }, 0);
        document.getElementById('stat-total-sets').innerText = state.pushupsHistory.length;
        document.getElementById('stat-total-reps').innerText = totalReps;

        let maxDay = 0;
        Object.values(dailyMap).forEach(function(val) { if (val > maxDay) maxDay = val; });
        document.getElementById('stat-max-day').innerText = maxDay;

        let streak = 0;
        let checkDate = new Date();
        while (true) {
            const dateStr = checkDate.toISOString().split('T')[0];
            const sum = dailyMap[dateStr] || 0;
            if (sum >= state.dailyGoal) {
                streak++;
                checkDate.setDate(checkDate.getDate() - 1);
            } else {
                if (streak === 0 && dateStr === new Date().toISOString().split('T')[0]) {
                    checkDate.setDate(checkDate.getDate() - 1);
                    const yesterStr = checkDate.toISOString().split('T')[0];
                    if ((dailyMap[yesterStr] || 0) >= state.dailyGoal) {
                        streak++;
                        checkDate.setDate(checkDate.getDate() - 1);
                        continue;
                    }
                }
                break;
            }
        }
        document.getElementById('stat-streak').innerText = streak + ' дней';

        const activeDaysCount = Object.keys(dailyMap).length;
        const avg = activeDaysCount > 0 ? Math.round(totalReps / activeDaysCount) : 0;
        document.getElementById('stat-avg').innerText = avg;

        const chartArea = document.getElementById('chart-bars-area');
        chartArea.innerHTML = '';

        let chartData = [];
        const now = new Date();

        if (state.chartMode === 'daily') {
            for (let i = 6; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                const dateStr = d.toISOString().split('T')[0];
                const label = d.toLocaleDateString('ru-RU', { weekday: 'short' });
                chartData.push({ label: label, value: dailyMap[dateStr] || 0 });
            }
        } else if (state.chartMode === 'weekly') {
            for (let i = 3; i >= 0; i--) {
                let weekSum = 0;
                for (let j = 0; j < 7; j++) {
                    const d = new Date(now);
                    d.setDate(d.getDate() - (i * 7 + j));
                    const dateStr = d.toISOString().split('T')[0];
                    weekSum += (dailyMap[dateStr] || 0);
                }
                chartData.push({ label: (4 - i) + '-я', value: weekSum });
            }
        } else if (state.chartMode === 'monthly') {
            for (let i = 4; i >= 0; i--) {
                const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                const mName = d.toLocaleDateString('ru-RU', { month: 'short' });
                let monthSum = 0;
                Object.keys(dailyMap).forEach(function(dateStr) {
                    const itemDate = new Date(dateStr);
                    if (itemDate.getMonth() === d.getMonth() && itemDate.getFullYear() === d.getFullYear()) {
                        monthSum += dailyMap[dateStr];
                    }
                });
                chartData.push({ label: mName, value: monthSum });
            }
        }

        const maxVal = Math.max.apply(null, chartData.map(function(i) { return i.value; }).concat([state.dailyGoal, 10]));

        chartData.forEach(function(item) {
            const heightPct = Math.min(100, Math.round((item.value / maxVal) * 100));
            const isCompleted = item.value >= (state.chartMode === 'daily' ? state.dailyGoal : state.dailyGoal * (state.chartMode === 'weekly' ? 7 : 30));
            
            let barClass = 'bar-column';
            if (isCompleted) barClass += ' filled';
            else if (item.value > 0) barClass += ' active-bar';

            chartArea.innerHTML += '<div class="bar-wrapper">' +
                '<div style="font-size: 9px; color: var(--text-secondary); margin-bottom: 4px;">' + (item.value > 0 ? item.value : '') + '</div>' +
                '<div class="' + barClass + '" style="height: ' + Math.max(8, heightPct) + '%;"></div>' +
                '<div class="bar-lbl">' + item.label + '</div>' +
            '</div>';
        });
    }

    function renderCalendar() {
        const titleEl = document.getElementById('calendar-month-title');
        const gridEl = document.getElementById('calendar-grid');
        
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();
        
        const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
        titleEl.innerText = monthNames[month] + " " + year;

        const completedDays = {};
        state.pushupsHistory.forEach(function(item) {
            if (item.created_at) {
                const dateKey = item.created_at.split('T')[0];
                completedDays[dateKey] = (completedDays[dateKey] || 0) + item.count;
            }
        });

        gridEl.innerHTML = '';
        const weekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
        weekdays.forEach(function(wd) {
            gridEl.innerHTML += '<div class="cal-wd">' + wd + '</div>';
        });

        const firstDayIndex = (new Date(year, month, 1).getDay() + 6) % 7;
        const totalDays = new Date(year, month + 1, 0).getDate();

        for (let i = 0; i < firstDayIndex; i++) {
            gridEl.innerHTML += '<div class="cal-day empty"></div>';
        }

        const todayStr = now.toISOString().split('T')[0];

        for (let day = 1; day <= totalDays; day++) {
            const dayStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
            const isCompleted = completedDays[dayStr] >= state.dailyGoal;
            const hasActivity = completedDays[dayStr] > 0;
            const isToday = (dayStr === todayStr);

            let classes = 'cal-day';
            if (isCompleted || hasActivity) classes += ' completed';
            if (isToday) classes += ' today';

            gridEl.innerHTML += '<div class="' + classes + '"><span>' + day + '</span></div>';
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
