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
    const telegramIdRaw = req.query.telegram_id || 'demo_user';
    const userIdInt = parseInt(telegramIdRaw) || 0;
    const userIdStr = String(telegramIdRaw);
    
    console.log('📥 Загрузка данных для user_id:', userIdStr);

    if (!supabase) {
        return res.json({
            status: 'ok',
            settings: inMemoryStore.settings[userIdStr] || null,
            profile: inMemoryStore.profiles[userIdStr] || null,
            pushups: inMemoryStore.pushups.filter(p => p.user_id === userIdInt).slice(0, 300)
        });
    }

    try {
        // 1. Получаем историю отжиманий
        const { data: pushups, error: pushupsError } = await supabase
            .from('pushups')
            .select('*')
            .eq('user_id', userIdInt)
            .order('created_at', { ascending: false });

        if (pushupsError) console.error('❌ SQL Error (pushups):', pushupsError);

        // 2. Получаем настройки пользователя (безопасный запрос)
        let settingsData = null;
        try {
            const { data } = await supabase.from('user_settings').select('*').eq('user_id', userIdStr).maybeSingle();
            settingsData = data;
        } catch (e) { console.error('Настроек нет, используем дефолт'); }

        // 3. Получаем профиль пользователя (безопасный запрос)
        let profileData = null;
        try {
            const { data } = await supabase.from('user_profiles').select('*').eq('user_id', userIdStr).maybeSingle();
            profileData = data;
        } catch (e) { console.error('Профиля нет, используем дефолт'); }

        res.json({
            status: 'ok',
            settings: settingsData || inMemoryStore.settings[userIdStr] || null,
            profile: profileData || inMemoryStore.profiles[userIdStr] || null,
            pushups: (pushups || []).slice(0, 300)
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
    <title>Fitness Tracker</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root {
            --primary: #0A84FF;
            --primary-light: #30B0FF;
            --accent-green: #34C759;
            --bg-main: #000000;
            --bg-secondary: #121212;
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
            height: 100%;
            background-color: var(--bg-main);
            color: var(--text-primary);
            overflow: hidden;
        }

        .app-wrapper {
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        .content-area {
            flex: 1;
            overflow-y: auto;
            padding: 16px 16px 100px 16px;
        }

        .screen { display: none; animation: fadeIn 0.3s ease; }
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
            transition: stroke-dashoffset 0.8s ease;
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
            padding: 10px 0;
            color: var(--text-primary);
            font-weight: 700;
            font-size: 15px;
            cursor: pointer;
            transition: background 0.2s;
        }
        
        .quick-btn:active { background: #3a3a3c; }

        .input-group {
            display: flex;
            gap: 8px;
        }

        .glass-input {
            flex: 1;
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
        }
        
        .btn-green:active { opacity: 0.8; }

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

        .bottom-nav {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            height: 80px;
            background: var(--glass-light);
            display: flex;
            justify-content: space-around;
            padding-top: 12px;
            border-top: 1px solid rgba(255,255,255,0.05);
            padding-bottom: env(safe-area-inset-bottom);
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
        }

        .nav-item.active { color: var(--primary); }
        .nav-icon { width: 24px; height: 24px; }
        
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
        
        <!-- ГЛАВНАЯ ЭКРАН -->
        <div id="screen-main" class="screen active">
            
            <div class="glass-card header-top">
                <div class="header-icon">1</div>
                <div>
                    <div style="font-size: 10px; color: var(--text-secondary); letter-spacing: 1px; font-weight: 700;">IOS FITNESS TRACKER</div>
                    <div style="font-size: 20px; font-weight: 700;">13-й</div>
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
                    <input type="number" id="custom-count" class="glass-input" placeholder="Введите своё число..." inputmode="numeric">
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
                <div class="section-title">Календарь в разработке</div>
                <p style="color: var(--text-secondary); font-size: 14px;">Здесь будет сетка календаря.</p>
            </div>
        </div>

        <!-- ПРОГРЕСС -->
        <div id="screen-progress" class="screen">
            <div class="glass-card">
                <div class="section-title">Статистика</div>
                <p style="color: var(--text-secondary); font-size: 14px;">Здесь будет график.</p>
            </div>
        </div>

        <!-- НАСТРОЙКИ И ПРОФИЛЬ -->
        <div id="screen-settings" class="screen">
            
            <div class="glass-card">
                <div class="section-title">Настройки тренировок</div>
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
                <button class="btn-green" onclick="saveSettingsData()" style="width: 100%; margin-top: 10px;">Сохранить настройки</button>
            </div>

            <div class="glass-card">
                <div class="section-title">Антропометрия</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                    <div class="form-group">
                        <label class="form-label">Вес (кг)</label>
                        <input type="number" id="prof-weight" class="form-input">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Рост (см)</label>
                        <input type="number" id="prof-height" class="form-input">
                    </div>
                    <div class="form-group">
                        <label class="form-label">% Жира</label>
                        <input type="number" id="prof-fat" class="form-input">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Целевой вес (кг)</label>
                        <input type="number" id="prof-target-weight" class="form-input">
                    </div>
                </div>
                <button class="btn-green" onclick="saveProfileData()" style="width: 100%; margin-top: 10px; background: var(--primary); color: white;">Сохранить профиль</button>
            </div>
        </div>

    </div>

    <!-- Навигация -->
    <div class="bottom-nav">
        <div class="nav-item active" onclick="switchTab('main')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
            <span>Главная</span>
        </div>
        <div class="nav-item" onclick="switchTab('calendar')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/></svg>
            <span>Календарь</span>
        </div>
        <div class="nav-item" onclick="switchTab('progress')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
            <span>Прогресс</span>
        </div>
        <div class="nav-item" onclick="switchTab('settings')">
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
            <span>Настройки</span>
        </div>
    </div>
</div>

<script>
    const tg = window.Telegram?.WebApp;
    if (tg) { tg.ready(); tg.expand(); }

    const telegramId = tg?.initDataUnsafe?.user?.id || "demo_user";

    let state = {
        dailyGoal: 100,
        notifEnabled: true,
        pushupsHistory: []
    };

    function triggerHaptic() {
        if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    }

    function switchTab(tab) {
        triggerHaptic();
        document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        document.getElementById('screen-' + tab).classList.add('active');
        event.currentTarget.classList.add('active');
    }

    async function loadUserData() {
        try {
            const res = await fetch('/api/user-data?telegram_id=' + telegramId);
            const data = await res.json();
            
            if (data.status === 'ok') {
                state.pushupsHistory = data.pushups || [];
                
                // Подтягиваем настройки в UI
                if (data.settings) {
                    state.dailyGoal = data.settings.daily_goal || 100;
                    state.notifEnabled = data.settings.notifications_enabled !== false;
                    document.getElementById('set-daily-goal').value = state.dailyGoal;
                    document.getElementById('goal-display').innerText = state.dailyGoal;
                    
                    const toggle = document.getElementById('set-notif-toggle');
                    if (state.notifEnabled) toggle.classList.add('on');
                    else toggle.classList.remove('on');
                }

                // Подтягиваем профиль в UI
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
        const todaySets = state.pushupsHistory.filter(i => i.created_at.startsWith(todayStr));
        const total = todaySets.reduce((a, b) => a + b.count, 0);

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
            todaySets.forEach(item => {
                const timeStr = new Date(item.created_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                listEl.innerHTML += \`
                    <div class="exercise-item">
                        <span style="color: var(--accent-green); font-size: 16px; font-weight: 800;">+\${item.count}</span>
                        <div style="display: flex; gap: 12px; align-items: center;">
                            <span style="color: var(--text-secondary); font-size: 14px;">\${timeStr}</span>
                            <button style="background: none; border: none; color: #555; padding: 4px; font-size: 16px;" onclick="deleteSet(\${item.id})">✕</button>
                        </div>
                    </div>\`;
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
            if (data.status === 'ok') state.pushupsHistory.unshift(data.item);
        } catch (e) { console.error(e); }
        updateProgressUI();
    }

    function submitCustom() {
        const val = parseInt(document.getElementById('custom-count').value);
        if (val > 0) {
            addQuick(val);
            document.getElementById('custom-count').value = '';
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
            if ((await res.json()).status === 'ok') {
                state.pushupsHistory = state.pushupsHistory.filter(i => i.id !== id);
                updateProgressUI();
            }
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
        state.dailyGoal = goal;
        document.getElementById('goal-display').innerText = goal;
        
        await fetch('/api/save-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telegram_id: telegramId, daily_goal: goal, notifications_enabled: state.notifEnabled })
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
