const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== ПОДКЛЮЧЕНИЕ К PostgreSQL (внешняя БД, не пропадает на Render) ======
// В Render и локально нужно задать переменную окружения DATABASE_URL
// Например, строка подключения Supabase / Neon / Railway.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

// ====== КОНФИГ ВЛАДЕЛЬЦА / ЛЁГКАЯ ЗАЩИТА ======
// Email владельца, которому разрешено управлять треками
const OWNER_EMAIL = 'zilajrik7@gmail.com';
// Простой admin-пароль. На Render.com нужно задать переменную окружения ADMIN_PASSWORD.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev-admin-password';

// чтобы читать JSON из fetch
app.use(express.json());

// Папка для загруженных аудио-файлов
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Настройка Multer для загрузки файлов
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.mp3';
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-]/g, '_');
    cb(null, Date.now() + '_' + base + ext);
  },
});
const upload = multer({ storage });

// раздаём статику и загруженные треки
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

// ====== ИНИЦИАЛИЗАЦИЯ БД (PostgreSQL) ======
async function initDb() {
  // таблица пользователей
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  // таблица треков
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT,
      url TEXT NOT NULL
    )
  `);

  // если таблица tracks пуста — засеем демо‑треки (которые раньше были в HTML)
  const cntResult = await pool.query('SELECT COUNT(*) AS cnt FROM tracks');
  const cnt = parseInt(cntResult.rows[0].cnt, 10) || 0;
  if (cnt === 0) {
    console.log('Seeding demo tracks into Postgres...');
    const demoTracks = [
      { title: 'Lofi Morning', artist: 'Beat Studio', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
      { title: 'City Night Drive', artist: 'Neon Waves', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' },
      { title: 'Study Rain', artist: 'Calm Rooms', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3' },
      { title: 'Soft Piano', artist: 'Silent Keys', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3' },
    ];
    for (const t of demoTracks) {
      await pool.query(
        'INSERT INTO tracks (title, artist, url) VALUES ($1,$2,$3)',
        [t.title, t.artist, t.url]
      );
    }
  }
}

initDb().catch((err) => {
  console.error('DB init error:', err);
});

// ====== ВСПОМОГАТЕЛЬНАЯ ПРОВЕРКА ВЛАДЕЛЬЦА ======
function requireOwner(req, res, next) {
  const adminPassword = req.body.adminPassword || (req.headers['x-admin-password'] || '');
  if (!adminPassword || adminPassword !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Нет прав. Неверный admin-пароль.' });
  }
  next();
}

// ====== API АККАУНТЫ (PostgreSQL) ======
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email и пароль обязательны' });

  try {
    const lowered = email.toLowerCase();
    const result = await pool.query(
      'INSERT INTO users (email, password) VALUES ($1,$2) RETURNING id',
      [lowered, password]
    );
    res.json({ id: result.rows[0].id, email: lowered });
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation
      return res.status(409).json({ error: 'Пользователь уже существует' });
    }
    console.error('DB error (POST /api/register):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const lowered = email.toLowerCase();
    const result = await pool.query(
      'SELECT id, email FROM users WHERE email = $1 AND password = $2',
      [lowered, password]
    );
    if (!result.rows[0]) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    res.json(result.rows[0]); // {id, email}
  } catch (err) {
    console.error('DB error (POST /api/login):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// ====== API ТРЕКИ (PostgreSQL) ======

// Получение всех треков из БД
app.get('/api/tracks', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, title, artist, url FROM tracks ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('DB error (GET /api/tracks):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// Добавление трека по готовому URL (например, внешний ресурс) — только владелец
app.post('/api/tracks', requireOwner, async (req, res) => {
  const { title, artist, url } = req.body;
  if (!title || !url) return res.status(400).json({ error: 'title и url обязательны' });

  try {
    const result = await pool.query(
      'INSERT INTO tracks (title, artist, url) VALUES ($1,$2,$3) RETURNING id',
      [title, artist || null, url]
    );
    res.json({ id: result.rows[0].id, title, artist, url });
  } catch (err) {
    console.error('DB error (POST /api/tracks):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// Загрузка файла трека и сохранение в БД — только владелец
app.post('/api/tracks/upload', upload.single('file'), async (req, res) => {
  const adminPassword = req.body.adminPassword;
  if (!adminPassword || adminPassword !== ADMIN_PASSWORD) {
    // если файл уже был сохранён, удалим его при ошибке прав
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }
    return res.status(403).json({ error: 'Нет прав. Неверный admin-пароль.' });
  }

  const title = (req.body.title || '').trim();
  const artist = (req.body.artist || '').trim();

  if (!title) {
    return res.status(400).json({ error: 'title обязателен' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Нужен audio-файл (поле file)' });
  }

  const relativeUrl = '/uploads/' + req.file.filename;

  try {
    const result = await pool.query(
      'INSERT INTO tracks (title, artist, url) VALUES ($1,$2,$3) RETURNING id',
      [title, artist || null, relativeUrl]
    );
    res.json({ id: result.rows[0].id, title, artist, url: relativeUrl });
  } catch (err) {
    console.error('DB error (POST /api/tracks/upload):', err);
    return res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// Обновление метаданных трека — только владелец
app.put('/api/tracks/:id', requireOwner, async (req, res) => {
  const trackId = parseInt(req.params.id, 10);
  const { title, artist } = req.body;

  if (!trackId || !title) {
    return res.status(400).json({ error: 'id и title обязательны' });
  }

  try {
    const result = await pool.query(
      'UPDATE tracks SET title = $1, artist = $2 WHERE id = $3',
      [title, artist || null, trackId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Трек не найден' });
    }
    res.json({ id: trackId, title, artist });
  } catch (err) {
    console.error('DB error (PUT /api/tracks/:id):', err);
    return res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// Удаление трека — только владелец
app.delete('/api/tracks/:id', requireOwner, async (req, res) => {
  const trackId = parseInt(req.params.id, 10);
  if (!trackId) return res.status(400).json({ error: 'id обязателен' });

  try {
    // сначала получаем трек, чтобы при необходимости удалить файл
    const select = await pool.query('SELECT url FROM tracks WHERE id = $1', [trackId]);
    const row = select.rows[0];
    if (!row) return res.status(404).json({ error: 'Трек не найден' });

    const del = await pool.query('DELETE FROM tracks WHERE id = $1', [trackId]);
    if (del.rowCount === 0) {
      return res.status(404).json({ error: 'Трек не найден' });
    }

    if (row.url && row.url.indexOf('/uploads/') === 0) {
      const filePath = path.join(__dirname, row.url.replace('/uploads/', 'uploads/'));
      fs.unlink(filePath, () => {});
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DB error (DELETE /api/tracks/:id):', err);
    return res.status(500).json({ error: 'Ошибка БД при удалении: ' + err.message });
  }
});

// главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'Музыка 3.html'));
});

app.listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
});