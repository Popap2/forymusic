const express = require('express');
const dns = require('dns');
const { Pool } = require('pg');
const path = require('path');

// Render и часть хостингов не маршрутизируют IPv6 к Supabase; иначе: connect ENETUNREACH
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== ПОДКЛЮЧЕНИЕ К PostgreSQL (внешняя БД, не пропадает на Render) ======
// В Render и локально нужно задать переменную окружения DATABASE_URL
// Например, строка подключения Supabase / Neon.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

// ====== КОНФИГ ВЛАДЕЛЬЦА / ЛЁГКАЯ ЗАЩИТА ======
const OWNER_EMAILS = ['zilajrik7@gmail.com', 'ilove@you.com']; // Владельцы с админ-правами
// Простой admin-пароль. На Render.com нужно задать переменную окружения ADMIN_PASSWORD.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev-admin-password';

function isOwner(email) {
  return OWNER_EMAILS.includes(email?.toLowerCase());
}

// ====== SUPABASE STORAGE (ДЛЯ MP3) ======
// Эти переменные нужны, чтобы mp3-файлы хранились в Supabase и не пропадали при перезапуске.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'music';

// чтобы читать JSON из fetch
app.use(express.json());

// Папка для временного хранения загруженных аудио-файлов (до отправки в Supabase)
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
    const unique = Date.now() + '_' + Math.random().toString(36).slice(2, 11);
    cb(null, unique + '_' + base + ext);
  },
});
const upload = multer({ storage });
const uploadTracksFields = upload.fields([
  { name: 'files', maxCount: 100 },
  { name: 'file', maxCount: 1 },
]);

/** Имя файла из multipart часто приходит как UTF-8, ошибочно прочитанный как Latin-1 (Ð¿ вместо п). */
function recoverFilenameUtf8(s) {
  if (!s || typeof s !== 'string') return s;
  if (/[\u0400-\u04FF]/.test(s)) return s;
  if (!/[ÐÑÂÃ]/.test(s)) return s;
  try {
    const recovered = Buffer.from(s, 'latin1').toString('utf8');
    if (/\uFFFD/.test(recovered)) return s;
    if (/[\u0400-\u04FF]/.test(recovered)) return recovered;
  } catch (e) {
    /* ignore */
  }
  return s;
}

function titleFromAudioOriginalName(originalname) {
  if (!originalname || typeof originalname !== 'string') return 'Без названия';
  const ext = path.extname(originalname);
  let base = path.basename(originalname, ext);
  try {
    base = decodeURIComponent(base);
  } catch (e) {
    /* ignore */
  }
  base = recoverFilenameUtf8(base);
  base = base.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base || 'Без названия';
}

// раздаём статику
app.use(express.static(__dirname));

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

  // миграция: добавляем колонки likes, playlists если их нет
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS likes JSONB DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS playlists JSONB DEFAULT '[]'::jsonb`);
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
    // Хешируем пароль перед сохранением
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);
    
    const result = await pool.query(
      'INSERT INTO users (email, password, likes, playlists) VALUES ($1,$2,$3::jsonb,$4::jsonb) RETURNING id, email, likes, playlists',
      [lowered, hashedPassword, JSON.stringify([]), JSON.stringify([])]
    );
    const user = result.rows[0];
    res.json({
      id: user.id,
      email: user.email,
      likes: user.likes || [],
      playlists: user.playlists || []
    });
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
    // Получаем пользователя по email (включая хеш пароля)
    const result = await pool.query(
      'SELECT id, email, password, likes, playlists FROM users WHERE email = $1',
      [lowered]
    );
    if (!result.rows[0]) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    const user = result.rows[0];
    
    // Сравниваем введённый пароль с хешем из базы
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    
    res.json({
      id: user.id,
      email: user.email,
      likes: user.likes || [],
      playlists: user.playlists || []
    });
  } catch (err) {
    console.error('DB error (POST /api/login):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// Получение данных пользователя по ID
app.get('/api/user/:id', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!userId) return res.status(400).json({ error: 'id обязателен' });

  try {
    const result = await pool.query(
      'SELECT id, email, likes, playlists FROM users WHERE id = $1',
      [userId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    const user = result.rows[0];
    res.json({
      id: user.id,
      email: user.email,
      likes: user.likes || [],
      playlists: user.playlists || []
    });
  } catch (err) {
    console.error('DB error (GET /api/user/:id):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// Обновление лайков пользователя
app.put('/api/user/:id/likes', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { likes } = req.body;
  if (!userId) return res.status(400).json({ error: 'id обязателен' });
  if (!Array.isArray(likes)) return res.status(400).json({ error: 'likes должен быть массивом' });

  try {
    await pool.query(
      'UPDATE users SET likes = $1::jsonb WHERE id = $2',
      [JSON.stringify(likes), userId]
    );
    res.json({ success: true, likes });
  } catch (err) {
    console.error('DB error (PUT /api/user/:id/likes):', err);
    res.status(500).json({ error: 'Ошибка БД: ' + err.message });
  }
});

// Обновление плейлистов пользователя
app.put('/api/user/:id/playlists', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { playlists } = req.body;
  if (!userId) return res.status(400).json({ error: 'id обязателен' });
  if (!Array.isArray(playlists)) return res.status(400).json({ error: 'playlists должен быть массивом' });

  try {
    await pool.query(
      'UPDATE users SET playlists = $1::jsonb WHERE id = $2',
      [JSON.stringify(playlists), userId]
    );
    res.json({ success: true, playlists });
  } catch (err) {
    console.error('DB error (PUT /api/user/:id/playlists):', err);
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

// Загрузка одного или нескольких файлов; название по умолчанию — из имени файла (без расширения)
app.post('/api/tracks/upload', uploadTracksFields, async (req, res) => {
  const fileList = [];
  if (req.files?.files) fileList.push(...req.files.files);
  if (req.files?.file) fileList.push(...req.files.file);

  const adminPassword = req.body.adminPassword;
  if (!adminPassword || adminPassword !== ADMIN_PASSWORD) {
    for (const f of fileList) {
      try {
        fs.unlinkSync(f.path);
      } catch (e) {}
    }
    return res.status(403).json({ error: 'Нет прав. Неверный admin-пароль.' });
  }

  if (!fileList.length) {
    return res.status(400).json({ error: 'Нужен хотя бы один audio-файл (поля files или file)' });
  }

  const artist = (req.body.artist || '').trim() || null;
  const singleTitleOverride = (req.body.title || '').trim();
  const added = [];
  const errors = [];

  for (const file of fileList) {
    const title =
      fileList.length === 1 && singleTitleOverride
        ? singleTitleOverride
        : titleFromAudioOriginalName(file.originalname);

    const localPath = file.path;
    const fileName = file.filename;
    let finalUrl = '/uploads/' + fileName;

    try {
      if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        try {
          const storagePath = SUPABASE_BUCKET + '/' + fileName;
          const uploadUrl = SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1/object/' + storagePath;

          const fileBuffer = fs.readFileSync(localPath);

          if (!SUPABASE_SERVICE_KEY.startsWith('sb_secret_') && !SUPABASE_SERVICE_KEY.startsWith('eyJ')) {
            console.error('SUPABASE_SERVICE_KEY format issue - should start with sb_secret_ or eyJ');
          }

          const resp = await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + SUPABASE_SERVICE_KEY.trim(),
              'Content-Type': file.mimetype || 'audio/mpeg',
              'x-upsert': 'true',
              apikey: SUPABASE_SERVICE_KEY.trim(),
            },
            body: fileBuffer,
          });

          if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            console.error('Supabase Storage upload error:', resp.status, text);
            throw new Error('Supabase Storage: ' + text);
          }

          finalUrl =
            SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1/object/public/' + storagePath;
        } finally {
          fs.unlink(localPath, () => {});
        }
      }

      const result = await pool.query(
        'INSERT INTO tracks (title, artist, url) VALUES ($1,$2,$3) RETURNING id',
        [title, artist, finalUrl]
      );
      added.push({
        id: result.rows[0].id,
        title,
        artist,
        url: finalUrl,
      });
    } catch (err) {
      console.error('POST /api/tracks/upload file error:', file.originalname, err);
      errors.push({ file: file.originalname, error: err.message });
      try {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      } catch (e) {}
    }
  }

  if (!added.length) {
    const msg = errors[0]?.error || 'Не удалось загрузить файлы';
    return res.status(500).json({ error: msg, errors, tracks: [] });
  }

  res.json({ tracks: added, errors });
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