/**
 * Live quiz parties: a host (teacher or student) opens a room, players join with
 * a 6-character PIN, and questions are pushed in lockstep with a per-question
 * countdown. Room state lives in memory; results are persisted when it ends.
 */
import { db, id, now } from './db.js';
import { grade } from '../quiz/grader.js';
import { sanitize } from '../routes/quizzes.js';
import { awardXp } from './gamification.js';

const rooms = new Map();          // pin -> room
const PIN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const getRoom = pin => rooms.get(String(pin || '').toUpperCase()) || null;

/** `classId: null` (the default) lists homepage rooms — global quizzes only,
 *  never ones hosted from inside a class. Pass a class id to see that class's
 *  rooms instead; the two lists never overlap. */
export function listRooms({ classId = null } = {}) {
  return [...rooms.values()]
    .filter(r => (r.classId || null) === classId)
    .map(publicRoom);
}

function newPin() {
  let pin;
  do { pin = Array.from({ length: 6 }, () => PIN_CHARS[Math.floor(Math.random() * PIN_CHARS.length)]).join(''); }
  while (rooms.has(pin));
  return pin;
}

export function publicRoom(room) {
  return {
    pin: room.pin, quizId: room.quizId, title: room.title, hostName: room.hostName,
    mode: room.mode, state: room.state, questionIndex: room.index,
    questionCount: room.questions.length, playerCount: room.players.size,
    teamMode: room.teamMode, classId: room.classId, createdAt: room.createdAt
  };
}

export function createRoom({ quiz, questions, host, options = {} }) {
  const pin = newPin();
  // A room scoped to a class (hosted from inside a Class Hub) is kept out of
  // the homepage's global "live now"/history lists and vice versa — the two
  // hubs never mix rooms, only the underlying game engine is shared.
  const course = db.courses.byId(quiz.courseId);
  const room = {
    pin, id: id('party_'),
    quizId: quiz.id, courseId: quiz.courseId, classId: course?.classId || null, title: quiz.title,
    hostId: host.id, hostName: host.name,
    mode: options.mode || 'classic',            // classic | team | survival | marathon
    teamMode: options.mode === 'team',
    secondsPerQuestion: Number(options.secondsPerQuestion) || 30,
    showLeaderboardEvery: options.showLeaderboardEvery !== false,
    allowLateJoin: options.allowLateJoin !== false,
    streakBonus: options.streakBonus !== false,
    questions, index: -1, state: 'lobby',       // lobby | question | reveal | leaderboard | ended
    players: new Map(),                          // userId -> player
    answers: new Map(),                          // questionIndex -> Map(userId -> {value, at})
    timer: null, questionStartedAt: null,
    createdAt: now()
  };
  rooms.set(pin, room);
  return room;
}

export function joinRoom(room, user, team = null) {
  if (room.state !== 'lobby' && !room.allowLateJoin) return { error: 'late_join_disabled' };
  const existing = room.players.get(user.id);
  if (existing) { existing.connected = true; return { player: existing }; }
  const player = {
    userId: user.id, name: user.name, avatar: user.avatar || null,
    team: room.teamMode ? (team || (room.players.size % 2 ? 'red' : 'blue')) : null,
    score: 0, streak: 0, bestStreak: 0, correct: 0, answered: 0,
    lives: room.mode === 'survival' ? 3 : null, eliminated: false, connected: true
  };
  room.players.set(user.id, player);
  return { player };
}

export function leaveRoom(room, userId) {
  const p = room.players.get(userId);
  if (p) p.connected = false;
}

/**
 * Kahoot-style scoring: full points for a correct answer, plus up to 50% more
 * for speed, plus a streak bonus that grows with consecutive correct answers.
 */
export function scoreAnswer(room, question, player, response, elapsedMs) {
  const graded = grade(question, response);
  const base = 1000 * graded.score;
  const limit = room.secondsPerQuestion * 1000;
  const speed = graded.score > 0 ? Math.round(500 * Math.max(0, 1 - elapsedMs / limit) * graded.score) : 0;

  player.answered++;
  if (graded.correct) {
    player.correct++;
    player.streak++;
    player.bestStreak = Math.max(player.bestStreak, player.streak);
  } else {
    player.streak = 0;
    if (room.mode === 'survival' && player.lives !== null) {
      player.lives--;
      if (player.lives <= 0) player.eliminated = true;
    }
  }
  const streakBonus = room.streakBonus ? Math.min(500, Math.max(0, player.streak - 1) * 100) : 0;
  const points = Math.round(base + speed + streakBonus);
  player.score += points;

  return { ...graded, points, base: Math.round(base), speed, streakBonus, streak: player.streak, lives: player.lives };
}

export function standings(room) {
  const rows = [...room.players.values()]
    .sort((a, b) => b.score - a.score || b.correct - a.correct)
    .map((p, i) => ({ rank: i + 1, ...p }));
  if (!room.teamMode) return { players: rows, teams: null };
  const teams = {};
  for (const p of rows) {
    teams[p.team] ??= { team: p.team, score: 0, members: 0 };
    teams[p.team].score += p.score;
    teams[p.team].members++;
  }
  return { players: rows, teams: Object.values(teams).sort((a, b) => b.score - a.score) };
}

export function currentQuestion(room) {
  const q = room.questions[room.index];
  return q ? sanitize(q) : null;
}

/** Persist the party, write one attempt per player and hand out XP. */
export function endRoom(room) {
  room.state = 'ended';
  if (room.timer) clearTimeout(room.timer);
  const final = standings(room);

  db.parties.insert({
    id: room.id, pin: room.pin, quizId: room.quizId, courseId: room.courseId, classId: room.classId,
    hostId: room.hostId, mode: room.mode, title: room.title,
    questionCount: room.questions.length,
    players: final.players.map(p => ({
      userId: p.userId, name: p.name, score: p.score, rank: p.rank,
      correct: p.correct, answered: p.answered, bestStreak: p.bestStreak, team: p.team
    })),
    teams: final.teams, endedAt: now()
  });

  for (const p of final.players) {
    const responses = {};
    for (const [qi, map] of room.answers) {
      const a = map.get(p.userId);
      if (a) responses[room.questions[qi].id] = a.value;
    }
    db.attempts.insert({
      userId: p.userId, quizId: room.quizId, courseId: room.courseId,
      mode: 'party', partyId: room.id, order: room.questions.map(q => q.id),
      responses, status: 'graded', submittedAt: now(),
      result: {
        perQuestion: [], totalPoints: room.questions.length,
        earnedPoints: p.correct, percent: room.questions.length
          ? +((p.correct / room.questions.length) * 100).toFixed(2) : 0,
        pending: false
      },
      partyScore: p.score, partyRank: p.rank
    });

    // Party XP: participation + accuracy + a podium bonus.
    const podium = p.rank === 1 ? 100 : p.rank === 2 ? 60 : p.rank === 3 ? 40 : 0;
    awardXp(p.userId, 15 + p.correct * 8 + podium, 'party');
    if (p.rank === 1) {
      const u = db.users.byId(p.userId);
      if (u) db.users.update(u.id, { partyWins: (u.partyWins || 0) + 1 });
    }
    db.notifications.insert({
      userId: p.userId, kind: 'party_result', read: false,
      data: { title: room.title, rank: p.rank, score: p.score, players: final.players.length }
    });
  }

  setTimeout(() => rooms.delete(room.pin), 5 * 60_000);   // keep the results page alive briefly
  return final;
}

export function destroyRoom(pin) {
  const room = rooms.get(pin);
  if (room?.timer) clearTimeout(room.timer);
  rooms.delete(pin);
}
