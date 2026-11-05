# ResumeAI V2 — JD-specific resume tailoring

One universal engine for **.NET / Full Stack**, **Generative & Agentic AI**, **AI/ML / Data Science** and **hybrid** resumes. For every job description it rewrites the Professional Summary (18+ bullets), the two most recent projects (15+ bullets each), Technical Skills and Environment lines, keeps every older project byte-for-byte unchanged, verifies every claim against the candidate's real experience, renders the Word file to check the page count (target 6), and reports transparent scores.

## Pipeline

```
Upload → parse complete resume → parse full JD → requirement matrix (Critical/High/Medium/Low)
→ evidence per requirement (verified / confirmed / transferable / unsupported, re-checked in code)
→ AI rewrite (summary, recent 2 projects, skills, environments)
→ evidence guard (removes any technology the candidate can't show for that section)
→ optimization passes (bounded) → DOCX → LibreOffice render → page/format validation → scores
```

| Module | Purpose |
|---|---|
| `lib/xml.js` | WordprocessingML tokenizer (handles text split across runs, tabs, breaks, nested text boxes) |
| `lib/resumeModel.js` | Structured resume model: header, summary, skills, projects ordered by **dates** (no hard-coded client names) |
| `lib/domains.js` | .NET / GenAI / AI-ML technology libraries + domain detection (identify only, never add) |
| `lib/evidence.js` | Requirement re-verification, per-project evidence guard, version and years checks |
| `lib/scoring.js` | Explainable requirement-based scoring, 0–100, no floor/ceiling |
| `lib/prompts.js` | Analysis / rewrite / layout prompts with prompt-injection guard |
| `lib/schema.js` | Strict validation and safe repair of AI JSON |
| `lib/docxEngine.js` | Replaces only editable sections; Calibri 10, single spacing, 0/0 pt, no blank lines |
| `lib/render.js` | Headless LibreOffice DOCX→PDF page count; DOC→DOCX |
| `lib/docxBuild.js` | PDF/TXT → standard-template DOCX, then the same engine |
| `lib/tailor.js` | Orchestrates the whole workflow |
| `lib/store.js` | Users, history, candidate profiles, confirmations (JSON file in `DATA_DIR`) |
| `frontend/index.html` | Netlify UI: settings, dashboard, preview, requirement matrix, confirmations |

## Scoring

- **Keyword Coverage** = requirements found in the resume ÷ all requirements.
- **Qualification Match** = Σ(weight × support × visibility) ÷ Σweight.
  - Weights: Critical 5, High 3, Medium 2, Low 1.
  - Support: verified/confirmed 1, transferable 0.5, unsupported 0.
  - Visibility: summary or recent project 1, elsewhere 0.75, not shown 0.4.
- **Supported Alignment** = Qualification Match over verified/confirmed requirements only. This is the number the **98% target** applies to, because genuine gaps can't be optimized away.

## Deploy — Railway (backend)

1. Push this repo to GitHub. Railway detects the `Dockerfile` (it installs LibreOffice + Carlito for page counting).
2. Railway → service → **Variables**: set `ANTHROPIC_API_KEY` and `JWT_SECRET` (see `.env.example` for optional ones).
3. Railway → service → **Settings → Volumes**: add a volume mounted at `/app/data` so accounts and confirmations survive redeploys.
4. Deploy. Check `https://<your-railway-domain>/health` → `aiConfigured: true`, `pageRenderer: true`.

## Deploy — Netlify (frontend)

- Connect the repo (uses `netlify.toml`, publishes `frontend/`), **or** drag the `frontend` folder into Netlify's deploy page.
- The backend URL is set at the top of the script in `frontend/index.html` (`API = ...`). It can also be overridden with `?api=https://...` for testing.
- The V1 response fields are kept, so the old frontend keeps working against this backend too.

## API

| Method | Endpoint | Notes |
|---|---|---|
| POST | `/api/auth/register` · `/api/auth/login` | unchanged |
| GET | `/api/auth/me` | |
| POST | `/api/resume/optimize` | multipart: `resume`, `jobDescription`, optional `settings` (JSON), `candidateId`, `domainOverride` |
| GET | `/api/resume/history` | |
| GET | `/api/candidates` · `/api/candidates/:id` | candidate profiles (isolated per user) |
| POST | `/api/candidates/:id/confirmations` | `{ skill, projectId?, evidence }` — evidence required |
| DELETE | `/api/candidates/:id/confirmations/:confId` | |
| GET | `/api/settings/defaults` · `/health` | |

Errors always return `{ success:false, error, code, requestId }`. AI failures return 502/503 and are **never** reported as "already well matched".

## Local development & tests

```bash
npm install
cp .env.example .env   # add your key, then export the variables
npm start              # http://localhost:3001
npm test               # 19 acceptance tests (needs LibreOffice for the page-count tests)
```

Tests use a deterministic mock in place of Claude; parsing, evidence guards, scoring, DOCX editing, page rendering and the HTTP API are real.
