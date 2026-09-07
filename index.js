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
                <div class="header-subtitle" style="margin-bottom: 14px; color: 
