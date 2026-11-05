# ResumeAI V2 — deployment steps

## 1. Replace the code on GitHub (GangaMahesh123/ResumeAI)
- Upload everything in this package to the repo root (GitHub → **Add file → Upload files**, drag the folder contents in, commit to `main`).
- **Delete `nixpacks.toml`** from the repo (it only installed Python; the new `Dockerfile` replaces it).
- Leave `scripts/` and the root `index.html` as they are.

## 2. Railway (backend) — project "loyal-empathy", service "ResumeAI"
1. **Variables** tab → add:
   - `ANTHROPIC_API_KEY` = your Anthropic key (required)
   - `JWT_SECRET` = any long random string (required)
   - Optional: `CLAUDE_MODEL` (default `claude-sonnet-5-5`)
2. **Settings → Volumes** → add a volume, mount path `/app/data`
   (keeps accounts, history and candidate confirmations across redeploys).
3. The GitHub push triggers a new build automatically. The first build takes longer (LibreOffice install).
4. Open `https://resumeai-production-7124.up.railway.app/health` and confirm:
   `"aiConfigured": true` and `"pageRenderer": true`.

## 3. Netlify (frontend)
- Netlify → your site → **Deploys** → drag the `frontend` folder onto the deploy area,
  **or** link the GitHub repo (it will use `netlify.toml` and publish `frontend/`).
- The backend URL is already set to `https://resumeai-production-7124.up.railway.app` at the top of the script in `frontend/index.html`.

## 4. First live test
1. Sign up again (old accounts were stored in memory and are gone).
2. Upload Mahesh's master DOCX, paste a JD, click **Generate**.
3. Expect 1–3 minutes per run (2–6 Claude calls plus page rendering).
4. Check the dashboard: page count, formatting pills, remaining gaps.
5. Use **Confirm experience** for skills Mahesh genuinely has (e.g. HL7 FHIR at Elevance, Semantic Kernel at San Bernardino), then run again.

## Cost and limits
- Each run: 1 analysis call + 1 rewrite call + up to 2 optimization and 2 layout calls.
- To reduce cost, set `OPTIMIZATION_MAX_PASSES=1` and `LAYOUT_MAX_PASSES=1`.
- Rate limit: 20 runs per hour (unchanged).
