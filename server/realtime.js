/**
 * Socket.IO layer: live quiz parties, course chat rooms and push notifications.
 */
import { Server } from 'socket.io';
import { db, now } from './lib/db.js';
import { verifyToken } from './middleware/auth.js';
import {
  createRoom, getRoom, joinRoom, leaveRoom, publicRoom, standings,
  currentQuestion, scoreAnswer, endRoom, destroyRoom
} from './lib/party.js';

export function attachRealtime(httpServer) {
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });

  io.use((socket, next) => {
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
      const room = socket.data.pin ? getRoom(socket.data.pin) : null;
      if (!room) return;
      leaveRoom(room, socket.user.id);
      io.to(`party:${room.pin}`).emit('party:players', {
        players: [...room.players.values()].map(p => ({ userId: p.userId, name: p.name, team: p.team, score: p.score })),
        count: room.players.size
      });
    });
  });

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
