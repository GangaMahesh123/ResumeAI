'use strict';
// Small JSON-file store. Persists users, history, candidate profiles and
// candidate experience confirmations. On Railway, mount a volume at DATA_DIR
// so data survives redeploys (otherwise it lasts until the next deploy,
// which is still better than the old in-memory store that lost it on every restart).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

class Store {
  constructor(dir = config.dataDir) {
    this.dir = dir;
    this.file = path.join(dir, 'store.json');
    this.data = { users: {}, history: {}, candidates: {} };
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
        this.data = { users: {}, history: {}, candidates: {}, ...parsed };
      }
    } catch (e) {
      console.error('[store] could not load data file, starting empty:', e.message);
    }
  }

  _save() {
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] save failed:', e.message);
    }
  }

  // ── users ───────────────────────────────────────────────────────────
  getUser(email) { return this.data.users[String(email).toLowerCase()] || null; }
  addUser(user) { this.data.users[user.email] = user; this.data.history[user.id] = []; this._save(); }

  // ── history ─────────────────────────────────────────────────────────
  addHistory(userId, entry) {
    const list = this.data.history[userId] || (this.data.history[userId] = []);
    list.unshift(entry);
    if (list.length > 50) list.length = 50;
    this._save();
  }
  getHistory(userId) { return this.data.history[userId] || []; }

  // ── candidates (isolated per user + candidate) ─────────────────────
  _candidates(userId) { return this.data.candidates[userId] || (this.data.candidates[userId] = {}); }

  listCandidates(userId) {
    return Object.values(this._candidates(userId)).map(c => ({
      id: c.id, name: c.name, updatedAt: c.updatedAt, projects: c.projects,
      confirmationCount: (c.confirmations || []).length,
    }));
  }

  getCandidate(userId, candidateId) { return this._candidates(userId)[candidateId] || null; }

  upsertCandidate(userId, { id, name, projects, masterText, domain }) {
    const all = this._candidates(userId);
    const existing = all[id];
    const now = new Date().toISOString();
    all[id] = {
      id, name,
      projects: projects || (existing && existing.projects) || [],
      masterTextHash: crypto.createHash('sha256').update(masterText || '').digest('hex').slice(0, 16),
      domain: domain || (existing && existing.domain) || null,
      confirmations: (existing && existing.confirmations) || [],
      createdAt: (existing && existing.createdAt) || now,
      updatedAt: now,
    };
    this._save();
    return all[id];
  }

  addConfirmation(userId, candidateId, { skill, projectId, evidence }) {
    const c = this.getCandidate(userId, candidateId);
    if (!c) throw Object.assign(new Error('Candidate not found'), { status: 404 });
    const project = projectId ? (c.projects || []).find(p => p.id === projectId) : null;
    if (projectId && !project) throw Object.assign(new Error('Project not found for this candidate'), { status: 400 });
    const conf = {
      id: `cf_${crypto.randomBytes(6).toString('hex')}`,
      skill: String(skill).trim(),
      projectId: project ? project.id : null,
      client: project ? project.client : null,
      evidence: String(evidence).trim(),
      createdAt: new Date().toISOString(),
    };
    // Replace an older confirmation of the same skill + project.
    c.confirmations = (c.confirmations || []).filter(x => !(x.skill.toLowerCase() === conf.skill.toLowerCase() && x.projectId === conf.projectId));
    c.confirmations.push(conf);
    this._save();
    return conf;
  }

  removeConfirmation(userId, candidateId, confId) {
    const c = this.getCandidate(userId, candidateId);
    if (!c) throw Object.assign(new Error('Candidate not found'), { status: 404 });
    const before = c.confirmations.length;
    c.confirmations = c.confirmations.filter(x => x.id !== confId);
    this._save();
    return before !== c.confirmations.length;
  }
}

module.exports = { Store };
