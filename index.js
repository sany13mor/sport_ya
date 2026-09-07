require('dotenv').config();
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS pushups (
                id SERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                count INT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );

            ALTER TABLE pushups ADD COLUMN IF NOT EXISTS exercise_type VARCHAR(50) DEFAULT 'pushups';
            ALTER TABLE pushups ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';
            ALTER TABLE pushups ADD COLUMN IF NOT EXISTS rpe INT DEFAULT 0;

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
        console.log('✅ Структура БД обновлена и данные успешно восстановлены.');
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err);
    }
}

// Запуск инициализации структуры таблицы
initDB();

// Команда /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
        await pool.query(
            `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
            [userId]
        );
        bot.sendMessage(chatId, 'Привет! Бот готов к учету упражнений.\n\nОтправь количество повторений (число) или используй /stats для вывода истории.');
    } catch (err) {
        console.error('Ошибка при старте:', err);
        bot.sendMessage(chatId, 'Произошла ошибка при регистрации пользователя.');
    }
});

// Запись подхода по отправленному числу
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const count = parseInt(msg.text.trim(), 10);

    if (isNaN(count)) return;

    try {
        await pool.query(
            `INSERT INTO pushups (user_id, count, exercise_type, note, rpe) VALUES ($1, $2, $3, $4, $5)`,
            [userId, count, 'pushups', '', 0]
        );
        bot.sendMessage(chatId, `Засчитано: *${count}* повторений! 💪`, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Ошибка записи подходов:', err);
        bot.sendMessage(chatId, 'Не удалось сохранить запись в базу данных.');
    }
});

// Команда /stats для чтения последних 10 записей с новыми колонками
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
        const res = await pool.query(
            `SELECT created_at, exercise_type, count, note, rpe 
             FROM pushups 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT 10`,
            [userId]
        );

        if (res.rows.length === 0) {
            return bot.sendMessage(chatId, 'У вас пока нет сохраненных подходов.');
        }

        let responseText = '📊 *Последние подходы:*\n\n';
        res.rows.forEach((row) => {
            const date = new Date(row.created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
            const noteText = row.note ? ` (${row.note})` : '';
            responseText += `• ${date} | *${row.exercise_type}*: ${row.count} повторений${noteText}\n`;
        });

        bot.sendMessage(chatId, responseText, { parse_mode: 'Markdown' });
    } catch (err) {
        console.error('Ошибка запроса статистики:', err);
        bot.sendMessage(chatId, 'Не удалось получить статистику.');
    }
});
