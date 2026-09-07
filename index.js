const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://sport-ya.onrender.com';

const supabase = (SUPABASE_URL && SUPABASE_KEY && SUPABASE_URL.startsWith('http')) 
    ? createClient(SUPABASE_URL, SUPABASE_KEY) 
    : null;

app.use(express.json());

const inMemoryStore = {
    settings: {},
    profiles: {},
    pushups: []
};

// Проверка соединения с Supabase при старте сервера
async function testSupabaseConnection() {
    if (!supabase) {
        console.log('⚠️ Supabase клиент не инициализирован.');
        return;
    }
    try {
        const { error } = await supabase.from('pushups').select('id').limit(1);
        if (error) {
            console.error('❌ Ошибка связи с Supabase:', error.message);
        } else {
            console.log('✅ Успешное подключение к Supabase!');
        }
    } catch (err) {
        console.error('❌ Исключение при подключении к Supabase:', err);
    }
}

testSupabaseConnection();

// Автоматическая установка Webhook для Telegram бота при старте
async function setupTelegramWebhook() {
    if (!BOT_TOKEN) {
        console.log('⚠️ BOT_TOKEN не задан, Telegram бот отключен.');
        return;
    }
    const webhookUrl = `${WEBAPP_URL}/api/telegram-webhook`;
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
        const data = await res.json();
        if (data.ok) {
            console.log('✅ Telegram Webhook успешно установлен:', webhookUrl);
        } else {
            console.error('❌ Ошибка установки Webhook:', data);
        }
    } catch (e) {
        console.error('❌ Исключение при установке Webhook:', e);
    }
}

setupTelegramWebhook();

function parseTelegramId(rawId) {
    if (!rawId || rawId === 'demo_user') {
        return 356582454; 
    }
    const parsed = parseInt(rawId);
    return isNaN(parsed) ? 356582454 : parsed;
}

// Отправка сообщения в Telegram с кнопками
async function sendNotificationToTelegram(chatId, customText = '💪 Время сделать отжимания!') {
    if (!BOT_TOKEN) return;
    
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: customText,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '+15', callback_data: 'add_15' },
                    { text: '+20', callback_data: 'add_20' },
                    { text: '+25', callback_data: 'add_25' },
                    { text: '+30', callback_data: 'add_30' }
                ],
                [
                    { text: '⏳ 15 мин', callback_data: 'snooze_15' },
                    { text: '⏳ 30 мин', callback_data: 'snooze_30' },
                    { text: '⏳ 45 мин', callback_data: 'snooze_45' },
                    { text: '⏳ 1 час', callback_data: 'snooze_60' }
                ]
            ]
        }
    };

    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error('❌ Ошибка отправки сообщения в Telegram:', e);
    }
}

// Эндпоинт для обработки входящих запросов от Telegram (Webhook)
app.post('/api/telegram-webhook', async (req, res) => {
    res.status(200).json({ status: 'ok' }); // Сразу отвечаем Telegram, чтобы не было таймаута

    const update = req.body;
    
    // 1. Обработка текстовых команд от пользователя
    if (update.message && update.message.text) {
        const chatId = update.message.chat.id;
        const text = update.message.text;

        if (text === '/start' || text === '/reminder') {
            await sendNotificationToTelegram(chatId, '🏋️ Привет! Вот твои быстрые действия для тренировки:');
        }
    }

    // 2. Обработка нажатий на инлайн-кнопки
    if (update.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message.chat.id;
        const userId = parseTelegramId(cq.from.id);
        const data = cq.data;
        const callbackQueryId = cq.id;

        const answerUrl = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;

        if (data.startsWith('add_')) {
            const count = parseInt(data.split('_')[1]);
            const newPushup = {
                user_id: userId,
                count: count,
                created_at: new Date().toISOString(),
                exercise_type: 'pushups',
                note: '',
                rpe: 0
            };

            try {
                if (supabase) {
                    await supabase.from('pushups').insert([newPushup]);
                } else {
                    newPushup.id = Date.now();
                    inMemoryStore.pushups.unshift(newPushup);
                }

                // Уведомляем пользователя во всплывающем окне Telegram
                await fetch(answerUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_query_id: callbackQueryId, text: `✅ Записано: +${count} отжиманий!` })
                });

                // Обновляем текст сообщения, чтобы показать успех
                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: cq.message.message_id,
                        text: `✅ Успешно записано: +${count} отжиманий!`
                    })
                });
            } catch (e) {
                console.error('Ошибка записи через бота:', e);
            }
        } 
        else if (data.startsWith('snooze_')) {
            const minutes = parseInt(data.split('_')[1]);
            const ms = minutes * 60 * 1000;

            // Отвечаем на нажатие кнопки
            await fetch(answerUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: callbackQueryId, text: `⏳ Напомню через ${minutes} мин.` })
            });

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: cq.message.message_id,
                    text: `⏳ Напоминание отложено на ${minutes} мин.`
                })
            });

            // Устанавливаем таймер на повторное напоминание
            setTimeout(async () => {
                await sendNotificationToTelegram(chatId, `⏰ Прошло ${minutes} мин! Время сделать подход:`);
            }, ms);
        }
    }
});

// Эндпоинты API приложения
app.get('/api/user-data', async (req, res) => {
    const telegramIdRaw = req.query.telegram_id || 'demo_user';
    const userIdInt = parseTelegramId(telegramIdRaw);
    const userIdStr = String(userIdInt);
    
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
        } catch (e) {}

        let profileData = null;
        try {
            const { data } = await supabase.from('user_profiles').select('*').eq('user_id', userIdStr).maybeSingle();
            profileData = data;
        } catch (e) {}

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
    const userId = parseTelegramId(telegram_id);
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
    const userId = parseTelegramId(telegram_id);

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
    const userId = String(parseTelegramId(telegram_id));

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
        console.error('Settings save error:', e);
        res.status(500).json({ status: 'error' });
    }
});

app.post('/api/save-profile', async (req, res) => {
    const { telegram_id, weight, height, fat, target_weight } = req.body;
    const userId = String(parseTelegramId(telegram_id));

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
        console.error('Profile save error:', e);
        res.status(500).json({ status: 'error' });
    }
});

const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Fitness Tracker</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root {
            --primary: #0A84FF;
            --primary-light: #30B0FF;
            --accent-green: #34C759;
            --bg-main: #000000;
            --glass-light: #1A1A1C;
            --glass-lighter: #2C2C2E;
            --text-primary: #FFFFFF;
            --text-secondary: #8E8E93;
            --text-tertiary: #5A5A5E;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            -webkit-tap-highlight-color: transparent;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        }

        html, body {
            width: 100%;
            height: 100dvh;
            background-color: var(--bg-main);
            color: var(--text-primary);
            overflow: hidden;
            position: fixed;
        }

        .app-wrapper {
            width: 100%;
            height: 100dvh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            padding-top: env(safe-area-inset-top);
        }

        .content-area {
            flex: 1;
            overflow-y: auto;
            padding: 16px 16px 110px 16px;
            -webkit-overflow-scrolling: touch;
        }

        .screen { display: none; animation: fadeIn 0.2s ease; }
        .screen.active { display: block; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

        .glass-card {
            background: var(--glass-light);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 20px;
            padding: 16px;
            margin-bottom: 12px;
        }

        .header-top {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .header-icon {
            width: 44px;
            height: 44px;
            border-radius: 50%;
            background: linear-gradient(135deg, #0A84FF, #34C759);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            font-weight: 700;
        }

        .section-title {
            font-size: 11px;
            color: var(--text-secondary);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 12px;
            font-weight: 600;
        }

        .progress-ring-container {
            position: relative;
            width: 80px;
            height: 80px;
            flex-shrink: 0;
        }

        .progress-ring-svg {
            width: 100%;
            height: 100%;
            transform: rotate(-90deg);
        }

        .progress-ring-bg {
            stroke: var(--glass-lighter);
            stroke-width: 8;
            fill: none;
        }

        .progress-ring-fill {
            stroke: var(--primary);
            stroke-width: 8;
            fill: none;
            stroke-linecap: round;
            stroke-dasharray: 226;
            stroke-dashoffset: 226;
            transition: stroke-dashoffset 0.4s ease;
        }

        .progress-ring-text {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 18px;
            font-weight: 800;
        }

        .quick-actions {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 8px;
            margin-bottom: 12px;
        }

        .quick-btn {
            background: var(--glass-lighter);
            border: none;
            border-radius: 12px;
            padding: 12px 0;
            color: var(--text-primary);
            font-weight: 700;
            font-size: 14px;
            cursor: pointer;
            transition: background 0.15s;
        }
        
        .quick-btn:active { background: #3a3a3c; transform: scale(0.96); }

        .input-group {
            display: flex;
            gap: 8px;
            width: 100%;
        }

        .glass-input {
            flex: 1;
            min-width: 0;
            background: var(--glass-lighter);
            border: none;
            border-radius: 12px;
            padding: 12px 16px;
            color: var(--text-primary);
            font-size: 15px;
            outline: none;
        }

        .glass-input::placeholder { color: var(--text-tertiary); }

        .btn-green {
            background: var(--accent-green);
            border: none;
            border-radius: 12px;
            padding: 12px 20px;
            color: #000;
            font-weight: 700;
            font-size: 15px;
            cursor: pointer;
            flex-shrink: 0;
        }
        
        .btn-green:active { opacity: 0.8; transform: scale(0.96); }

        .exercise-item {
            background: var(--glass-lighter);
            border-radius: 12px;
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .exercise-item:last-child { margin-bottom: 0; }

        .form-group { margin-bottom: 16px; }
        .form-label {
            display: block;
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 8px;
            text-transform: uppercase;
            font-weight: 600;
        }

        .form-input, .form-select {
            width: 100%;
            background: var(--glass-lighter);
            border: none;
            border-radius: 12px;
            padding: 12px 16px;
            color: var(--text-primary);
            font-size: 16px;
            outline: none;
        }

        /* Calendar Grid */
        .calendar-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            font-weight: 700;
            font-size: 16px;
        }
        .calendar-grid {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            gap: 6px;
            text-align: center;
        }
        .calendar-weekday {
            font-size: 11px;
            color: var(--text-secondary);
            font-weight: 600;
            padding-bottom: 4px;
        }
        .calendar-day {
            aspect-ratio: 1;
            background: var(--glass-lighter);
            border-radius: 10px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            font-size: 13px;
            font-weight: 600;
            position: relative;
        }
        .calendar-day.empty { background: transparent; }
        .calendar-day.completed {
            background: rgba(52, 199, 89, 0.2);
            border: 1px solid var(--accent-green);
            color: var(--accent-green);
        }
        .calendar-day.today { border: 1px solid var(--primary); }

        /* Stats & Charts */
        .chart-tabs {
            display: flex;
            background: var(--glass-lighter);
            border-radius: 10px;
            padding: 3px;
            margin-bottom: 16px;
        }
        .chart-tab {
            flex: 1;
            text-align: center;
            padding: 8px;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-secondary);
            border-radius: 8px;
            cursor: pointer;
            transition: 0.2s;
        }
        .chart-tab.active {
            background: var(--glass-light);
            color: var(--text-primary);
        }
        .stats-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-bottom: 12px;
        }
        .stat-box {
            background: var(--glass-lighter);
            border-radius: 14px;
            padding: 12px;
        }
        .stat-value {
            font-size: 20px;
            font-weight: 800;
            margin-top: 4px;
            color: var(--text-primary);
        }
        .chart-container {
            width: 100%;
            height: 180px;
            display: flex;
            align-items: flex-end;
            gap: 6px;
            padding-top: 20px;
            position: relative;
        }
        .chart-bar-wrap {
            flex: 1;
            height: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-end;
            position: relative;
        }
        .chart-bar {
            width: 100%;
            max-width: 24px;
            background: var(--glass-lighter);
            border-radius: 6px 6px 0 0;
            transition: height 0.4s ease;
            position: relative;
        }
        .chart-bar.filled { background: linear-gradient(180deg, var(--accent-green), #248a3d); }
        .chart-bar.active-day { background: linear-gradient(180deg, var(--primary), var(--primary-light)); }
        .chart-label {
            font-size: 10px;
            color: var(--text-secondary);
            margin-top: 6px;
            text-align: center;
        }

        .bottom-nav {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            height: calc(65px + env(safe-area-inset-bottom));
            background: var(--glass-light);
            display: flex;
            justify-content: space-around;
            align-items: flex-start;
            padding-top: 10px;
            padding-bottom: env(safe-area-inset-bottom);
            border-top: 1px solid rgba(255,255,255,0.05);
            z-index: 100;
        }

        .nav-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            color: var(--text-secondary);
            font-size: 10px;
            font-weight: 600;
            cursor: pointer;
            width: 25%;
            padding: 4px 0;
        }

        .nav-item.active { color: var(--primary); }
        .nav-icon { width: 24px; height: 24px; pointer-events: none; }
        .nav-item span { pointer-events: none; }
        
        .toggle-switch {
            width: 50px; height: 28px;
            background: var(--glass-lighter);
            border-radius: 14px;
            position: relative;
            cursor: pointer;
            transition: 0.3s;
        }
        .toggle-switch.on { background: var(--accent-green); }
        .toggle-knob {
            width: 24px; height: 24px;
            background: white; border-radius: 50%;
            position: absolute; top: 2px; left: 2px;
            transition: 0.3s;
        }
        .toggle-switch.on .toggle-knob { left: 24px; }
    </style>
</head>
<body>

<div class="app-wrapper">
    <div class="content-area">
        
        <!-- ГЛАВНАЯ -->
        <div id="screen-main" class="screen active">
            <div class="glass-card header-top">
                <div class="header-icon">🏋️</div>
                <div>
                    <div style="font-size: 10px; color: var(--text-secondary); letter-spacing: 1px; font-weight: 700;">FITNESS TRACKER</div>
                    <div style="font-size: 20px; font-weight: 700;">Отжимания</div>
                </div>
            </div>

            <div class="glass-card">
                <div class="section-title">Дневной прогресс</div>
                <div style="display: flex; align-items: center; gap: 20px;">
                    <div class="progress-ring-container">
                        <svg class="progress-ring-svg" viewBox="0 0 80 80">
                            <circle class="progress-ring-bg" cx="40" cy="40" r="36"></circle>
                            <circle id="ring-progress" class="progress-ring-fill" cx="40" cy="40" r="36"></circle>
                        </svg>
                        <div class="progress-ring-text" id="ring-pct">0%</div>
                    </div>
                    <div style="flex: 1;">
                        <div style="font-size: 24px; font-weight: 800;" id="today-total-ui">0 <span style="font-size: 14px; color: var(--text-secondary); font-weight: 600;">/ <span id="goal-display">100</span></span></div>
                        <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">Отжиманий сегодня</div>
                        <div style="font-size: 20px; font-weight: 800; color: var(--primary);" id="today-sets-count-ui">0</div>
                        <div style="font-size: 12px; color: var(--text-secondary);">Выполнено подходов</div>
                    </div>
                </div>
            </div>

            <div class="glass-card">
                <div class="section-title">Быстрый ввод</div>
                <div class="quick-actions">
                    <button class="quick-btn" onclick="addQuick(15)">+15</button>
                    <button class="quick-btn" onclick="addQuick(20)">+20</button>
                    <button class="quick-btn" onclick="addQuick(25)">+25</button>
                    <button class="quick-btn" onclick="addQuick(30)">+30</button>
                    <button class="quick-btn" onclick="addQuick(35)">+35</button>
                </div>
                <div class="input-group">
                    <input type="number" id="custom-count" class="glass-input" placeholder="Своё число..." inputmode="numeric">
                    <button class="btn-green" onclick="submitCustom()">Записать</button>
                </div>
            </div>

            <div class="glass-card">
                <div class="section-title">Сегодняшние подходы</div>
                <div id="today-sets-list"></div>
            </div>
        </div>

        <!-- КАЛЕНДАРЬ -->
        <div id="screen-calendar" class="screen">
            <div class="glass-card">
                <div class="calendar-header" id="calendar-month-title">Календарь</div>
                <div class="calendar-grid" id="calendar-grid"></div>
            </div>
        </div>

        <!-- ПРОГРЕСС -->
        <div id="screen-progress" class="screen">
            <div class="glass-card">
                <div class="section-title">Аналитика и графики</div>
                
                <div class="chart-tabs">
                    <div class="chart-tab active" id="tab-daily" onclick="setChartMode('daily')">Дни</div>
                    <div class="chart-tab" id="tab-weekly" onclick="setChartMode('weekly')">Недели</div>
                    <div class="chart-tab" id="tab-monthly" onclick="setChartMode('monthly')">Месяцы</div>
                </div>

                <div class="stats-grid">
                    <div class="stat-box">
                        <div class="section-title" style="margin-bottom: 2px;">Серия дней</div>
                        <div class="stat-value" id="stat-streak" style="color: var(--accent-green);">0 дней</div>
                    </div>
                    <div class="stat-box">
                        <div class="section-title" style="margin-bottom: 2px;">В среднем / день</div>
                        <div class="stat-value" id="stat-avg">0</div>
                    </div>
                </div>

                <div class="chart-container" id="chart-bars-area"></div>
            </div>

            <div class="glass-card">
                <div class="section-title">Сводка за всё время</div>
                <div style="font-size: 14px; color: var(--text-secondary); line-height: 1.6;">
                    Всего подходов: <span id="stat-total-sets" style="color: var(--text-primary); font-weight: 700;">0</span><br>
                    Суммарно повторений: <span id="stat-total-reps" style="color: var(--accent-green); font-weight: 700;">0</span><br>
                    Рекорд за день: <span id="stat-max-day" style="color: var(--primary); font-weight: 700;">0</span>
                </div>
            </div>
        </div>

        <!-- НАСТРОЙКИ -->
        <div id="screen-settings" class="screen">
            <div class="glass-card">
                <div class="section-title">Цель и уведомления</div>
                <div class="form-group">
                    <label class="form-label">Дневная цель (повторений)</label>
                    <input type="number" id="set-daily-goal" class="form-input" value="100">
                </div>
                <div class="form-group" style="display: flex; justify-content: space-between; align-items: center;">
                    <label class="form-label" style="margin:0;">Уведомления</label>
                    <div id="set-notif-toggle" class="toggle-switch on" onclick="toggleNotif()">
                        <div class="toggle-knob"></div>
                    </div>
                </div>
                <div class="form-group">
                    <label class="form-label">Интервал напоминаний</label>
                    <select id="set-notif-interval" class="form-select">
                        <option value="1">Каждый 1 час</option>
                        <option value="2">Каждые 2 часа</option>
                        <option value="3" selected>Каждые 3 часа</option>
                        <option value="4">Каждые 4 часа</option>
                        <option value="5">Каждые 5 часов</option>
                    </select>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                    <div class="form-group">
                        <label class="form-label">Начало</label>
                        <input type="time" id="set-time-start" class="form-input" value="09:00">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Конец</label>
                        <input type="time" id="set-time-end" class="form-input" value="22:00">
                    </div>
                </div>
                <button class="btn-green" onclick="saveSettingsData()" style="width: 100%; margin-top: 10px;">Сохранить настройки</button>
            </div>

            <div class="glass-card">
                <div class="section-title">Антропометрия</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                    <div class="form-group">
                        <label class="form-label">Вес (кг)</label>
                        <input type="number" id="prof-weight" class="form-input" step="0.1">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Рост (см)</label>
                        <input type="number" id="prof-height" class="form-input">
                    </div>
                    <div class="form-group">
                        <label class="form-label">% Жира</label>
                        <input type="number" id="prof-fat" class="form-input" step="0.1">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Цель (кг)</label>
                        <input type="number" id="prof-target-weight" class="form-input" step="0.1">
                    </div>
                </div>
                <button class="btn-green" onclick="saveProfileData()" style="width: 100%; margin-top: 10px; background: var(--primary); color: white;">Сохранить профиль</button>
            </div>
        </div>

    </div>

    <!-- Нижняя навигация -->
    <div class="bottom-nav">
        <div class="nav-item active" onclick="switchTab('main', this)">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
            <span>Главная</span>
        </div>
        <div class="nav-item" onclick="switchTab('calendar', this)">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/></svg>
            <span>Календарь</span>
        </div>
        <div class="nav-item" onclick="switchTab('progress', this)">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
            <span>Прогресс</span>
        </div>
        <div class="nav-item" onclick="switchTab('settings', this)">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
            <span>Настройки</span>
        </div>
    </div>
</div>

<script>
    const tg = window.Telegram?.WebApp;
    if (tg) { tg.ready(); tg.expand(); }

    const telegramId = tg?.initDataUnsafe?.user?.id || 356582454;

    let state = {
        dailyGoal: 100,
        notifEnabled: true,
        notificationInterval: 3,
        timeStart: "09:00",
        timeEnd: "22:00",
        pushupsHistory: [],
        chartMode: 'daily'
    };

    function triggerHaptic() {
        if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    }

    function switchTab(tab, element) {
        triggerHaptic();
        document.querySelectorAll('.screen').forEach(function(el) { el.classList.remove('active'); });
        document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
        document.getElementById('screen-' + tab).classList.add('active');
        if (element) {
            element.classList.add('active');
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
                    document.getElementById('goal-display').innerText = state.dailyGoal;
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

        document.getElementById('today-total-ui').innerHTML = total + ' <span style="font-size: 14px; color: var(--text-secondary); font-weight: 500;">/ ' + state.dailyGoal + '</span>';
        document.getElementById('today-sets-count-ui').innerText = todaySets.length;

        const pct = Math.min(100, Math.round((total / state.dailyGoal) * 100)) || 0;
        document.getElementById('ring-pct').innerText = pct + '%';
        document.getElementById('ring-pct').style.color = pct >= 100 ? 'var(--accent-green)' : 'var(--text-primary)';
        
        const circle = document.getElementById('ring-progress');
        const offset = 226 - (pct / 100) * 226;
        circle.style.strokeDashoffset = offset;
        circle.style.stroke = pct >= 100 ? 'var(--accent-green)' : 'var(--primary)';

        const listEl = document.getElementById('today-sets-list');
        listEl.innerHTML = '';
        if (todaySets.length === 0) {
            listEl.innerHTML = '<div style="text-align: center; color: var(--text-secondary); font-size: 14px; padding: 10px;">Нет данных за сегодня</div>';
        } else {
            todaySets.forEach(function(item) {
                const timeStr = new Date(item.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                listEl.innerHTML += '<div class="exercise-item">' +
                    '<span style="color: var(--accent-green); font-size: 16px; font-weight: 800;">+' + item.count + '</span>' +
                    '<div style="display: flex; gap: 12px; align-items: center;">' +
                        '<span style="color: var(--text-secondary); font-size: 14px;">' + timeStr + '</span>' +
                        '<button style="background: none; border: none; color: #555; padding: 4px; font-size: 16px;" onclick="deleteSet(\\'' + item.id + '\\')">✕</button>' +
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
        document.getElementById('goal-display').innerText = goal;
        
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
                chartData.push({ label: (4 - i) + '-я нед.', value: weekSum });
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
            
            let barClass = 'chart-bar';
            if (isCompleted) barClass += ' filled';
            else if (item.value > 0) barClass += ' active-day';

            chartArea.innerHTML += '<div class="chart-bar-wrap">' +
                '<div style="font-size: 9px; color: var(--text-secondary); margin-bottom: 4px;">' + (item.value > 0 ? item.value : '') + '</div>' +
                '<div class="' + barClass + '" style="height: ' + Math.max(8, heightPct) + '%;"></div>' +
                '<div class="chart-label">' + item.label + '</div>' +
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
            gridEl.innerHTML += '<div class="calendar-weekday">' + wd + '</div>';
        });

        const firstDayIndex = (new Date(year, month, 1).getDay() + 6) % 7;
        const totalDays = new Date(year, month + 1, 0).getDate();

        for (let i = 0; i < firstDayIndex; i++) {
            gridEl.innerHTML += '<div class="calendar-day empty"></div>';
        }

        const todayStr = now.toISOString().split('T')[0];

        for (let day = 1; day <= totalDays; day++) {
            const dayStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
            const isCompleted = completedDays[dayStr] >= state.dailyGoal;
            const hasActivity = completedDays[dayStr] > 0;
            const isToday = (dayStr === todayStr);

            let classes = 'calendar-day';
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
    console.log('✅ Сервер успешно запущен на порту ' + port);
});
