/**
 * Socket.IO layer: live quiz parties, live A/V rooms, course chat and presence.
 */
import { Server } from 'socket.io';
import { db, now, whenReady } from './lib/db.js';
import { verifyToken } from './middleware/auth.js';
import {
  createRoom, getRoom, joinRoom, leaveRoom, publicRoom, standings,
  currentQuestion, scoreAnswer, endRoom
} from './lib/party.js';
import * as Live from './lib/live.js';

export function attachRealtime(httpServer) {
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });

  io.use(async (socket, next) => {
    // A client can connect before the store has hydrated; wait rather than
    // rejecting the handshake.
    await whenReady;
    const payload = verifyToken(socket.handshake.auth?.token);
    const user = payload ? db.users.byId(payload.sub) : null;
    if (!user) return next(new Error('unauthenticated'));
    socket.user = user;
    next();
  });

  io.on('connection', socket => {
    socket.join(`user:${socket.user.id}`);
    socket.emit('ready', { userId: socket.user.id, name: socket.user.name });

    /* ------------------------------------------------------------ parties */

    socket.on('party:create', ({ quizId, options }, ack = () => {}) => {
      const quiz = db.quizzes.byId(quizId);
      if (!quiz) return ack({ error: 'quiz_not_found' });
      const questions = (quiz.questionIds || []).map(i => db.questions.byId(i)).filter(Boolean);
      if (!questions.length) return ack({ error: 'quiz_empty' });
      const room = createRoom({ quiz, questions, host: socket.user, options });
      socket.join(`party:${room.pin}`);
      socket.data.pin = room.pin;
      ack({ room: publicRoom(room), pin: room.pin, isHost: true });
    });

    socket.on('party:join', ({ pin, team }, ack = () => {}) => {
      const room = getRoom(pin);
      if (!room) return ack({ error: 'room_not_found' });
      if (room.state === 'ended') return ack({ error: 'room_ended' });

      // The host runs the board and admins supervise — neither plays, so
      // neither lands on the scoreboard or earns XP.
      const spectator = room.hostId === socket.user.id || socket.user.role === 'admin';
      if (spectator) {
        socket.join(`party:${room.pin}`);
        socket.data.pin = room.pin;
        return ack({
          room: publicRoom(room), player: null, spectator: true,
          isHost: room.hostId === socket.user.id,
          question: room.state === 'question' ? currentQuestion(room) : null
        });
      }

      const { error, player } = joinRoom(room, socket.user, team);
      if (error) return ack({ error });
      socket.join(`party:${room.pin}`);
      socket.data.pin = room.pin;
      io.to(`party:${room.pin}`).emit('party:players', {
        players: [...room.players.values()].map(p => ({ userId: p.userId, name: p.name, team: p.team, score: p.score })),
        count: room.players.size
      });
      ack({
        room: publicRoom(room), player, isHost: room.hostId === socket.user.id,
        question: room.state === 'question' ? currentQuestion(room) : null
      });
    });

    socket.on('party:start', ({ pin }, ack = () => {}) => {
      const room = getRoom(pin);
      if (!room || room.hostId !== socket.user.id) return ack({ error: 'not_host' });
      nextQuestion(room);
      ack({ ok: true });
    });

    socket.on('party:answer', ({ pin, value }, ack = () => {}) => {
      const room = getRoom(pin);
      if (!room || room.state !== 'question') return ack({ error: 'not_accepting' });
      const player = room.players.get(socket.user.id);
      if (!player || player.eliminated) return ack({ error: 'not_playing' });

      const bucket = room.answers.get(room.index) ?? new Map();
      if (bucket.has(socket.user.id)) return ack({ error: 'already_answered' });
      const elapsed = Date.now() - room.questionStartedAt;
      bucket.set(socket.user.id, { value, at: elapsed });
      room.answers.set(room.index, bucket);

      const outcome = scoreAnswer(room, room.questions[room.index], player, value, elapsed);
      ack({ ...outcome, score: player.score });

      io.to(`party:${room.pin}`).emit('party:answered', { count: bucket.size, total: alive(room) });
      if (bucket.size >= alive(room)) revealQuestion(room);
    });

    socket.on('party:next', ({ pin }, ack = () => {}) => {
      const room = getRoom(pin);
      if (!room || room.hostId !== socket.user.id) return ack({ error: 'not_host' });
      nextQuestion(room);
      ack({ ok: true });
    });

    socket.on('party:end', ({ pin }, ack = () => {}) => {
      const room = getRoom(pin);
      if (!room || room.hostId !== socket.user.id) return ack({ error: 'not_host' });
      const final = endRoom(room);
      io.to(`party:${room.pin}`).emit('party:ended', final);
      ack({ ok: true });
    });

    socket.on('party:kick', ({ pin, userId }, ack = () => {}) => {
      const room = getRoom(pin);
      if (!room || room.hostId !== socket.user.id) return ack({ error: 'not_host' });
      room.players.delete(userId);
      io.to(`user:${userId}`).emit('party:kicked', { pin });
      ack({ ok: true });
    });

    socket.on('party:reaction', ({ pin, emoji }) => {
      const room = getRoom(pin);
      if (!room) return;
      socket.to(`party:${pin}`).emit('party:reaction', { emoji, from: socket.user.name });
    });

    /* --------------------------------------------- live audio/video rooms */

    socket.on('live:join', ({ scope, id }, ack = () => {}) => {
      const perm = Live.access(socket.user, scope, id);
      if (!perm.ok) return ack({ error: perm.error });

      const room = Live.getRoom(scope, id, {
        create: true, title: perm.course.title, hostId: perm.host ? socket.user.id : null
      });
      const { error, participant } = Live.join(room, socket.user, socket.id, perm.host);
      if (error) return ack({ error });

      socket.join(`live:${room.key}`);
      socket.data.live = { scope, id };

      ack({
        room: Live.publicRoom(room),
        me: participant,
        isHost: perm.host,
        iceServers: Live.iceServers()
      });
      // Everyone already in the room hears about the newcomer and waits for
      // their offer — the joiner is always the one who initiates.
      socket.to(`live:${room.key}`).emit('live:joined', { participant, room: Live.publicRoom(room) });
    });

    /** Blind relay for SDP offers/answers and ICE candidates. */
    socket.on('live:signal', ({ to, kind, payload }) => {
      const ctx = socket.data.live;
      if (!ctx || !to) return;
      const room = Live.getRoom(ctx.scope, ctx.id);
      const peer = room?.participants.get(to);
      if (!peer) return;
      io.to(peer.socketId).emit('live:signal', { from: socket.user.id, kind, payload });
    });

    socket.on('live:state', (patch = {}) => {
      const ctx = socket.data.live;
      const room = ctx && Live.getRoom(ctx.scope, ctx.id);
      const me = room?.participants.get(socket.user.id);
      if (!me) return;
      for (const k of ['audio', 'video', 'screen', 'hand']) {
        if (patch[k] !== undefined) me[k] = !!patch[k];
      }
      // A screen share takes the board automatically; nobody wants to hunt for it.
      if (patch.screen === true && !room.spotlight.includes(socket.user.id)) {
        Live.setSpotlight(room, [socket.user.id, ...room.spotlight]);
      }
      if (patch.screen === false) {
        room.spotlight = room.spotlight.filter(u => u !== socket.user.id || Live.isHost(room, u));
      }
      io.to(`live:${room.key}`).emit('live:room', Live.publicRoom(room));
    });

    /** Host decides who is on the board (the big tiles at the top). */
    socket.on('live:spotlight', ({ userIds }, ack = () => {}) => {
      const ctx = socket.data.live;
      const room = ctx && Live.getRoom(ctx.scope, ctx.id);
      if (!room) return ack({ error: 'no_room' });
      if (!Live.isHost(room, socket.user.id)) return ack({ error: 'not_host' });
      Live.setSpotlight(room, Array.isArray(userIds) ? userIds : [userIds]);
      io.to(`live:${room.key}`).emit('live:room', Live.publicRoom(room));
      ack({ spotlight: room.spotlight });
    });

    /** Host mutes the class; students can still unmute themselves afterwards. */
    socket.on('live:muteAll', (_p, ack = () => {}) => {
      const ctx = socket.data.live;
      const room = ctx && Live.getRoom(ctx.scope, ctx.id);
      if (!room || !Live.isHost(room, socket.user.id)) return ack({ error: 'not_host' });
      room.forceMuted = true;
      for (const p of room.participants.values()) if (!p.host) p.audio = false;
      io.to(`live:${room.key}`).emit('live:muted', { by: socket.user.name });
      io.to(`live:${room.key}`).emit('live:room', Live.publicRoom(room));
      ack({ ok: true });
    });

    socket.on('live:remove', ({ userId }, ack = () => {}) => {
      const ctx = socket.data.live;
      const room = ctx && Live.getRoom(ctx.scope, ctx.id);
      if (!room || !Live.isHost(room, socket.user.id)) return ack({ error: 'not_host' });
      const peer = room.participants.get(userId);
      if (peer) {
        io.to(peer.socketId).emit('live:removed');
        Live.leave(room, userId);
        io.to(`live:${room.key}`).emit('live:left', { userId, room: Live.publicRoom(room) });
      }
      ack({ ok: true });
    });

    socket.on('live:leave', () => leaveLive(socket));

    /* ------------------------------------------------------- course chat */

    socket.on('chat:join', ({ courseId }) => {
      const enrolled = db.enrollments.findOne({ userId: socket.user.id, courseId, status: 'active' });
      const course = db.courses.byId(courseId);
      const teaching = course && (course.teacherId === socket.user.id || socket.user.role === 'admin');
      if (!enrolled && !teaching) return socket.emit('chat:error', { error: 'not_enrolled' });
      socket.join(`chat:${courseId}`);
      socket.emit('chat:history', {
        messages: db.messages.find({ roomId: courseId }).slice(-50)
      });
    });

    socket.on('chat:send', ({ courseId, text }) => {
      if (!text || !socket.rooms.has(`chat:${courseId}`)) return;
      const message = db.messages.insert({
        roomId: courseId, kind: 'course', authorId: socket.user.id,
        authorName: socket.user.name, text: String(text).slice(0, 2000), at: now()
      });
      io.to(`chat:${courseId}`).emit('chat:message', message);
    });

    socket.on('chat:typing', ({ courseId }) => {
      socket.to(`chat:${courseId}`).emit('chat:typing', { name: socket.user.name });
    });

    socket.on('disconnect', () => {
      leaveLive(socket);
      const room = socket.data.pin ? getRoom(socket.data.pin) : null;
      if (!room) return;
      leaveRoom(room, socket.user.id);
      io.to(`party:${room.pin}`).emit('party:players', {
        players: [...room.players.values()].map(p => ({ userId: p.userId, name: p.name, team: p.team, score: p.score })),
        count: room.players.size
      });
    });
  });

  function leaveLive(socket) {
    const ctx = socket.data.live;
    if (!ctx) return;
    const room = Live.getRoom(ctx.scope, ctx.id);
    socket.data.live = null;
    if (!room) return;
    const key = room.key;
    Live.leave(room, socket.user.id);
    socket.leave(`live:${key}`);
    io.to(`live:${key}`).emit('live:left', {
      userId: socket.user.id,
      room: Live.getRoom(ctx.scope, ctx.id) ? Live.publicRoom(room) : null
    });
  }

  const alive = room => [...room.players.values()].filter(p => p.connected && !p.eliminated).length || 1;

  function nextQuestion(room) {
    if (room.timer) clearTimeout(room.timer);
    room.index++;
    if (room.index >= room.questions.length) {
      const final = endRoom(room);
      return io.to(`party:${room.pin}`).emit('party:ended', final);
    }
    room.state = 'question';
    room.questionStartedAt = Date.now();
    io.to(`party:${room.pin}`).emit('party:question', {
      index: room.index, total: room.questions.length,
      question: currentQuestion(room),
      seconds: room.secondsPerQuestion,
      endsAt: Date.now() + room.secondsPerQuestion * 1000
    });
    room.timer = setTimeout(() => revealQuestion(room), room.secondsPerQuestion * 1000);
  }

  function revealQuestion(room) {
    if (room.state !== 'question') return;
    if (room.timer) clearTimeout(room.timer);
    room.state = 'reveal';
    const question = room.questions[room.index];
    const bucket = room.answers.get(room.index) ?? new Map();

    // Answer distribution, so the host can see where the class went wrong.
    const distribution = {};
    for (const [, a] of bucket) {
      const key = JSON.stringify(a.value);
      distribution[key] = (distribution[key] || 0) + 1;
    }

    io.to(`party:${room.pin}`).emit('party:reveal', {
      index: room.index,
      answer: question.data?.answer ?? question.data?.accepted ?? null,
      explanation: question.explanation || '',
      distribution,
      standings: standings(room),
      isLast: room.index >= room.questions.length - 1
    });
    room.state = 'leaderboard';
  }

  return io;
}
