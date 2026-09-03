import { Router } from 'express';
import { db, now } from '../lib/db.js';
import { awardXp, leaderboard } from '../lib/gamification.js';
import { requireAuth, requireRole, publicUser, canEditCourse, isEnrolled } from '../middleware/auth.js';

const router = Router();

/* ------------------------------------------------------------------ forum */

router.get('/threads', requireAuth, (req, res) => {
  const { courseId, q = '', tag, sort = 'recent' } = req.query;
  let rows = db.threads.all();
  if (courseId) rows = rows.filter(t => t.courseId === courseId);
  if (tag) rows = rows.filter(t => (t.tags || []).includes(tag));
  if (q) rows = rows.filter(t => t.title.toLowerCase().includes(String(q).toLowerCase()));

  const decorated = rows.map(t => ({
    ...t,
    author: publicUser(db.users.byId(t.authorId)),
    replies: db.posts.count({ threadId: t.id }),
    course: db.courses.byId(t.courseId)?.title || null
  }));
  const order = {
    recent: (a, b) => (b.lastReplyAt || b.createdAt).localeCompare(a.lastReplyAt || a.createdAt),
    popular: (a, b) => b.replies - a.replies,
    unanswered: (a, b) => a.replies - b.replies
  }[sort] || (() => 0);

  res.json({ threads: decorated.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || order(a, b)) });
});

router.post('/threads', requireAuth, (req, res) => {
  const { title, body, courseId = null, tags = [] } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title_and_body_required' });
  if (courseId && req.user.role === 'student' && !isEnrolled(req.user.id, courseId)) {
    return res.status(403).json({ error: 'not_enrolled' });
  }
  const thread = db.threads.insert({
    title: String(title).slice(0, 160), body, courseId, tags,
    authorId: req.user.id, pinned: false, locked: false, solved: false,
    views: 0, votes: 0, voters: {}, lastReplyAt: now()
  });
  awardXp(req.user.id, 8, 'forum_thread');
  res.status(201).json({ thread });
});

router.get('/threads/:id', requireAuth, (req, res) => {
  const thread = db.threads.byId(req.params.id);
  if (!thread) return res.status(404).json({ error: 'not_found' });
  db.threads.update(thread.id, { views: (thread.views || 0) + 1 });
  res.json({
    thread: { ...thread, author: publicUser(db.users.byId(thread.authorId)) },
    posts: db.posts.find({ threadId: thread.id })
      .sort((a, b) => (b.accepted ? 1 : 0) - (a.accepted ? 1 : 0) || b.votes - a.votes || a.createdAt.localeCompare(b.createdAt))
      .map(p => ({ ...p, author: publicUser(db.users.byId(p.authorId)) }))
  });
});

router.post('/threads/:id/posts', requireAuth, (req, res) => {
  const thread = db.threads.byId(req.params.id);
  if (!thread) return res.status(404).json({ error: 'not_found' });
  if (thread.locked) return res.status(423).json({ error: 'thread_locked' });
  const post = db.posts.insert({
    threadId: thread.id, authorId: req.user.id, body: req.body?.body || '',
    code: req.body?.code || null, votes: 0, voters: {}, accepted: false
  });
  db.threads.update(thread.id, { lastReplyAt: now() });
  if (thread.authorId !== req.user.id) {
    db.notifications.insert({
      userId: thread.authorId, kind: 'reply', read: false,
      data: { threadId: thread.id, title: thread.title, by: req.user.name }
    });
  }
  awardXp(req.user.id, 5, 'forum_post');
  res.status(201).json({ post });
});

/** One vote per user, toggled off by voting again. */
router.post('/posts/:id/vote', requireAuth, (req, res) => {
  const post = db.posts.byId(req.params.id);
  if (!post) return res.status(404).json({ error: 'not_found' });
  const dir = Number(req.body?.dir) >= 0 ? 1 : -1;
  const voters = { ...(post.voters || {}) };
  if (voters[req.user.id] === dir) delete voters[req.user.id];
  else voters[req.user.id] = dir;
  const votes = Object.values(voters).reduce((s, v) => s + v, 0);
  db.posts.update(post.id, { voters, votes });
  res.json({ votes, mine: voters[req.user.id] || 0 });
});

/** The thread author (or a teacher) marks the answer that solved it. */
router.post('/posts/:id/accept', requireAuth, (req, res) => {
  const post = db.posts.byId(req.params.id);
  if (!post) return res.status(404).json({ error: 'not_found' });
  const thread = db.threads.byId(post.threadId);
  const teaching = ['teacher', 'admin'].includes(req.user.role);
  if (thread.authorId !== req.user.id && !teaching) return res.status(403).json({ error: 'forbidden' });
  db.posts.updateWhere({ threadId: thread.id }, { accepted: false });
  db.posts.update(post.id, { accepted: true });
  db.threads.update(thread.id, { solved: true });
  awardXp(post.authorId, 25, 'answer_accepted');
  res.json({ ok: true });
});

router.patch('/threads/:id/moderate', requireRole('teacher', 'admin'), (req, res) => {
  const allowed = ['pinned', 'locked', 'solved'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  res.json({ thread: db.threads.update(req.params.id, patch) });
});

/* --------------------------------------------------------- direct messages */

router.get('/messages/:withUserId', requireAuth, (req, res) => {
  const pair = [req.user.id, req.params.withUserId].sort().join('|');
  db.messages.updateWhere({ roomId: pair, toId: req.user.id, read: false }, { read: true });
  res.json({
    messages: db.messages.find({ roomId: pair, kind: 'dm' }).slice(-200),
    peer: publicUser(db.users.byId(req.params.withUserId))
  });
});

router.post('/messages/:toUserId', requireAuth, (req, res) => {
  const to = db.users.byId(req.params.toUserId);
  if (!to) return res.status(404).json({ error: 'user_not_found' });
  const pair = [req.user.id, to.id].sort().join('|');
  const message = db.messages.insert({
    roomId: pair, kind: 'dm', authorId: req.user.id, authorName: req.user.name,
    toId: to.id, text: String(req.body?.text || '').slice(0, 4000), read: false, at: now()
  });
  db.notifications.insert({
    userId: to.id, kind: 'dm', read: false,
    data: { from: req.user.name, fromId: req.user.id, preview: message.text.slice(0, 80) }
  });
  res.status(201).json({ message });
});

router.get('/conversations', requireAuth, (req, res) => {
  const mine = db.messages.find({ kind: 'dm' })
    .filter(m => m.authorId === req.user.id || m.toId === req.user.id);
  const byPeer = new Map();
  for (const m of mine) {
    const peerId = m.authorId === req.user.id ? m.toId : m.authorId;
    const prev = byPeer.get(peerId);
    if (!prev || m.at > prev.at) byPeer.set(peerId, m);
  }
  res.json({
    conversations: [...byPeer.entries()].map(([peerId, m]) => ({
      peer: publicUser(db.users.byId(peerId)),
      lastMessage: m.text, at: m.at,
      unread: db.messages.count({ roomId: [req.user.id, peerId].sort().join('|'), toId: req.user.id, read: false })
    })).sort((a, b) => (b.at || '').localeCompare(a.at || ''))
  });
});

/* ------------------------------------------------ notifications & announcements */

router.get('/notifications', requireAuth, (req, res) => {
  const rows = db.notifications.find({ userId: req.user.id })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  res.json({ notifications: rows, unread: rows.filter(n => !n.read).length });
});

router.post('/notifications/read', requireAuth, (req, res) => {
  const ids = req.body?.ids;
  if (Array.isArray(ids)) ids.forEach(i => db.notifications.update(i, { read: true }));
  else db.notifications.updateWhere({ userId: req.user.id }, { read: true });
  res.json({ ok: true });
});

router.get('/announcements', requireAuth, (req, res) => {
  const courseIds = new Set(db.enrollments.find({ userId: req.user.id, status: 'active' }).map(e => e.courseId));
  res.json({
    announcements: db.announcements.all()
      .filter(a => !a.courseId || courseIds.has(a.courseId) || ['teacher', 'admin'].includes(req.user.role))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50)
      .map(a => ({ ...a, author: publicUser(db.users.byId(a.authorId)), course: db.courses.byId(a.courseId)?.title }))
  });
});

router.post('/announcements', requireRole('teacher', 'admin'), (req, res) => {
  const { title, body, courseId = null, pinned = false } = req.body || {};
  if (courseId && !canEditCourse(req.user, db.courses.byId(courseId))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const announcement = db.announcements.insert({ title, body, courseId, pinned, authorId: req.user.id });
  const targets = courseId
    ? db.enrollments.find({ courseId, status: 'active' }).map(e => e.userId)
    : db.users.find({ status: 'active' }).map(u => u.id);
  for (const userId of targets) {
    db.notifications.insert({ userId, kind: 'announcement', read: false, data: { title, id: announcement.id } });
  }
  res.status(201).json({ announcement, notified: targets.length });
});

/* ------------------------------------------------------------ leaderboard */

router.get('/leaderboard', requireAuth, (req, res) => {
  const rows = leaderboard({ scope: req.query.courseId ? 'course' : 'global', courseId: req.query.courseId });
  res.json({ leaderboard: rows, me: rows.find(r => r.id === req.user.id) || null });
});

router.get('/profile/:id', requireAuth, (req, res) => {
  const user = db.users.byId(req.params.id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const attempts = db.attempts.find({ userId: user.id, status: 'graded' });
  res.json({
    user: publicUser(user),
    badges: db.awards.find({ userId: user.id }),
    certificates: db.certificates.find({ userId: user.id }),
    stats: {
      attempts: attempts.length,
      averageScore: attempts.length
        ? +(attempts.reduce((s, a) => s + (a.result?.percent || 0), 0) / attempts.length).toFixed(1) : null,
      parties: db.attempts.count({ userId: user.id, mode: 'party' }),
      partyWins: user.partyWins || 0,
      threads: db.threads.count({ authorId: user.id }),
      posts: db.posts.count({ authorId: user.id })
    }
  });
});

export default router;
