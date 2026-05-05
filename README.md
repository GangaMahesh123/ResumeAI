# ResumeAI — Resume Optimizer

AI-powered resume optimizer that adds missing keywords from job descriptions to achieve 92–95% ATS match — without removing any existing content.

---

## Architecture

```
Frontend (React/HTML artifact in Claude.ai)
        ↕  REST API (JWT auth)
Backend (Node.js + Express)
        ↕  Claude claude-sonnet-4-20250514
        ↕  File parsing (PDF, DOCX, TXT)
```

---

## Backend Setup

### 1. Install dependencies
```bash
cd resume-optimizer-backend
npm install
```

### 2. Environment variables
Create a `.env` file:
```
ANTHROPIC_API_KEY=sk-ant-...
JWT_SECRET=your-random-secret-string-here
PORT=3001
FRONTEND_URL=http://localhost:3000
```

### 3. Run
```bash
npm run dev       # development with hot reload
npm start         # production
```

---

## API Reference

### Auth

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | `{ name, email, password }` | Create account |
| POST | `/api/auth/login` | `{ email, password }` | Login → returns JWT token |
| POST | `/api/auth/logout` | — | Audit log logout |
| GET | `/api/auth/me` | — | Get current user (requires Bearer token) |

### Resume

All resume endpoints require `Authorization: Bearer <token>` header.

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/resume/optimize` | `multipart/form-data: resume (file) + jobDescription (text)` | Optimize resume |
| GET | `/api/resume/history` | — | List past optimizations |
| GET | `/api/resume/history/:id` | — | Get full resume for a history entry |

### Optimize Response
```json
{
  "success": true,
  "historyId": "opt_1234567890",
  "optimizedResume": "Full optimized resume text...",
  "matchScore": 93,
  "changes": [
    { "type": "added", "section": "Skills", "description": "Added React.js, TypeScript to match JD requirements" },
    { "type": "modified", "section": "Experience", "description": "Enhanced bullet point to include 'cross-functional' keyword" }
  ],
  "keywordsAdded": 12,
  "bulletsEnhanced": 5,
  "sectionsImproved": 3,
  "keywordsCovered": ["Python", "REST API", "Agile"],
  "keywordsStillMissing": []
}
```

---

## Frontend Integration

The Claude.ai artifact frontend calls the Anthropic API directly. To wire it to this backend instead:

1. Replace the `fetch('https://api.anthropic.com/v1/messages', ...)` call in the frontend with:
```javascript
const response = await fetch('http://localhost:3001/api/resume/optimize', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: formData   // FormData with 'resume' file + 'jobDescription' text
});
```

2. Store the JWT token from login in `localStorage` and attach it to all protected requests.

---

## Production Checklist

- [ ] Replace in-memory `db` with PostgreSQL or MongoDB
- [ ] Add `helmet` middleware for security headers
- [ ] Set a real `JWT_SECRET` in environment
- [ ] Enable HTTPS (use nginx reverse proxy or deploy to Railway/Render)
- [ ] Add input sanitization with `validator` or `zod`
- [ ] Set up proper logging (Winston or Pino)
- [ ] Store uploaded files in S3 if you want to persist them

---

## Supported File Types

| Format | Library Used |
|--------|-------------|
| `.txt` | Native Node.js Buffer |
| `.pdf` | `pdf-parse` |
| `.docx` | `mammoth` |
| `.doc` | `mammoth` |

Max upload size: **5MB**
