# AraSchool Backend

Express.js + PostgreSQL API server — Railway pe deploy karne ke liye ready.

## Local Development

1. Dependencies install karo:
```bash
npm install
```

2. `.env` file banao:
```bash
cp .env.example .env
# Phir .env mein DATABASE_URL set karo
```

3. Database setup karo:
```bash
npm run db:push
npm run db:seed
```

4. Dev server chalao:
```bash
npm run dev
```
Server `http://localhost:8080` pe chal jaega.

## Railway Deploy

1. Railway.app pe account banao
2. "New Project" → "Deploy from GitHub repo"
3. PostgreSQL plugin add karo (auto `DATABASE_URL` milega)
4. Environment variables set karo:
   - `SESSION_SECRET` — koi bhi random 32+ char string
   - `NODE_ENV` = `production`
5. Deploy! ✅

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Server port (Railway auto set karta hai) |
| `SESSION_SECRET` | Session encryption key |
| `NODE_ENV` | `production` ya `development` |
| `TWILIO_ACCOUNT_SID` | Twilio SID (SMS ke liye, optional) |
| `TWILIO_AUTH_TOKEN` | Twilio token (optional) |
| `TWILIO_FROM_NUMBER` | Twilio number (optional) |
