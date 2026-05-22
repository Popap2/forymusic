# WWmusic

Современный веб-плеер для прослушивания музыки с возможностью управления треками через базу данных.

## Возможности

- 🎵 Воспроизведение аудио-треков
- 👤 Регистрация и авторизация пользователей
- ❤️ Система лайков и плейлистов
- 🎨 Современный интерфейс в стиле Яндекс.Музыки
- 🔐 Управление треками для владельцев (добавление, редактирование, удаление)
- 💾 Хранение данных в PostgreSQL (Supabase)
- 📁 Загрузка аудио-файлов в Supabase Storage
- 🔒 Хеширование паролей через bcrypt

## Технологии

- **Backend**: Node.js, Express
- **База данных**: PostgreSQL (через Supabase)
- **Хранилище файлов**: Supabase Storage
- **Frontend**: Vanilla JavaScript, HTML5, CSS3

### Настройка Supabase

1. Создайте проект на [supabase.com](https://supabase.com)

2. Получите строку подключения к базе данных:
   - Перейдите в **Project Settings → Database**
   - Скопируйте **Connection string** (URI) из раздела **Connection pooling** (Session Pooler)
   - Используйте эту строку для `DATABASE_URL`

3. Получите Service Role ключ:
   - Перейдите в **Project Settings → API**
   - Скопируйте **service_role key** из раздела **Secret keys**
   - Используйте его для `SUPABASE_SERVICE_KEY`

4. Создайте bucket для хранения файлов:
   - Перейдите в **Storage**
   - Создайте новый bucket (например, `music`)
   - Сделайте его **публичным** (Public bucket)
   - Укажите имя bucket в `SUPABASE_BUCKET`

## Деплой на Render.com

1. Загрузите код в GitHub репозиторий

2. Создайте новый Web Service на [render.com](https://render.com):
   - Подключите ваш GitHub репозиторий
   - Выберите **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

3. Добавьте переменные окружения в настройках сервиса:
   - `DATABASE_URL` - строка подключения к Supabase (из Connection pooling)
   - `ADMIN_PASSWORD` - секретный пароль для управления треками
   - `SUPABASE_URL` - URL вашего проекта Supabase (например, `https://xxxx.supabase.co`)
   - `SUPABASE_SERVICE_KEY` - service_role ключ из Supabase
   - `SUPABASE_BUCKET` - имя публичного bucket в Storage

4. Нажмите **Deploy** и дождитесь завершения деплоя

## Структура проекта

```
.
├── server.js          # Backend сервер (Express, API endpoints)
├── Музыка 3.html      # Frontend (HTML, CSS, JavaScript)
├── package.json       # Зависимости проекта
└── README.md         # Документация
```

## API Endpoints

### Пользователи
- `POST /api/register` - Регистрация нового пользователя
- `POST /api/login` - Вход в систему
- `GET /api/user/:id` - Получить данные пользователя
- `PUT /api/user/:id/likes` - Обновить лайки пользователя
- `PUT /api/user/:id/playlists` - Обновить плейлисты пользователя

### Треки
- `GET /api/tracks` - Получить все треки
- `POST /api/tracks` - Добавить трек по URL (требует admin-пароль)
- `POST /api/tracks/upload` - Загрузить аудио-файл (требует admin-пароль)
- `PUT /api/tracks/:id` - Обновить трек (требует admin-пароль)
- `DELETE /api/tracks/:id` - Удалить трек (требует admin-пароль)

## Владельцы

По умолчанию админ-права имеют пользователи с email:
- `zilajrik7@gmail.com`

Владельцы могут:
- Добавлять новые треки
- Редактировать существующие треки
- Удалять треки
- Использовать панель управления треками

Для всех операций с треками требуется `adminPassword` (значение из переменной окружения `ADMIN_PASSWORD`).

## Безопасность

- Пароли пользователей хешируются через `bcrypt` перед сохранением в базу данных
- Админ-операции защищены паролем (переменная окружения `ADMIN_PASSWORD`)
- Доступ к Supabase Storage через service_role ключ (хранится только на сервере)

## Лицензия

ISC

