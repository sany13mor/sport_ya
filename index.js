const express = require('express');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 10000;

// Инициализация Telegram-бота
const token = process.env.BOT_TOKEN;
let bot;
if (token) {
    bot = new TelegramBot(token, { polling: true });

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, '💪 Привет! Выберите действие или наберите быстрый подход:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📊 Открыть Трекер (WebApp)', web_app: { url: process.env.WEBAPP_URL || 'https://sport-ya.onrender.com' } }],
                    [
                        { text: '+15', callback_data: 'quick_add_15' },
                        { text: '+20', callback_data: 'quick_add_20' },
                        { text: '+25', callback_data: 'quick_add_25' },
                        { text: '+30', callback_data: 'quick_add_30' }
                    ]
                ]
            }
        });
    });

    bot.on('callback_query', async (query) => {
        if (query.data && query.data.startsWith('quick_add_')) {
            const count = parseInt(query.data.split('_')[2]);
            const userId = query.from.id;
            try {
                await pool.query(
                    'INSERT INTO pushups (user_id, count, exercise_type) VALUES ($1, $2, $3)',
                    [userId, count, 'pushups']
                );
                bot.answerCallbackQuery(query.id, { text: `✅ Добавлено +${count} отжиманий!` });
                bot.sendMessage(userId, `🚀 Записано +${count} отжиманий из чата!`);
            } catch (err) {
                console.error('Ошибка записи из чата:', err);
                bot.answerCallbackQuery(query.id, { text: '❌ Ошибка записи' });
            }
        }
    });
}

// Подключение к PostgreSQL (Supabase)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Автовосстановление пропавших данных и инициализация БД
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pushups (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                count INT NOT NULL,
                exercise_type VARCHAR(50) DEFAULT 'pushups',
                note TEXT DEFAULT '',
                rpe INT DEFAULT 0,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS user_settings (
                user_id BIGINT PRIMARY KEY,
                goal INT DEFAULT 100,
                reminders_enabled BOOLEAN DEFAULT true,
                reminder_interval_hours INT DEFAULT 3,
                reminder_start_hour INT DEFAULT 10,
                reminder_end_hour INT DEFAULT 23,
                timezone VARCHAR(50) DEFAULT 'UTC',
                presets JSONB DEFAULT '[15, 20, 25, 30, 35]'::jsonb,
                last_reminder_sent TIMESTAMP WITH TIME ZONE
            );

            CREATE TABLE IF NOT EXISTS user_achievements (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                achievement_key VARCHAR(50) NOT NULL,
                unlocked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                UNIQUE(user_id, achievement_key)
            );

            -- ВОССТАНОВЛЕНИЕ ДАННЫХ ИЗ ЭКСПЕРИМЕНТАЛЬНЫХ ТАБЛИЦ
            DO $$
            BEGIN
                IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'exercises') THEN
                    INSERT INTO pushups (user_id, count, exercise_type, note, rpe, created_at)
                    SELECT user_id, count, COALESCE(exercise_type, 'pushups'), COALESCE(note, ''), COALESCE(rpe, 0), created_at
                    FROM exercises e
                    WHERE NOT EXISTS (
                        SELECT 1 FROM pushups p 
                        WHERE p.user_id = e.user_id 
                          AND p.created_at = e.created_at 
                          AND p.count = e.count
                    );
                END IF;

                IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'pushups_old_backup') THEN
                    INSERT INTO pushups (user_id, count, created_at)
                    SELECT user_id, count, created_at
                    FROM pushups_old_backup b
                    WHERE NOT EXISTS (
                        SELECT 1 FROM pushups p 
                        WHERE p.user_id = b.user_id 
                          AND p.created_at = b.created_at 
                          AND p.count = b.count
                    );
                END IF;
            END $$;
        `);
        console.log('✅ Данные успешно восстановлены. База готова к работе!');
    } catch (err) {
        console.error('❌ Ошибка инициализации и миграции БД:', err);
    }
}
initDB();

app.use(express.json());

// Проверка подлинности Telegram initData
function verifyTelegramInitData(initData) {
    if (!token || !initData) return true;
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataCheckString = Array.from(urlParams.entries())
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        return calculatedHash === hash;
    } catch (e) {
        return false;
    }
}

// Защита от частых запросов
const rateLimitMap = new Map();
function rateLimiter(req, res, next) {
    const userId = req.body.user_id || req.query.user_id;
    if (!userId) return next();
    const now = Date.now();
    const lastRequest = rateLimitMap.get(userId) || 0;
    if (now - lastRequest < 400) {
        return res.status(429).json({ error: 'Запросы отправляются слишком часто' });
    }
    rateLimitMap.set(userId, now);
    next();
}

// Планировщик уведомлений
setInterval(async () => {
    if (!bot) return;
    try {
        const res = await pool.query(`
            SELECT s.user_id, s.reminder_interval_hours 
            FROM user_settings s
            WHERE s.reminders_enabled = true 
              AND EXTRACT(HOUR FROM NOW() AT TIMEZONE COALESCE(s.timezone, 'UTC')) >= s.reminder_start_hour
              AND EXTRACT(HOUR FROM NOW() AT TIMEZONE COALESCE(s.timezone, 'UTC')) < s.reminder_end_hour
              AND (s.last_reminder_sent IS NULL OR s.last_reminder_sent < NOW() - (s.reminder_interval_hours || ' hours')::INTERVAL)
              AND NOT EXISTS (
                  SELECT 1 FROM pushups p 
                  WHERE p.user_id = s.user_id 
                    AND p.created_at >= CURRENT_DATE
              )
        `);

        for (const row of res.rows) {
            bot.sendMessage(row.user_id, '💪 Не забудь выполнить подход сегодня! Трекер ждет новых результатов.', {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '+15', callback_data: 'quick_add_15' },
                        { text: '+25', callback_data: 'quick_add_25' },
                        { text: '📊 Открыть WebApp', web_app: { url: process.env.WEBAPP_URL || 'https://sport-ya.onrender.com' } }
                    ]]
                }
            });
            await pool.query('UPDATE user_settings SET last_reminder_sent = NOW() WHERE user_id = $1', [row.user_id]);
        }
    } catch (e) {
        console.error('Ошибка планировщика:', e);
    }
}, 5 * 60 * 1000);

// --- API ---

// 1. Основные данные пользователя, серии и достижения
app.get('/api/user-data', async (req, res) => {
    const userId = req.query.user_id;
    const exerciseType = req.query.exercise_type || 'pushups';
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    try {
        let settingsRes = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
        if (settingsRes.rows.length === 0) {
            await pool.query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
            settingsRes = await pool.query('SELECT * FROM user_settings WHERE user_id = $1', [userId]);
        }

        const todayRes = await pool.query(`
            SELECT id, count, note, rpe, created_at 
            FROM pushups 
            WHERE user_id = $1 AND COALESCE(exercise_type, 'pushups') = $2 AND created_at >= CURRENT_DATE 
            ORDER BY created_at DESC
        `, [userId, exerciseType]);

        const totalRes = await pool.query(`
            SELECT SUM(count) as total_count, COUNT(DISTINCT DATE(created_at)) as active_days 
            FROM pushups WHERE user_id = $1 AND COALESCE(exercise_type, 'pushups') = $2
        `, [userId, exerciseType]);

        // Расчет серии дней без пропусков (Streak)
        const streakRes = await pool.query(`
            SELECT DISTINCT DATE(created_at) as day
            FROM pushups
            WHERE user_id = $1 AND COALESCE(exercise_type, 'pushups') = $2
            ORDER BY day DESC
        `, [userId, exerciseType]);

        let streak = 0;
        let checkDate = new Date();
        const dates = streakRes.rows.map(r => new Date(r.day).toISOString().split('T')[0]);

        while (true) {
            const dateStr = checkDate.toISOString().split('T')[0];
            if (dates.includes(dateStr)) {
                streak++;
                checkDate.setDate(checkDate.getDate() - 1);
            } else if (streak === 0) {
                checkDate.setDate(checkDate.getDate() - 1);
                const prevStr = checkDate.toISOString().split('T')[0];
                if (dates.includes(prevStr)) {
                    streak++;
                    checkDate.setDate(checkDate.getDate() - 1);
                } else break;
            } else break;
        }

        const achievementsRes = await pool.query('SELECT achievement_key FROM user_achievements WHERE user_id = $1', [userId]);

        res.json({
            success: true,
            settings: settingsRes.rows[0],
            todayHistory: todayRes.rows,
            totalCount: parseInt(totalRes.rows[0].total_count) || 0,
            activeDays: parseInt(totalRes.rows[0].active_days) || 0,
            streak: streak,
            achievements: achievementsRes.rows.map(a => a.achievement_key)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. Добавление подхода
app.post('/api/add', rateLimiter, async (req, res) => {
    const { user_id, count, exercise_type, note, rpe, initData } = req.body;
    if (!verifyTelegramInitData(initData)) return res.status(403).json({ error: 'Invalid initData' });
    if (!user_id || !count) return res.status(400).json({ error: 'Invalid data' });

    try {
        await pool.query(
            'INSERT INTO pushups (user_id, count, exercise_type, note, rpe) VALUES ($1, $2, $3, $4, $5)',
            [user_id, count, exercise_type || 'pushups', note || '', rpe || 0]
        );

        const totalRes = await pool.query('SELECT SUM(count) as total FROM pushups WHERE user_id = $1', [user_id]);
        if ((parseInt(totalRes.rows[0].total) || 0) >= 1000) {
            await pool.query('INSERT INTO user_achievements (user_id, achievement_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user_id, '1000_rep_club']);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 3. Удаление и редактирование подхода
app.delete('/api/delete-set/:id', async (req, res) => {
    const { user_id } = req.body;
    try {
        await pool.query('DELETE FROM pushups WHERE id = $1 AND user_id = $2', [req.params.id, user_id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 4. Сохранение настроек (включая диапазон часов)
app.post('/api/settings', async (req, res) => {
    const { user_id, goal, reminders_enabled, reminder_interval_hours, reminder_start_hour, reminder_end_hour, timezone, presets } = req.body;
    try {
        await pool.query(`
            INSERT INTO user_settings (user_id, goal, reminders_enabled, reminder_interval_hours, reminder_start_hour, reminder_end_hour, timezone, presets)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
            ON CONFLICT (user_id) DO UPDATE SET
                goal = EXCLUDED.goal,
                reminders_enabled = EXCLUDED.reminders_enabled,
                reminder_interval_hours = EXCLUDED.reminder_interval_hours,
                reminder_start_hour = EXCLUDED.reminder_start_hour,
                reminder_end_hour = EXCLUDED.reminder_end_hour,
                timezone = EXCLUDED.timezone,
                presets = EXCLUDED.presets
        `, [
            user_id, goal, reminders_enabled, reminder_interval_hours,
            reminder_start_hour ?? 10, reminder_end_hour ?? 23,
            timezone || 'UTC', JSON.stringify(presets || [15, 20, 25, 30, 35])
        ]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 5. Годовой Календарь
app.get('/api/calendar-year', async (req, res) => {
    const userId = req.query.user_id;
    const year = req.query.year || new Date().getFullYear();
    const exerciseType = req.query.exercise_type || 'pushups';

    try {
        const result = await pool.query(`
            SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as date, SUM(count) as total, COUNT(id) as sets_count
            FROM pushups
            WHERE user_id = $1 AND COALESCE(exercise_type, 'pushups') = $3 AND EXTRACT(YEAR FROM created_at) = $2
            GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
        `, [userId, year, exerciseType]);

        const map = {};
        result.rows.forEach(r => { map[r.date] = { total: parseInt(r.total), sets: parseInt(r.sets_count) }; });
        res.json({ success: true, calendarMap: map });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 6. Графики и аналитика
app.get('/api/stats-charts', async (req, res) => {
    const userId = req.query.user_id;
    const exerciseType = req.query.exercise_type || 'pushups';
    try {
        const weeklyRes = await pool.query(`
            SELECT TO_CHAR(created_at, 'DD.MM') as day_label, SUM(count) as total
            FROM pushups
            WHERE user_id = $1 AND COALESCE(exercise_type, 'pushups') = $2 AND created_at >= NOW() - INTERVAL '7 days'
            GROUP BY DATE(created_at), TO_CHAR(created_at, 'DD.MM')
            ORDER BY DATE(created_at) ASC
        `, [userId, exerciseType]);

        const monthlyRes = await pool.query(`
            SELECT TO_CHAR(created_at, 'DD.MM') as day_label, SUM(count) as total
            FROM pushups
            WHERE user_id = $1 AND COALESCE(exercise_type, 'pushups') = $2 AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at), TO_CHAR(created_at, 'DD.MM')
            ORDER BY DATE(created_at) ASC
        `, [userId, exerciseType]);

        res.json({ success: true, weekly: weeklyRes.rows, monthly: monthlyRes.rows });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 7. Лидерборд
app.get('/api/leaderboard', async (req, res) => {
    const exerciseType = req.query.exercise_type || 'pushups';
    try {
        const result = await pool.query(`
            SELECT user_id, SUM(count) as total
            FROM pushups
            WHERE COALESCE(exercise_type, 'pushups') = $1 AND created_at >= CURRENT_DATE
            GROUP BY user_id
            ORDER BY total DESC
            LIMIT 10
        `, [exerciseType]);
        res.json({ success: true, leaders: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'Database error' });
    }
});

// 8. Экспорт в CSV
app.get('/api/export-csv', async (req, res) => {
    const userId = req.query.user_id;
    try {
        const result = await pool.query(
            "SELECT created_at, COALESCE(exercise_type, 'pushups') as exercise, count, note, rpe FROM pushups WHERE user_id = $1 ORDER BY created_at DESC",
            [userId]
        );
        let csv = 'Date,Exercise,Count,Note,RPE\n';
        result.rows.forEach(r => {
            csv += `"${r.created_at.toISOString()}","${r.exercise}",${r.count},"${r.note || ''}",${r.rpe || 0}\n`;
        });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=fitness_export.csv');
        res.send(csv);
    } catch (err) {
        res.status(500).send('Export error');
    }
});

// --- ВЕБ-ИНТЕРФЕЙС ---
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>iOS Fitness Tracker Pro</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --ios-bg: var(--tg-theme-bg-color, #000000);
            --glass-bg: rgba(255, 255, 255, 0.08);
            --glass-border: rgba(255, 255, 255, 0.12);
            --accent-green: #30d158;
            --accent-blue: #0a84ff;
            --accent-orange: #ff9f0a;
            --accent-red: #ff453a;
            --text-primary: var(--tg-theme-text-color, #ffffff);
            --text-secondary: rgba(255, 255, 255, 0.55);
        }

        * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Roboto, sans-serif; }

        body {
            background-color: var(--ios-bg);
            background-image: radial-gradient(at 0% 0%, rgba(10, 132, 255, 0.18) 0px, transparent 45%),
                              radial-gradient(at 100% 0%, rgba(48, 209, 88, 0.15) 0px, transparent 45%);
            background-attachment: fixed;
            color: var(--text-primary); min-height: 100vh;
            padding: max(16px, env(safe-area-inset-top)) 16px max(95px, env(safe-area-inset-bottom)) 16px;
            display: flex; flex-direction: column; gap: 14px;
        }

        .glass-card {
            background: var(--glass-bg); backdrop-filter: blur(25px) saturate(180%);
            -webkit-backdrop-filter: blur(25px) saturate(180%);
            border: 1px solid var(--glass-border); border-radius: 20px; padding: 16px;
        }

        .header { display: flex; justify-content: space-between; align-items: center; }
        .user-profile { display: flex; align-items: center; gap: 12px; }
        .avatar {
            width: 42px; height: 42px; border-radius: 50%;
            background: linear-gradient(135deg, var(--accent-blue), var(--accent-green));
            display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px;
        }
        .title-sub { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        .title-main { font-size: 18px; font-weight: 700; }

        .exercise-selector { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-top: 2px; }
        .exercise-chip {
            background: rgba(255,255,255,0.06); border: 1px solid var(--glass-border);
            padding: 8px 14px; border-radius: 20px; font-size: 13px; font-weight: 600;
            white-space: nowrap; cursor: pointer; color: var(--text-secondary);
        }
        .exercise-chip.active { background: var(--accent-blue); color: #fff; border-color: var(--accent-blue); }

        .main-stats { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 8px; }
        .ring-container { position: relative; width: 95px; height: 95px; display: flex; align-items: center; justify-content: center; }
        .ring-svg { transform: rotate(-90deg); width: 100%; height: 100%; }
        .ring-bg { fill: none; stroke: rgba(255, 255, 255, 0.08); stroke-width: 9; }
        .ring-progress {
            fill: none; stroke: url(#ringGradient); stroke-width: 9; stroke-linecap: round;
            stroke-dasharray: 283; stroke-dashoffset: 283; transition: stroke-dashoffset 0.8s ease;
        }
        .ring-text { position: absolute; text-align: center; }
        .ring-percent { font-size: 19px; font-weight: 800; }

        .stat-value { font-size: 24px; font-weight: 800; line-height: 1; }
        .stat-desc { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }

        .presets-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin-top: 6px; }
        .btn-glass {
            background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.14);
            border-radius: 12px; padding: 12px 0; color: #fff; font-size: 15px; font-weight: 700;
            cursor: pointer; outline: none; transition: all 0.15s;
        }
        .btn-glass:active { transform: scale(0.92); background: rgba(255, 255, 255, 0.2); }

        .custom-input-box { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
        .input-row { display: flex; gap: 8px; align-items: center; }
        .input-glass {
            flex: 1; background: rgba(255, 255, 255, 0.06); border: 1px solid var(--glass-border);
            border-radius: 12px; color: #fff; font-size: 14px; padding: 10px 12px; outline: none;
        }
        .select-glass {
            background: rgba(255, 255, 255, 0.1); border: 1px solid var(--glass-border);
            color: #fff; padding: 6px 10px; border-radius: 8px; outline: none; font-size: 13px;
        }
        .btn-add-action {
            background: linear-gradient(135deg, var(--accent-green), #249d42);
            border: none; border-radius: 12px; padding: 12px 20px; color: #fff;
            font-weight: 700; font-size: 14px; cursor: pointer; flex-shrink: 0;
        }

        .rest-timer-bar {
            display: none; background: rgba(10, 132, 255, 0.2); border: 1px solid var(--accent-blue);
            border-radius: 12px; padding: 10px; text-align: center; font-weight: 700; font-size: 14px;
        }

        .history-list { display: flex; flex-direction: column; gap: 6px; max-height: 150px; overflow-y: auto; margin-top: 6px; }
        .history-item-compact {
            display: flex; justify-content: space-between; align-items: center;
            padding: 8px 10px; background: rgba(255, 255, 255, 0.03);
            border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.05); font-size: 13px;
        }

        /* Календарь */
        .calendar-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; text-align: center; }
        .day-name { font-size: 10px; color: var(--text-secondary); font-weight: 600; padding-bottom: 4px; }
        .day-cell {
            aspect-ratio: 1; border-radius: 8px; display: flex; flex-direction: column;
            align-items: center; justify-content: center; font-size: 11px; font-weight: 600;
            background: rgba(255, 255, 255, 0.03); border: 1px solid transparent; cursor: pointer;
        }
        .day-cell.empty { background: transparent; cursor: default; }
        .day-cell.has-data { background: rgba(48, 209, 88, 0.15); border-color: rgba(48, 209, 88, 0.4); color: var(--accent-green); }
        .day-cell.completed { background: rgba(48, 209, 88, 0.35); border-color: var(--accent-green); color: #fff; }
        .day-cell.today { border-color: var(--accent-blue); }

        .achievements-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
        .badge { background: rgba(255,255,255,0.04); border: 1px solid var(--glass-border); border-radius: 12px; padding: 10px; text-align: center; opacity: 0.4; }
        .badge.unlocked { opacity: 1; border-color: var(--accent-orange); background: rgba(255, 159, 10, 0.1); }

        .setting-card-item {
            display: flex; justify-content: space-between; align-items: center;
            padding: 12px 14px; background: rgba(255, 255, 255, 0.04);
            border: 1px solid var(--glass-border); border-radius: 14px; gap: 12px;
        }

        .tab-bar {
            position: fixed; bottom: 0; left: 0; right: 0;
            background: rgba(18, 18, 18, 0.9); backdrop-filter: blur(25px);
            border-top: 1px solid var(--glass-border); display: flex; justify-content: space-around;
            padding-top: 8px; padding-bottom: max(10px, env(safe-area-inset-bottom)); z-index: 1000;
        }
        .tab-btn { background: none; border: none; color: var(--text-secondary); font-size: 10px; display: flex; flex-direction: column; align-items: center; gap: 3px; cursor: pointer; }
        .tab-btn.active { color: var(--accent-blue); font-weight: 700; }
        .tab-content { display: none; }
        .tab-content.active { display: flex; flex-direction: column; gap: 14px; }
    </style>
</head>
<body>

    <!-- Вкладка 1: Главная -->
    <div id="tab-home" class="tab-content active">
        <div class="glass-card header">
            <div class="user-profile">
                <div class="avatar" id="userAvatar">U</div>
                <div>
                    <div class="title-sub" id="streakBadge">🔥 0 дней подряд</div>
                    <div class="title-main" id="userName">Спортсмен</div>
                </div>
            </div>
            <button class="btn-glass" style="padding:6px 12px; font-size:12px;" onclick="exportCSV()">📥 CSV</button>
        </div>

        <!-- Выбор типа упражнений -->
        <div class="exercise-selector">
            <div class="exercise-chip active" onclick="setExercise('pushups', this)">💪 Отжимания</div>
            <div class="exercise-chip" onclick="setExercise('squats', this)">🦵 Приседания</div>
            <div class="exercise-chip" onclick="setExercise('pullups', this)">🏋️ Подтягивания</div>
            <div class="exercise-chip" onclick="setExercise('plank', this)">⏱️ Планка (сек)</div>
        </div>

        <div class="glass-card">
            <div class="title-sub">Прогресс дня</div>
            <div class="main-stats">
                <div class="ring-container">
                    <svg class="ring-svg" viewBox="0 0 100 100">
                        <defs>
                            <linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stop-color="#30d158" />
                                <stop offset="100%" stop-color="#0a84ff" />
                            </linearGradient>
                        </defs>
                        <circle class="ring-bg" cx="50" cy="50" r="45"></circle>
                        <circle class="ring-progress" id="progressRing" cx="50" cy="50" r="45"></circle>
                    </svg>
                    <div class="ring-text">
                        <div class="ring-percent" id="percentText">0%</div>
                    </div>
                </div>

                <div style="flex:1; display:flex; flex-direction:column; gap:8px;">
                    <div>
                        <div class="stat-value" id="todayCount">0 <span style="font-size:13px; color:var(--text-secondary);">/ <span id="goalCount">100</span></span></div>
                        <div class="stat-desc">Выполнено сегодня</div>
                    </div>
                    <div>
                        <div class="stat-value" id="setsCount" style="color:var(--accent-blue);">0</div>
                        <div class="stat-desc">Всего подходов</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Таймер отдыха -->
        <div id="restTimer" class="rest-timer-bar">
            ⏱ Отдых: <span id="timerSeconds">60</span> сек
        </div>

        <!-- Быстрый набор -->
        <div>
            <div class="title-sub">Быстрый набор</div>
            <div class="presets-grid" id="presetsGrid"></div>

            <div class="custom-input-box">
                <div class="input-row">
                    <input type="number" id="customInput" class="input-glass" placeholder="Количество..." min="1">
                    <select id="rpeInput" class="input-glass" style="max-width:110px;">
                        <option value="0">RPE (1-10)</option>
                        <option value="6">6 - Легко</option>
                        <option value="8">8 - Норм</option>
                        <option value="10">10 - Макс</option>
                    </select>
                </div>
                <div class="input-row">
                    <input type="text" id="noteInput" class="input-glass" placeholder="Заметка...">
                    <button class="btn-add-action" onclick="addCustom()">Записать</button>
                </div>
            </div>
        </div>

        <!-- Сегодняшние подходы -->
        <div class="glass-card">
            <div class="title-sub">Сегодняшние подходы</div>
            <div class="history-list" id="historyList"></div>
        </div>

        <button class="btn-glass" style="width:100%; border-color:var(--accent-blue);" onclick="shareResultCard()">📸 Поделиться результатом</button>
    </div>

    <!-- Вкладка 2: Календарь на год (ВОССТАНОВЛЕНО) -->
    <div id="tab-calendar" class="tab-content">
        <div class="glass-card">
            <div class="calendar-header">
                <button class="btn-glass" style="padding:4px 12px; font-size:12px;" onclick="changeMonth(-1)">◀</button>
                <div style="text-align:center;">
                    <div class="title-main" id="calendarMonthYear" style="font-size:16px;">Месяц Год</div>
                </div>
                <button class="btn-glass" style="padding:4px 12px; font-size:12px;" onclick="changeMonth(1)">▶</button>
            </div>

            <div class="calendar-grid">
                <div class="day-name">Пн</div><div class="day-name">Вт</div><div class="day-name">Ср</div>
                <div class="day-name">Чт</div><div class="day-name">Пт</div><div class="day-name">Сб</div><div class="day-name">Вс</div>
            </div>
            <div class="calendar-grid" id="calendarGrid" style="margin-top:4px;"></div>
        </div>

        <div class="glass-card" id="dayDetailCard" style="display:none;">
            <div class="title-sub" id="selectedDateTitle">Информация за день</div>
            <div class="stat-value" id="selectedDateCount" style="color:var(--accent-green); margin-top:4px;">0 повторений</div>
            <div class="stat-desc" id="selectedDateSets">Подходов: 0</div>
        </div>
    </div>

    <!-- Вкладка 3: Прогресс, Лидерборд и Награды -->
    <div id="tab-progress" class="tab-content">
        <div class="glass-card">
            <div class="title-sub">🏆 Лидеры дня</div>
            <div id="leaderboardList" style="display:flex; flex-direction:column; gap:6px; margin-top:8px;"></div>
        </div>

        <div class="glass-card">
            <div class="title-sub">Активность за 7 дней</div>
            <div style="height: 150px; margin-top: 10px;"><canvas id="weeklyChart"></canvas></div>
        </div>

        <div class="glass-card">
            <div class="title-sub">Награды</div>
            <div class="achievements-grid">
                <div class="badge" id="badge_1000_rep_club">🏆<br><span style="font-size:10px;">1,000 Повторов</span></div>
                <div class="badge" id="badge_7_streak">🔥<br><span style="font-size:10px;">7 дней подряд</span></div>
                <div class="badge" id="badge_first_step">⭐<br><span style="font-size:10px;">Первый шаг</span></div>
            </div>
        </div>
    </div>

    <!-- Вкладка 4: Настройки (ВОССТАНОВЛЕНО С ДИАПАЗОНОМ ВРЕМЕНИ) -->
    <div id="tab-settings" class="tab-content">
        <div class="glass-card">
            <div class="title-sub" style="margin-bottom: 12px;">Параметры тренировок</div>
            
            <div style="display:flex; flex-direction:column; gap:10px;">
                <div class="setting-card-item">
                    <div>
                        <div style="font-weight:600; font-size:14px;">Дневная цель</div>
                        <div style="font-size:11px; color:var(--text-secondary);">Количество повторений</div>
                    </div>
                    <input type="number" id="settingGoal" class="input-glass" style="width:70px; text-align:center;" value="100">
                </div>

                <div class="setting-card-item">
                    <div>
                        <div style="font-weight:600; font-size:14px;">Напоминания в Telegram</div>
                        <div style="font-size:11px; color:var(--text-secondary);">Пуши от бота</div>
                    </div>
                    <input type="checkbox" id="settingReminders" checked style="width: 20px; height: 20px; accent-color: var(--accent-green);">
                </div>

                <div class="setting-card-item">
                    <div>
                        <div style="font-weight:600; font-size:14px;">Интервал уведомлений</div>
                    </div>
                    <select id="settingInterval" class="select-glass">
                        <option value="1">Каждый 1 час</option>
                        <option value="2">Каждые 2 часа</option>
                        <option value="3" selected>Каждые 3 часа</option>
                        <option value="4">Каждые 4 часа</option>
                    </select>
                </div>

                <!-- Диапазон времени работы пушей -->
                <div class="setting-card-item">
                    <div>
                        <div style="font-weight:600; font-size:14px;">Диапазон времени</div>
                        <div style="font-size:11px; color:var(--text-secondary);">Часы активности бота</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px;">
                        <select id="settingStartHour" class="select-glass"></select>
                        <span style="font-size:12px; color:var(--text-secondary);">—</span>
                        <select id="settingEndHour" class="select-glass"></select>
                    </div>
                </div>

                <div class="setting-card-item">
                    <div>
                        <div style="font-weight:600; font-size:14px;">Быстрый набор</div>
                        <div style="font-size:11px; color:var(--text-secondary);">Кнопки через запятую</div>
                    </div>
                    <input type="text" id="settingPresets" class="input-glass" style="width:110px; text-align:center;" value="15,20,25,30,35">
                </div>

                <button class="btn-add-action" style="margin-top:6px;" onclick="saveSettings()">Сохранить настройки</button>
            </div>
        </div>
    </div>

    <!-- Таббар -->
    <div class="tab-bar">
        <button class="tab-btn active" onclick="switchTab('home', this)">📊<span>Главная</span></button>
        <button class="tab-btn" onclick="switchTab('calendar', this)">📅<span>Календарь</span></button>
        <button class="tab-btn" onclick="switchTab('progress', this)">📈<span>Прогресс</span></button>
        <button class="tab-btn" onclick="switchTab('settings', this)">⚙️<span>Настройки</span></button>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.expand(); tg.ready();

        const user = tg.initDataUnsafe?.user;
        const userId = user ? user.id : 999999;
        let currentExercise = 'pushups';
        let userGoal = 100;
        let currentDate = new Date();
        let yearDataMap = {};
        let restTimerInterval;

        if (user) {
            document.getElementById('userName').innerText = user.first_name || 'Спортсмен';
            document.getElementById('userAvatar').innerText = (user.first_name || 'U')[0].toUpperCase();
        }

        function triggerHaptic(style = 'medium') {
            if (tg.HapticFeedback) tg.HapticFeedback.impactOccurred(style);
        }

        // Заполнение выпадающих списков часов (00:00 - 23:00)
        function initTimeSelects() {
            const startSelect = document.getElementById('settingStartHour');
            const endSelect = document.getElementById('settingEndHour');
            startSelect.innerHTML = ''; endSelect.innerHTML = '';

            for (let i = 0; i < 24; i++) {
                const hourStr = String(i).padStart(2, '0') + ':00';
                startSelect.innerHTML += \`<option value="\${i}">\${hourStr}</option>\`;
                endSelect.innerHTML += \`<option value="\${i}">\${hourStr}</option>\`;
            }
        }
        initTimeSelects();

        function switchTab(tabName, btn) {
            triggerHaptic('light');
            document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

            document.getElementById('tab-' + tabName).classList.add('active');
            btn.classList.add('active');

            if (tabName === 'calendar') loadYearCalendar();
            if (tabName === 'progress') { loadCharts(); loadLeaderboard(); }
        }

        function setExercise(type, el) {
            triggerHaptic('light');
            currentExercise = type;
            document.querySelectorAll('.exercise-chip').forEach(c => c.classList.remove('active'));
            el.classList.add('active');
            loadUserData();
        }

        async function apiFetch(url, options = {}) {
            try {
                const res = await fetch(url, options);
                return await res.json();
            } catch (e) {
                return { success: false };
            }
        }

        async function loadUserData() {
            const data = await apiFetch(\`/api/user-data?user_id=\${userId}&exercise_type=\${currentExercise}\`);
            if (data.success) {
                userGoal = data.settings.goal || 100;
                document.getElementById('goalCount').innerText = userGoal;
                document.getElementById('settingGoal').value = userGoal;
                document.getElementById('settingReminders').checked = data.settings.reminders_enabled;
                document.getElementById('settingInterval').value = data.settings.reminder_interval_hours || 3;
                document.getElementById('settingStartHour').value = data.settings.reminder_start_hour ?? 10;
                document.getElementById('settingEndHour').value = data.settings.reminder_end_hour ?? 23;
                document.getElementById('streakBadge').innerText = \`🔥 \${data.streak} дней подряд\`;

                const presets = data.settings.presets || [15, 20, 25, 30, 35];
                document.getElementById('settingPresets').value = presets.join(',');
                const presetsGrid = document.getElementById('presetsGrid');
                presetsGrid.innerHTML = '';
                presets.forEach(val => {
                    presetsGrid.innerHTML += \`<button class="btn-glass" onclick="addExercise(\${val})">+\${val}</button>\`;
                });

                let todayTotal = 0;
                const historyList = document.getElementById('historyList');
                historyList.innerHTML = '';
                document.getElementById('setsCount').innerText = data.todayHistory.length;

                if (data.todayHistory.length === 0) {
                    historyList.innerHTML = '<div style="text-align:center; color:var(--text-secondary); font-size:12px; padding:6px;">Подходов пока нет</div>';
                } else {
                    data.todayHistory.forEach(row => {
                        todayTotal += row.count;
                        const timeStr = new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        historyList.innerHTML += \`
                            <div class="history-item-compact">
                                <div>
                                    <span style="font-weight:700; color:var(--accent-green);">+\${row.count}</span>
                                    \${row.note ? \`<span style="color:var(--text-secondary); font-size:11px;"> (\${row.note})</span>\` : ''}
                                </div>
                                <div style="display:flex; align-items:center; gap:8px;">
                                    <span style="color:var(--text-secondary); font-size:11px;">\${timeStr}</span>
                                    <span style="color:var(--accent-red); cursor:pointer;" onclick="deleteSet(\${row.id})">🗑</span>
                                </div>
                            </div>\`;
                    });
                }

                document.getElementById('todayCount').innerHTML = \`\${todayTotal} <span style="font-size:13px; color:var(--text-secondary);">/ \${userGoal}</span>\`;
                const percent = Math.min(Math.round((todayTotal / userGoal) * 100), 100);
                document.getElementById('percentText').innerText = \`\${percent}%\`;
                document.getElementById('progressRing').style.strokeDashoffset = 283 - (percent / 100) * 283;

                (data.achievements || []).forEach(key => {
                    const el = document.getElementById('badge_' + key);
                    if (el) el.classList.add('unlocked');
                });
            }
        }

        async function addExercise(count) {
            triggerHaptic('medium');
            const note = document.getElementById('noteInput').value;
            const rpe = parseInt(document.getElementById('rpeInput').value) || 0;

            await apiFetch('/api/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId, count: count, exercise_type: currentExercise,
                    note: note, rpe: rpe, initData: tg.initData
                })
            });

            document.getElementById('customInput').value = '';
            document.getElementById('noteInput').value = '';
            startRestTimer(60);
            loadUserData();
        }

        function addCustom() {
            const val = parseInt(document.getElementById('customInput').value);
            if (val > 0) addExercise(val);
        }

        async function deleteSet(id) {
            triggerHaptic('heavy');
            await apiFetch('/api/delete-set/' + id, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId })
            });
            loadUserData();
        }

        function startRestTimer(seconds) {
            clearInterval(restTimerInterval);
            const timerEl = document.getElementById('restTimer');
            const secEl = document.getElementById('timerSeconds');
            timerEl.style.display = 'block';
            let left = seconds;
            secEl.innerText = left;

            restTimerInterval = setInterval(() => {
                left--;
                secEl.innerText = left;
                if (left <= 0) {
                    clearInterval(restTimerInterval);
                    timerEl.style.display = 'none';
                    triggerHaptic('heavy');
                }
            }, 1000);
        }

        // --- Календарь ---
        async function loadYearCalendar() {
            const year = currentDate.getFullYear();
            const data = await apiFetch(\`/api/calendar-year?user_id=\${userId}&year=\${year}&exercise_type=\${currentExercise}\`);
            if (data.success) {
                yearDataMap = data.calendarMap;
                renderCalendar();
            }
        }

        function changeMonth(delta) {
            currentDate.setMonth(currentDate.getMonth() + delta);
            renderCalendar();
        }

        function renderCalendar() {
            const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
            const year = currentDate.getFullYear();
            const month = currentDate.getMonth();

            document.getElementById('calendarMonthYear').innerText = \`\${monthNames[month]} \${year}\`;

            const firstDay = new Date(year, month, 1).getDay();
            const startingDay = firstDay === 0 ? 6 : firstDay - 1;
            const totalDays = new Date(year, month + 1, 0).getDate();

            const grid = document.getElementById('calendarGrid');
            grid.innerHTML = '';

            for (let i = 0; i < startingDay; i++) {
                grid.innerHTML += '<div class="day-cell empty"></div>';
            }

            const todayStr = new Date().toISOString().split('T')[0];

            for (let day = 1; day <= totalDays; day++) {
                const dayFormatted = String(day).padStart(2, '0');
                const monthFormatted = String(month + 1).padStart(2, '0');
                const dateKey = \`\${year}-\${monthFormatted}-\${dayFormatted}\`;

                const dayData = yearDataMap[dateKey];
                let classes = 'day-cell';
                if (dateKey === todayStr) classes += ' today';
                if (dayData) {
                    classes += dayData.total >= userGoal ? ' completed' : ' has-data';
                }

                grid.innerHTML += \`
                    <div class="\${classes}" onclick="selectCalendarDay('\${dateKey}', \${dayData ? dayData.total : 0}, \${dayData ? dayData.sets : 0})">
                        <span>\${day}</span>
                    </div>\`;
            }
        }

        function selectCalendarDay(dateStr, total, sets) {
            triggerHaptic('light');
            const card = document.getElementById('dayDetailCard');
            card.style.display = 'block';
            document.getElementById('selectedDateTitle').innerText = \`Дата: \${dateStr}\`;
            document.getElementById('selectedDateCount').innerText = \`\${total} повторений\`;
            document.getElementById('selectedDateSets').innerText = \`Выполнено подходов: \${sets}\`;
        }

        async function loadLeaderboard() {
            const data = await apiFetch(\`/api/leaderboard?exercise_type=\${currentExercise}\`);
            const list = document.getElementById('leaderboardList');
            list.innerHTML = '';
            if (data.success) {
                data.leaders.forEach((item, index) => {
                    list.innerHTML += \`
                        <div class="history-item-compact">
                            <span>#\${index + 1} Атлет ID: \${item.user_id}</span>
                            <span style="font-weight:700; color:var(--accent-blue);">\${item.total}</span>
                        </div>\`;
                });
            }
        }

        async function saveSettings() {
            triggerHaptic('medium');
            const goal = parseInt(document.getElementById('settingGoal').value);
            const reminders = document.getElementById('settingReminders').checked;
            const interval = parseInt(document.getElementById('settingInterval').value);
            const startHour = parseInt(document.getElementById('settingStartHour').value);
            const endHour = parseInt(document.getElementById('settingEndHour').value);
            const presets = document.getElementById('settingPresets').value.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));

            await apiFetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: userId, goal: goal, reminders_enabled: reminders,
                    reminder_interval_hours: interval, reminder_start_hour: startHour,
                    reminder_end_hour: endHour, presets: presets
                })
            });
            alert('Настройки успешно сохранены!');
            loadUserData();
        }

        function exportCSV() {
            window.location.href = \`/api/export-csv?user_id=\${userId}\`;
        }

        function shareResultCard() {
            const text = encodeURIComponent(\`💪 Мой результат сегодня: \${document.getElementById('todayCount').innerText} в трекере!\`);
            tg.openTelegramLink(\`https://t.me/share/url?url=\${process.env.WEBAPP_URL || 'https://sport-ya.onrender.com'}&text=\${text}\`);
        }

        async function loadCharts() {
            const data = await apiFetch(\`/api/stats-charts?user_id=\${userId}&exercise_type=\${currentExercise}\`);
            if (!data.success) return;

            new Chart(document.getElementById('weeklyChart'), {
                type: 'bar',
                data: {
                    labels: data.weekly.map(i => i.day_label),
                    datasets: [{ data: data.weekly.map(i => i.total), backgroundColor: '#30d158', borderRadius: 6 }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
            });
        }

        loadUserData();
    </script>
</body>
</html>
    `);
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
