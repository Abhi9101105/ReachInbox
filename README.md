# ReachInbox — Full-Stack Email Scheduling & Delivery Platform

A high-throughput, fault-tolerant email scheduling platform built with **TypeScript**, **Node.js/Express**, **PostgreSQL**, **Redis**, **BullMQ**, **Elasticsearch 8**, **Google OAuth 2.0**, **Slack OAuth v2**, and a modern **React + Vite** frontend dashboard.

---

## 🚀 Key Features

- **Google OAuth 2.0 Authentication:** Secure cookie-based sessions with HTTP-only tokens, CSRF protection, and user profile management.
- **Precision Email Scheduling:** Millisecond-accurate delayed scheduling backed by BullMQ and Redis with PostgreSQL state persistence.
- **Hourly Rate Limiting & Pacing:** Sliding-window rate limiter (100 emails/hour by default) using atomic Redis Lua scripts and per-sender delay pacing (`MIN_SEND_DELAY_MS`).
- **Slack Alerting on Rate Limits:** Real-time Slack notifications dispatched to connected workspaces on rate-limit exhaustion, with atomic multi-worker deduplication (`SET NX`).
- **Elasticsearch 8 Search:** Full-text instant search across Subject, Body, and Recipient fields with decoupled async indexing and database re-indexing support.
- **Bull Board Queue Monitoring:** Real-time visual dashboard mounted at `/admin/queues` displaying active, waiting, delayed, and completed jobs.
- **Modern React + Vite Frontend:** Dark-themed responsive interface featuring live campaign metrics, interactive rate limit progress bar, batch CSV/TXT recipient parsing, and direct Ethereal email preview links.

---

## 🏗️ Architecture Overview

```
Frontend (React + Vite, localhost:5173)
   │
   ├── [Google Login] ──→ Google OAuth ──→ Sets reachinbox_session HTTP-only Cookie
   ├── [Dashboard / Overview] ──→ Real-time stats, rate limit meter, queue counters
   ├── [Scheduled / Sent Emails] ──→ Filtered lists, Elasticsearch search, Ethereal preview URLs
   ├── [Compose Campaign] ──→ Single / Batch scheduling with CSV recipient parser
   └── [Slack Settings] ──→ Connect / Disconnect workspace with live status
           │
           ▼
Backend (Express + TypeScript, localhost:4000)
   │
   ├── PostgreSQL (Source of Truth)
   │     ├── Users & Sessions
   │     ├── Slack Connections
   │     └── Emails (SCHEDULED → PROCESSING → SENT / FAILED)
   │
   ├── Redis (Queue & Cache)
   │     ├── BullMQ Job Queue (Immediate & Delayed)
   │     ├── Sliding Window Rate Limiter (Atomic Lua Script)
   │     ├── Worker Pacing Locks
   │     └── Slack Alert Deduplication Keys (slack:rate-limit-notified:*)
   │
   ├── Elasticsearch 8 (Search Engine)
   │     └── Document Indexing (q=, full-text, multi-field filters)
   │
   ├── BullMQ Worker Pool (Concurrency = 5)
   │     ├── Nodemailer Transporter (Ethereal SMTP)
   │     └── Rate Limit Deferral & Slack Dispatch
   │
   └── Bull Board (/admin/queues)
```

---

## 🛠️ Technology Stack

| Layer | Technologies |
| :--- | :--- |
| **Frontend** | React 18, TypeScript, Vite, React Router 6, React Hot Toast, Lucide Icons, Vanilla CSS Design System |
| **Backend** | Node.js 20, TypeScript, Express.js 4, Prisma ORM 5 |
| **Database** | PostgreSQL 16 (Docker) |
| **Queue & Cache** | Redis 7 (Docker), BullMQ 5, `@bull-board/express` |
| **Search Engine** | Elasticsearch 8.17 (Docker), `@elastic/elasticsearch` |
| **Email Transporter**| Nodemailer 10 (Ethereal SMTP for testing) |
| **Authentication** | Google Auth Library (OAuth 2.0), Slack Web API (OAuth v2) |

---

## 📁 Repository Structure

```
ReachInbox/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma              # User, SlackConnection, and Email data models
│   │   └── migrations/                # Database migration history
│   ├── src/
│   │   ├── config/                    # Typed environment, Prisma, and Redis singletons
│   │   ├── controllers/               # Auth, Slack, Email, and Test controllers
│   │   ├── middleware/                # Session auth, optional auth, and error handling
│   │   ├── queues/                    # BullMQ Queue and Worker definitions
│   │   ├── routes/                    # API route definitions
│   │   ├── scripts/                   # Automated test suites (Phases 3–7)
│   │   ├── services/                  # Business logic (OAuth, Slack, Rate Limiter, ES, SMTP)
│   │   ├── types/                     # TypeScript types and interfaces
│   │   ├── app.ts                     # Express setup with CORS and Bull Board
│   │   └── server.ts                  # Server lifecycle and graceful shutdown
│   ├── .env.example                   # Backend environment template
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── src/
│   │   ├── components/                # Sidebar, EmailTable, and shared components
│   │   ├── pages/                     # LoginPage, OverviewPage, ScheduledPage, SentPage, ComposePage, SlackPage
│   │   ├── api.ts                     # Centralized typed API client
│   │   ├── AuthContext.tsx            # Session and user state provider
│   │   ├── App.tsx                    # Route definitions and toast configuration
│   │   └── index.css                  # Custom design system with modern dark theme
│   ├── .env.example                   # Frontend environment template
│   ├── package.json
│   └── vite.config.ts                 # Dev server proxy configuration
├── docker-compose.yml                 # PostgreSQL, Redis, and Elasticsearch containers
├── .gitignore                         # Comprehensive ignore rules
└── README.md
```

---

## 🚦 Getting Started

### 1. Prerequisites

- **Node.js:** v18 or higher (`node -v`)
- **npm:** v9 or higher (`npm -v`)
- **Docker & Docker Compose:** (`docker compose version`)

### 2. Start Infrastructure Services

```bash
docker compose up -d
```

Verify that PostgreSQL, Redis, and Elasticsearch are running:

```bash
docker compose ps
```

### 3. Setup and Run Backend

```bash
cd backend
cp .env.example .env
npm install
npx prisma migrate dev
npm run dev
```

The backend server will start on `http://localhost:4000`.

### 4. Setup and Run Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

The frontend application will start on `http://localhost:5173`.

---

## ⚙️ Environment Configuration

### Backend (`backend/.env`)

```ini
# Server
PORT=4000
NODE_ENV=development
FRONTEND_URL=http://localhost:5173

# Database & Redis
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/reachinbox?schema=public"
REDIS_URL="redis://localhost:6379"

# Worker & Rate Limiting
WORKER_CONCURRENCY=5
EMAIL_HOURLY_LIMIT=100
MIN_SEND_DELAY_MS=1000
RATE_LIMIT_WINDOW_SECONDS=3600

# Ethereal SMTP
ETHEREAL_HOST=smtp.ethereal.email
ETHEREAL_PORT=587
ETHEREAL_USER=your_ethereal_user
ETHEREAL_PASSWORD=your_ethereal_password
EMAIL_FROM="ReachInbox Scheduler <no-reply@reachinbox.ai>"

# Elasticsearch
ELASTICSEARCH_URL=http://localhost:9200
ELASTICSEARCH_INDEX=emails

# Google OAuth
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_CALLBACK_URL=http://localhost:4000/api/auth/google/callback

# Slack OAuth
SLACK_CLIENT_ID=your_slack_client_id
SLACK_CLIENT_SECRET=your_slack_client_secret
SLACK_REDIRECT_URI=http://localhost:4000/api/slack/oauth/callback
```

### Frontend (`frontend/.env`)

```ini
# Optional: Set VITE_API_URL if the backend is hosted on a separate domain in production
# VITE_API_URL=https://api.yourdomain.com/api
```

---

## 📊 Bull Board Queue Monitor

ReachInbox includes the **Bull Board** monitoring dashboard for inspecting queue health, delayed jobs, active workers, and failure logs:

- **URL:** `http://localhost:4000/admin/queues` (or accessible via the frontend sidebar link)

---

## 🧪 Automated Verification Test Suites

To verify all system capabilities and regression suites:

```bash
cd backend

# Phase 3: Ethereal SMTP & Email Scheduling
npx tsx src/scripts/test-suite-phase3.ts

# Phase 4: Sliding-Window Rate Limiting, Pacing & Concurrency
npx tsx src/scripts/test-suite-phase4.ts

# Phase 5: Elasticsearch 8 Indexing, Decoupling & Search
npx tsx src/scripts/test-suite-phase5.ts

# Phase 6: Google OAuth 2.0 & Redis Session Storage
npx tsx src/scripts/test-suite-phase6.ts

# Phase 7: Slack OAuth v2 & Rate-Limit Deduplication Alerting
npx tsx src/scripts/test-suite-phase7.ts
```

---

## 🔒 Security & Production Guidelines

- **Session Security:** Cookies use `httpOnly: true`, `sameSite: 'lax'`, and automatically enable `secure: true` in production (`NODE_ENV=production`).
- **No Secret Exposure:** OAuth access tokens and client secrets are stored exclusively on the server and are never returned to client endpoints.
- **Elasticsearch Decoupling:** In the event of an Elasticsearch outage, email scheduling and delivery remain fully operational; the search index can be rebuilt on-demand via `POST /api/test/search/reindex`.
- **Graceful Shutdown:** The server cleanly intercepts `SIGINT` and `SIGTERM` signals to allow active email transmissions to complete before closing connections.
