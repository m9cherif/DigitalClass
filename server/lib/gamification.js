/**
 * XP, levels, streaks and badges. Every scoring path funnels through awardXp()
 * so a single place decides levels, streak bookkeeping and badge unlocks.
 */
import { db, now } from './db.js';

/** Level curve: level n needs 50*n^1.6 cumulative XP. Deliberately shallow early on. */
export const levelFor = xp => {
  let lvl = 1;
  while (xp >= xpForLevel(lvl + 1) && lvl < 100) lvl++;
  return lvl;
};
export const xpForLevel = lvl => Math.round(50 * Math.pow(lvl - 1, 1.6));

export function progress(xp) {
  const level = levelFor(xp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { xp, level, levelXp: xp - base, nextLevelXp: next - base, percent: Math.round(((xp - base) / Math.max(1, next - base)) * 100) };
}

export const BADGES = [
  { id: 'first_steps', icon: '🚀', xp: 20, rule: s => s.attempts >= 1 },
  { id: 'quiz_novice', icon: '📘', xp: 30, rule: s => s.attempts >= 5 },
  { id: 'quiz_adept', icon: '📗', xp: 60, rule: s => s.attempts >= 25 },
  { id: 'quiz_master', icon: '📕', xp: 150, rule: s => s.attempts >= 100 },
  { id: 'perfect_score', icon: '💯', xp: 50, rule: s => s.perfects >= 1 },
  { id: 'flawless_five', icon: '🎯', xp: 120, rule: s => s.perfects >= 5 },
  { id: 'code_breaker', icon: '🧑‍💻', xp: 80, rule: s => s.codeCorrect >= 10 },
  { id: 'debugger', icon: '🐞', xp: 70, rule: s => s.bugsFound >= 5 },
  { id: 'sql_wizard', icon: '🗄️', xp: 70, rule: s => s.sqlCorrect >= 5 },
  { id: 'binary_brain', icon: '🔢', xp: 50, rule: s => s.baseCorrect >= 10 },
  { id: 'streak_3', icon: '🔥', xp: 40, rule: s => s.streak >= 3 },
  { id: 'streak_7', icon: '🔥', xp: 90, rule: s => s.streak >= 7 },
  { id: 'streak_30', icon: '🏆', xp: 300, rule: s => s.streak >= 30 },
  { id: 'party_animal', icon: '🎉', xp: 60, rule: s => s.parties >= 5 },
  { id: 'party_champion', icon: '👑', xp: 200, rule: s => s.partyWins >= 3 },
  { id: 'course_complete', icon: '🎓', xp: 250, rule: s => s.coursesCompleted >= 1 },
  { id: 'helpful', icon: '🤝', xp: 60, rule: s => s.forumPosts >= 10 },
  { id: 'night_owl', icon: '🦉', xp: 25, rule: s => s.nightAttempts >= 5 },
  { id: 'early_bird', icon: '🐣', xp: 25, rule: s => s.earlyAttempts >= 5 },
  { id: 'speed_demon', icon: '⚡', xp: 80, rule: s => s.fastPerfects >= 3 }
];

/** Recompute the per-user counters the badge rules read. */
export function statsFor(userId) {
  // A submitted attempt counts even while an essay inside it awaits a teacher.
  const attempts = db.attempts.find({ userId, status: ['graded', 'needs_review'] });
  const user = db.users.byId(userId) || {};
  const hour = a => new Date(a.submittedAt || a.createdAt).getHours();
  const typeHits = type => attempts.reduce((n, a) =>
    n + (a.result?.perQuestion || []).filter(q => q.type === type && q.correct).length, 0);

  return {
    attempts: attempts.length,
    perfects: attempts.filter(a => a.result?.percent >= 100).length,
    fastPerfects: attempts.filter(a => a.result?.percent >= 100 && a.durationSec && a.durationSec < 120).length,
    codeCorrect: typeHits('code_write') + typeHits('code_fix') + typeHits('code_output'),
    bugsFound: typeHits('bug_find'),
    sqlCorrect: typeHits('sql_query'),
    baseCorrect: typeHits('base_convert'),
    streak: user.streak || 0,
    parties: db.attempts.count({ userId, mode: 'party' }),
    partyWins: user.partyWins || 0,
    coursesCompleted: db.enrollments.count({ userId, status: 'active', completed: true }),
    forumPosts: db.posts.count({ authorId: userId }),
    nightAttempts: attempts.filter(a => hour(a) >= 22 || hour(a) < 5).length,
    earlyAttempts: attempts.filter(a => hour(a) >= 5 && hour(a) < 8).length
  };
}

/** Daily streak: same day = no change, next day = +1, gap = reset to 1. */
export function touchStreak(user) {
  const today = new Date().toISOString().slice(0, 10);
  const last = user.lastActiveDay;
  if (last === today) return { streak: user.streak || 1, lastActiveDay: today };
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const streak = last === yesterday ? (user.streak || 0) + 1 : 1;
  return { streak, longestStreak: Math.max(streak, user.longestStreak || 0), lastActiveDay: today };
}

/**
 * Add XP, roll the level, refresh the streak and unlock any newly earned badges.
 * Returns everything the client needs to show a celebration.
 */
export function awardXp(userId, amount, reason = 'activity') {
  const user = db.users.byId(userId);
  if (!user) return null;

  const streakPatch = touchStreak(user);
  const beforeLevel = levelFor(user.xp || 0);
  let xp = (user.xp || 0) + Math.max(0, Math.round(amount));

  const owned = new Set(db.awards.find({ userId }).map(a => a.badgeId));
  const stats = { ...statsFor(userId), streak: streakPatch.streak };
  const unlocked = [];
  for (const badge of BADGES) {
    if (owned.has(badge.id) || !badge.rule(stats)) continue;
    db.awards.insert({ userId, badgeId: badge.id, icon: badge.icon, awardedAt: now() });
    xp += badge.xp;
    unlocked.push(badge);
  }

  const afterLevel = levelFor(xp);
  db.users.update(userId, { xp, level: afterLevel, ...streakPatch });

  if (afterLevel > beforeLevel) {
    db.notifications.insert({ userId, kind: 'level_up', data: { level: afterLevel }, read: false });
  }
  for (const b of unlocked) {
    db.notifications.insert({ userId, kind: 'badge', data: { badgeId: b.id, icon: b.icon }, read: false });
  }
  db.events.insert({ userId, kind: 'xp', amount, reason, at: now() });

  return { xp, level: afterLevel, leveledUp: afterLevel > beforeLevel, unlocked, streak: streakPatch.streak };
}

/** XP for a graded attempt: base + accuracy bonus + speed bonus. */
export function xpForAttempt(result, quiz, durationSec) {
  const base = 10;
  const accuracy = Math.round((result.percent / 100) * 40);
  const difficulty = { easy: 0, medium: 10, hard: 25, expert: 45 }[quiz?.difficulty || 'medium'] ?? 10;
  const speed = durationSec && quiz?.timeLimitSec && durationSec < quiz.timeLimitSec * 0.5 ? 10 : 0;
  const perfect = result.percent >= 100 ? 25 : 0;
  return base + accuracy + difficulty + speed + perfect;
}

export function leaderboard({ scope = 'global', courseId = null, limit = 50 } = {}) {
  let users = db.users.find({ role: 'student', status: 'active' });
  if (scope === 'course' && courseId) {
    const ids = new Set(db.enrollments.find({ courseId, status: 'active' }).map(e => e.userId));
    users = users.filter(u => ids.has(u.id));
  }
  return users
    .map(u => ({
      id: u.id, name: u.name, avatar: u.avatar, xp: u.xp || 0,
      level: levelFor(u.xp || 0), streak: u.streak || 0,
      badges: db.awards.count({ userId: u.id })
    }))
    .sort((a, b) => b.xp - a.xp || b.badges - a.badges)
    .slice(0, limit)
    .map((u, i) => ({ rank: i + 1, ...u }));
}
