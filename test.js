const { createClient } = require('@supabase/supabase-js');

// Замените на ваши реальные ключи, если они не подтягиваются автоматически
const SUPABASE_URL = process.env.SUPABASE_URL || 'ВАШ_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'ВАШ_SUPABASE_KEY';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function testConnection() {
    console.log('🔄 Проверяем соединение с Supabase...');
    
    try {
        const { data, error } = await supabase.from('pushups').select('*').limit(1);
        
        if (error) {
            console.error('❌ Ошибка от базы данных:', error.message);
        } else {
            console.log('✅ Подключение успешно! База отвечает, данные:', data);
        }
    } catch (err) {
        console.error('❌ Критическая ошибка (возможно, неверный URL):', err.message);
    }
}

testConnection();
