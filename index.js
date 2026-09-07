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

const snoozeMap = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [chatId, time] of snoozeMap.entries()) {
        if (now > time) snoozeMap.delete(chatId);
    }
}, 60 * 60 * 1000);

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
    const userId = String(req.query.telegram_id || 'demo_user');
    
    console.log('📥 Загрузка данных для user_id:', userId);

    if (!supabase) {
        return res.json({
            status: 'ok',
            settings: inMemoryStore.settings[userId] || null,
            profile: inMemoryStore.profiles[userId] || null,
            pushups: inMemoryStore.pushups.filter(p => p.user_id === userId).slice(0, 300)
        });
    }

    try {
        // ОЧЕНЬ ВАЖНО: загружаем с нужным типом данных
        const userId_int = parseInt(userId);
        console.log('🔍 Ищем user_id типа int:', userId_int);
        
        const { data: pushups, error: pushupsError } = await supabase
            .from('pushups')
            .select('*')
            .eq('user_id', userId_int)
            .order('created_at', { ascending: false });

        console.log('✅ Результат запроса:', {
            count: pushups?.length || 0,
            first: pushups?.[0] || null,
            error: pushupsError
        });

        if (pushupsError) {
            console.error('❌ SQL Error:', pushupsError);
        }

        res.json({
            status: 'ok',
            settings: inMemoryStore.settings[userId] || null,
            profile: inMemoryStore.profiles[userId] || null,
            pushups: (pushups || []).slice(0, 300)
        });
    } catch (e) {
        console.error('❌ API Error:', e);
        res.json({
            status: 'ok',
            settings: inMemoryStore.settings[userId] || null,
            profile: inMemoryStore.profiles[userId] || null,
            pushups: inMemoryStore.pushups.filter(p => p.user_id === userId).slice(0, 300)
        });
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
        console.log('✅ Добавлено:', data[0]);
        res.json({ status: 'ok', item: data[0] });
    } catch (e) {
        console.error('❌ Add Error:', e);
        newPushup.id = Date.now();
        inMemoryStore.pushups.unshift(newPushup);
        res.json({ status: 'ok', item: newPushup });
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
        inMemoryStore.pushups = inMemoryStore.pushups.filter(p => p.id !== id);
        res.json({ status: 'ok' });
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
        res.json({ status: 'ok' });
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
        res.json({ status: 'ok' });
    }
});

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
                        user_id: chatId,
                        count: count,
                        created_at: new Date().toISOString(),
                        exercise_type: 'pushups',
                        note: '',
                        rpe: 0
                    }]);
                } else {
                    inMemoryStore.pushups.unshift({
                        id: Date.now(),
                        user_id: chatId,
                        count: count,
                        created_at: new Date().toISOString(),
                        exercise_type: 'pushups',
                        note: '',
                        rpe: 0
                    });
                }
            }

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: cb.id, text: 'Записано +' + count + ' отжиманий! 🔥', show_alert: true })
            });

            sendTelegramMessage(chatId, '✅ <b>Записано +' + count + ' отжиманий!</b>\nОтличная работа! 💪');
        }
    } catch (e) {
        console.error('Webhook processing error:', e);
    }
});

app.get('/api/send-reminders', async (req, res) => {
    if (!BOT_TOKEN) return res.json({ status: 'error', message: 'BOT_TOKEN not configured' });
    res.json({ status: 'ok', sent: 0 });
});

const HTML_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>Fitness Tracker - iOS 19</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root {
            --primary: #0A84FF;
            --primary-light: #30B0FF;
            --accent-green: #34C759;
            --accent-red: #FF3B30;
            --accent-orange: #FF9500;
            --bg-main: #000000;
            --bg-secondary: #1C1C1E;
            --glass-light: rgba(255, 255, 255, 0.08);
            --glass-lighter: rgba(255, 255, 255, 0.12);
            --text-primary: #FFFFFF;
            --text-secondary: #8E8E93;
            --text-tertiary: #5A5A5E;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            -webkit-font-smoothing: antialiased;
            -webkit-tap-highlight-color: transparent;
            user-select: none;
            -webkit-user-select: none;
        }

        html, body {
            width: 100%;
            height: 100%;
            overflow: hidden;
        }

        body {
            background: linear-gradient(135deg, #000000 0%, #0A0A0A 100%);
            color: var(--text-primary);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            font-size: 16px;
            line-height: 1.5;
            padding-top: env(safe-area-inset-top, 0);
            padding-bottom: env(safe-area-inset-bottom, 0);
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
            overflow-x: hidden;
            scroll-behavior: smooth;
            -webkit-overflow-scrolling: touch;
            padding: 0 16px 100px 16px;
            padding-top: 12px;
        }

        .content-area::-webkit-scrollbar {
            width: 4px;
        }

        .content-area::-webkit-scrollbar-track {
            background: transparent;
        }

        .content-area::-webkit-scrollbar-thumb {
            background: var(--glass-lighter);
            border-radius: 2px;
        }

        .screen {
            display: none;
            animation: slideIn 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .screen.active {
            display: block;
        }

        @keyframes slideIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .glass-card {
            background: var(--glass-light);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid var(--glass-lighter);
            border-radius: 20px;
            padding: 20px;
            margin-bottom: 16px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .glass-card:hover {
            background: var(--glass-lighter);
            border-color: rgba(255, 255, 255, 0.15);
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 24px;
            padding: 0 4px;
        }

        .header-title {
            font-size: 32px;
            font-weight: 700;
            letter-spacing: -1.2px;
        }

        .header-subtitle {
            font-size: 13px;
            color: var(--text-secondary);
            margin-top: 4px;
        }

        .progress-ring-container {
            position: relative;
            width: 160px;
            height: 160px;
            margin: 0 auto 24px;
        }

        .progress-ring-svg {
            width: 100%;
            height: 100%;
            transform: rotate(-90deg);
            filter: drop-shadow(0 8px 24px rgba(10, 132, 255, 0.15));
        }

        .progress-ring-bg {
            stroke: var(--glass-lighter);
            stroke-width: 8;
            fill: none;
        }

        .progress-ring-fill {
            stroke: url(#progress-gradient);
            stroke-width: 8;
            fill: none;
            stroke-linecap: round;
            stroke-dasharray: 376;
            stroke-dashoffset: 376;
            transition: stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .progress-ring-text {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            text-align: center;
        }

        .progress-percent {
            font-size: 48px;
            font-weight: 800;
            background: linear-gradient(135deg, var(--primary-light), var(--accent-green));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .progress-label {
            font-size: 12px;
            color: var(--text-secondary);
            margin-top: 4px;
            font-weight: 600;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 20px;
        }

        .stat-item {
            background: var(--glass-light);
            backdrop-filter: blur(20px);
            border: 1px solid var(--glass-lighter);
            border-radius: 16px;
            padding: 16px;
            text-align: center;
            transition: all 0.3s ease;
        }

        .stat-item:active {
            transform: scale(0.98);
            background: var(--glass-lighter);
        }

        .stat-value {
            font-size: 28px;
            font-weight: 800;
            background: linear-gradient(135deg, #34C759, #30B0FF);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }

        .stat-label {
            font-size: 11px;
            color: var(--text-secondary);
            margin-top: 6px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .quick-actions {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 10px;
            margin-bottom: 20px;
        }

        .quick-btn {
            background: linear-gradient(135deg, var(--glass-light), var(--glass-lighter));
            border: 1px solid var(--glass-lighter);
            border-radius: 14px;
            padding: 12px 8px;
            color: var(--primary);
            font-weight: 700;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .quick-btn:active {
            transform: scale(0.92);
            background: var(--glass-lighter);
            box-shadow: 0 8px 24px rgba(10, 132, 255, 0.3);
        }

        .input-group {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }

        .glass-input {
            flex: 1;
            background: var(--glass-light);
            border: 1px solid var(--glass-lighter);
            border-radius: 14px;
            padding: 12px 16px;
            color: var(--text-primary);
            font-size: 16px;
            outline: none;
            transition: all 0.3s ease;
        }

        .glass-input::placeholder {
            color: var(--text-tertiary);
        }

        .glass-input:focus {
            background: var(--glass-lighter);
            border-color: var(--primary);
            box-shadow: 0 0 0 1px var(--primary);
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--primary), var(--primary-light));
            border: none;
            border-radius: 14px;
            padding: 12px 20px;
            color: white;
            font-weight: 700;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 8px 24px rgba(10, 132, 255, 0.3);
        }

        .btn-primary:active {
            transform: scale(0.96);
            box-shadow: 0 4px 12px rgba(10, 132, 255, 0.2);
        }

        .exercise-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .exercise-item {
            background: var(--glass-light);
            border: 1px solid var(--glass-lighter);
            border-radius: 14px;
            padding: 14px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            transition: all 0.3s ease;
        }

        .exercise-item:active {
            transform: translateX(4px);
            background: var(--glass-lighter);
        }

        .exercise-count {
            font-size: 16px;
            font-weight: 800;
            color: var(--accent-green);
        }

        .exercise-time {
            font-size: 12px;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .btn-delete {
            background: rgba(255, 59, 48, 0.2);
            border: 1px solid rgba(255, 59, 48, 0.3);
            border-radius: 10px;
            padding: 6px 10px;
            color: #FF3B30;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .btn-delete:active {
            background: rgba(255, 59, 48, 0.3);
            transform: scale(0.95);
        }

        .form-section {
            margin-bottom: 20px;
        }

        .form-group {
            margin-bottom: 16px;
        }

        .form-label {
            display: block;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-secondary);
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .form-input {
            width: 100%;
            background: var(--glass-light);
            border: 1px solid var(--glass-lighter);
            border-radius: 14px;
            padding: 12px 16px;
            color: var(--text-primary);
            font-size: 16px;
            outline: none;
            transition: all 0.3s ease;
        }

        .form-input:focus {
            background: var(--glass-lighter);
            border-color: var(--primary);
        }

        .form-select {
            width: 100%;
            background: var(--glass-light);
            border: 1px solid var(--glass-lighter);
            border-radius: 14px;
            padding: 12px 16px;
            color: var(--text-primary);
            font-size: 16px;
            outline: none;
            transition: all 0.3s ease;
        }

        .form-select:focus {
            background: var(--glass-lighter);
            border-color: var(--primary);
        }

        .form-select option {
            background: var(--bg-secondary);
            color: var(--text-primary);
        }

        .toggle-switch {
            display: inline-flex;
            width: 50px;
            height: 28px;
            background: var(--glass-lighter);
            border-radius: 14px;
            border: 1px solid var(--glass-lighter);
            cursor: pointer;
            transition: all 0.3s ease;
            position: relative;
        }

        .toggle-switch.on {
            background: linear-gradient(135deg, var(--accent-green), #30B0FF);
            border-color: var(--accent-green);
        }

        .toggle-knob {
            position: absolute;
            width: 24px;
            height: 24px;
            background: white;
            border-radius: 12px;
            top: 2px;
            left: 2px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }

        .toggle-switch.on .toggle-knob {
            left: 24px;
        }

        .bottom-nav {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            height: 70px;
            background: linear-gradient(to top, var(--bg-main), transparent);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border-top: 1px solid var(--glass-lighter);
            display: flex;
            justify-content: space-around;
            align-items: flex-start;
            padding: 8px 0 env(safe-area-inset-bottom, 8px);
            z-index: 1000;
        }

        .nav-item {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            flex: 1;
            padding-top: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
            color: var(--text-tertiary);
            font-size: 10px;
            font-weight: 600;
        }

        .nav-item.active {
            color: var(--primary);
        }

        .nav-icon {
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .calendar-grid {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            gap: 8px;
            margin-top: 16px;
        }

        .calendar-day-header {
            text-align: center;
            font-size: 11px;
            font-weight: 700;
            color: var(--text-secondary);
            padding: 8px 0;
            text-transform: uppercase;
        }

        .calendar-cell {
            aspect-ratio: 1;
            background: var(--glass-light);
            border: 1px solid var(--glass-lighter);
            border-radius: 12px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: 600;
            color: var(--text-primary);
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .calendar-cell:active {
            transform: scale(0.95);
        }

        .calendar-cell.active {
            background: linear-gradient(135deg, var(--accent-green), #30B0FF);
            border-color: var(--accent-green);
            box-shadow: 0 4px 12px rgba(52, 199, 89, 0.3);
        }

        .calendar-count {
            font-size: 9px;
            color: var(--text-secondary);
            margin-top: 2px;
        }

        .chart-container {
            display: flex;
            align-items: flex-end;
            justify-content: space-around;
            gap: 8px;
            height: 150px;
            margin-top: 16px;
        }

        .chart-bar {
            flex: 1;
            background: linear-gradient(to top, var(--primary), var(--primary-light));
            border-radius: 8px 8px 0 0;
            min-height: 8px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 4px 12px rgba(10, 132, 255, 0.2);
            cursor: pointer;
        }

        .chart-bar:active {
            box-shadow: 0 6px 16px rgba(10, 132, 255, 0.3);
        }

        .chart-bar.inactive {
            background: var(--glass-light);
            box-shadow: none;
        }

        .chart-label {
            margin-top: 8px;
            text-align: center;
            font-size: 10px;
            color: var(--text-secondary);
            font-weight: 600;
        }

        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--text-secondary);
        }

        .empty-state-icon {
            font-size: 48px;
            margin-bottom: 12px;
        }

        .empty-state-text {
            font-size: 14px;
            font-weight: 500;
        }
    </style>
</head>
<body>

<div class="app-wrapper">
    <div class="content-area">
        <!-- ГЛАВНАЯ -->
        <div id="screen-main" class="screen active">
            <div class="header">
                <div>
                    <div class="header-title">Тренировки</div>
                    <div class="header-subtitle">Ежедневный прогресс</div>
                </div>
            </div>

            <div class="progress-ring-container">
                <svg class="progress-ring-svg" viewBox="0 0 140 140">
                    <defs>
                        <linearGradient id="progress-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stop-color="#0A84FF" />
                            <stop offset="100%" stop-color="#34C759" />
                        </linearGradient>
                    </defs>
                    <circle class="progress-ring-bg" cx="70" cy="70" r="60"></circle>
                    <circle id="ring-progress" class="progress-ring-fill" cx="70" cy="70" r="60"></circle>
                </svg>
                <div class="progress-ring-text">
                    <div class="progress-percent" id="ring-pct">0%</div>
                    <div class="progress-label">Выполнено</div>
                </div>
            </div>

            <div class="stats-grid">
                <div class="stat-item">
                    <div class="stat-value" id="today-total">0</div>
                    <div class="stat-label">Сегодня</div>
                </div>
                <div class="stat-item">
                    <div class="stat-value" id="today-sets-count">0</div>
                    <div class="stat-label">Подходов</div>
                </div>
            </div>

            <div class="glass-card">
                <div class="header-subtitle" style="margin-bottom: 14px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; font-size: 12px;">Быстрый ввод</div>
                <div class="quick-actions">
                    <button class="quick-btn" onclick="addQuick(15)">+15</button>
                    <button class="quick-btn" onclick="addQuick(20)">+20</button>
                    <button class="quick-btn" onclick="addQuick(25)">+25</button>
                    <button class="quick-btn" onclick="addQuick(30)">+30</button>
                    <button class="quick-btn" onclick="addQuick(35)">+35</button>
                </div>
                <div class="input-group">
                    <input type="number" id="custom-count-input" class="glass-input" placeholder="Свой результат..." inputmode="numeric">
                    <button class="btn-primary" onclick="submitCustomCount()" style="padding: 12px 16px;">Добавить</button>
                </div>
            </div>

            <div class="glass-card">
                <div class="header-subtitle" style="margin-bottom: 14px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; font-size: 12px;">Результаты</div>
                <div id="today-sets-list" class="exercise-list"></div>
            </div>
        </div>

        <!-- КАЛЕНДАРЬ -->
        <div id="screen-calendar" class="screen">
            <div class="header">
                <div>
                    <div class="header-title">Календарь</div>
                    <div class="header-subtitle" id="cal-month-title">Ноябрь 2024</div>
                </div>
            </div>

            <div class="glass-card">
                <div class="calendar-grid" id="calendar-grid-container"></div>
            </div>
        </div>

        <!-- ПРОГРЕСС -->
        <div id="screen-progress" class="screen">
            <div class="header">
                <div>
                    <div class="header-title">Прогресс</div>
                    <div class="header-subtitle">Статистика за неделю</div>
                </div>
            </div>

            <div class="glass-card">
                <div class="chart-container" id="progress-bars-container"></div>
            </div>
        </div>

        <!-- ПРОФИЛЬ -->
        <div id="screen-profile" class="screen">
            <div class="header">
                <div>
                    <div class="header-title">Профиль</div>
                    <div class="header-subtitle">Антропометрия</div>
                </div>
            </div>

            <div class="glass-card">
                <div class="form-section">
                    <div class="form-group">
                        <label class="form-label">Вес (кг)</label>
                        <input type="number" id="prof-weight" class="form-input" value="80" oninput="calcBMI()">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Рост (см)</label>
                        <input type="number" id="prof-height" class="form-input" value="180" oninput="calcBMI()">
                    </div>
                    <div class="form-group">
                        <label class="form-label">% Жира</label>
                        <input type="number" id="prof-fat" class="form-input" value="18">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Целевой вес (кг)</label>
                        <input type="number" id="prof-target-weight" class="form-input" value="75">
                    </div>
                </div>

                <div style="background: linear-gradient(135deg, rgba(52, 199, 89, 0.1), rgba(10, 132, 255, 0.1)); border: 1px solid rgba(52, 199, 89, 0.3); border-radius: 16px; padding: 16px; text-align: center;">
                    <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">Индекс массы тела</div>
                    <div style="font-size: 32px; font-weight: 800; background: linear-gradient(135deg, var(--accent-green), var(--primary)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;" id="bmi-val">24.7</div>
                    <div style="font-size: 12px; color: var(--accent-green); margin-top: 6px; font-weight: 600;" id="bmi-status-label">Норма</div>
                </div>

                <button class="btn-primary" onclick="saveProfileData()" style="width: 100%; margin-top: 16px;">Сохранить профиль</button>
            </div>
        </div>

        <!-- НАСТРОЙКИ -->
        <div id="screen-settings" class="screen">
            <div class="header">
                <div>
                    <div class="header-title">Настройки</div>
                    <div class="header-subtitle">Параметры уведомлений</div>
                </div>
            </div>

            <div class="glass-card">
                <div class="form-section">
                    <div class="form-group">
                        <label class="form-label">Дневная цель (повторений)</label>
                        <input type="number" id="set-daily-goal" class="form-input" value="100">
                    </div>

                    <div class="form-group">
                        <div style="display: flex; align-items: center; justify-content: space-between;">
                            <div>
                                <div class="form-label">Уведомления</div>
                                <div style="font-size: 12px; color: var(--text-tertiary); margin-top: 2px;">Напоминания в Telegram</div>
                            </div>
                            <div id="set-notif-toggle" class="toggle-switch on" onclick="toggleNotif()">
                                <div class="toggle-knob"></div>
                            </div>
                        </div>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Интервал уведомлений</label>
                        <select id="set-interval" class="form-select">
                            <option value="1">Каждый час</option>
                            <option value="2">Каждые 2 часа</option>
                            <option value="3" selected>Каждые 3 часа</option>
                            <option value="4">Каждые 4 часа</option>
                        </select>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Время начала</label>
                        <input type="time" id="set-time-start" class="form-input" value="09:00">
                    </div>

                    <div class="form-group">
                        <label class="form-label">Время окончания</label>
                        <input type="time" id="set-time-end" class="form-input" value="22:00">
                    </div>
                </div>

                <button class="btn-primary" onclick="saveSettingsData()" style="width: 100%;">Сохранить настройки</button>
            </div>
        </div>
    </div>

    <!-- BOTTOM NAVIGATION -->
    <div class="bottom-nav">
        <div class="nav-item active" onclick="switchTab('main')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>
            </svg>
            <span>Главная</span>
        </div>
        <div class="nav-item" onclick="switchTab('calendar')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/>
            </svg>
            <span>Календарь</span>
        </div>
        <div class="nav-item" onclick="switchTab('progress')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>
            </svg>
            <span>Прогресс</span>
        </div>
        <div class="nav-item" onclick="switchTab('profile')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
            <span>Профиль</span>
        </div>
        <div class="nav-item" onclick="switchTab('settings')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
            <span>Настройки</span>
        </div>
    </div>
</div>

<script>
    const tg = window.Telegram?.WebApp;
    if (tg) {
        tg.ready();
        tg.expand();
    }

    const telegramId = tg?.initDataUnsafe?.user?.id || "demo_user";
    console.log('🔐 User ID:', telegramId);

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
        console.log('⏳ Загрузка данных...');
        try {
            const url = '/api/user-data?telegram_id=' + telegramId;
            console.log('📤 Запрос:', url);
            
            const res = await fetch(url);
            const data = await res.json();
            
            console.log('📥 Ответ:', {
                status: data.status,
                pushups_count: data.pushups?.length || 0,
                first_pushup: data.pushups?.[0] || null
            });
            
            if (data.status === 'ok') {
                state.pushupsHistory = data.pushups || [];
            }
        } catch (e) {
            console.error("❌ Ошибка загрузки:", e);
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
        const filtered = state.pushupsHistory.filter(item => getDateOnly(item.created_at) === todayStr);
        console.log('🔍 Сегодня найдено:', filtered.length);
        return filtered;
    }

    function updateProgressUI() {
        const todaySets = getTodaySets();
        const total = todaySets.reduce((a, b) => a + b.count, 0);

        document.getElementById('today-total').innerText = total;
        document.getElementById('today-sets-count').innerText = todaySets.length;

        const pct = Math.min(100, Math.round((total / state.dailyGoal) * 100)) || 0;
        document.getElementById('ring-pct').innerText = pct + '%';

        const circle = document.getElementById('ring-progress');
        const circumference = 2 * Math.PI * 60;
        const offset = circumference - (pct / 100) * circumference;
        circle.style.strokeDashoffset = offset;

        const listEl = document.getElementById('today-sets-list');
        listEl.innerHTML = '';
        if (todaySets.length === 0) {
            listEl.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💪</div><div class="empty-state-text">Добавьте первый результат</div></div>';
        } else {
            todaySets.forEach((item) => {
                const dateObj = new Date(item.created_at);
                const timeStr = String(dateObj.getHours()).padStart(2, '0') + ':' + String(dateObj.getMinutes()).padStart(2, '0');
                const div = document.createElement('div');
                div.className = 'exercise-item';
                div.innerHTML = '<span class="exercise-count">+' + item.count + '</span>' +
                                '<div class="exercise-time">' +
                                    '<span>' + timeStr + '</span>' +
                                    '<button class="btn-delete" onclick="deleteSet(' + item.id + ')">✕</button>' +
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
                console.log('✅ Добавлено:', data.item);
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
        toggle.classList.toggle('on');
    }

    function calcBMI() {
        const w = parseFloat(document.getElementById('prof-weight').value) || 0;
        const h = (parseFloat(document.getElementById('prof-height').value) || 0) / 100;
        if (w > 0 && h > 0) {
            const bmi = (w / (h * h)).toFixed(1);
            document.getElementById('bmi-val').innerText = bmi;
            const statusEl = document.getElementById('bmi-status-label');
            if (bmi < 18.5) {
                statusEl.innerText = '⚠️ Дефицит';
                statusEl.style.color = '#30B0FF';
            } else if (bmi < 25) {
                statusEl.innerText = '✓ Норма';
                statusEl.style.color = '#34C759';
            } else if (bmi < 30) {
                statusEl.innerText = '⚠️ Избыток';
                statusEl.style.color = '#FF9500';
            } else {
                statusEl.innerText = '⚠️ Ожирение';
                statusEl.style.color = '#FF3B30';
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
            if (tg) tg.showAlert("✓ Настройки сохранены!");
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
            if (tg) tg.showAlert("✓ Профиль обновлён!");
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
            head.className = 'calendar-day-header';
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
            cell.className = 'calendar-cell';
            
            const cellDate = new Date(now.getFullYear(), now.getMonth(), i);
            const dayDateStr = getDateOnly(cellDate);
            
            const dayTotal = state.pushupsHistory
                .filter(item => getDateOnly(item.created_at) === dayDateStr)
                .reduce((a, b) => a + b.count, 0);

            if (dayTotal > 0) {
                cell.classList.add('active');
                cell.innerHTML = '<span>' + i + '</span><span class="calendar-count">' + dayTotal + '</span>';
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
            col.style.cssText = 'flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px;';

            const bar = document.createElement('div');
            bar.className = i === currentDayOfWeek ? 'chart-bar' : 'chart-bar inactive';
            bar.style.height = Math.max(8, pct) + '%';

            const lbl = document.createElement('div');
            lbl.className = 'chart-label';
            lbl.innerText = dayNames[i];

            col.appendChild(bar);
            col.appendChild(lbl);
            container.appendChild(col);
        }
    }

    // Загружаем данные при старте
    loadUserData();

    // Обновляем каждые 5 секунд
    setInterval(loadUserData, 5000);
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
