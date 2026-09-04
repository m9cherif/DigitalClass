/**
 * Live rooms: microphone, camera and screen sharing over WebRTC.
 *
 * The server is only a signalling relay and a source of truth for "who is in
 * the room" and "who is on the board". Media itself flows peer-to-peer in a
 * mesh, which keeps the server cheap but means rooms stay classroom-sized.
 */
import { db, now } from './db.js';

const rooms = new Map();               // key -> room
export const MAX_PARTICIPANTS = 16;    // a full mesh past this melts phones

const key = (scope, id) => `${scope}:${id}`;

/** STUN is enough on most school networks; TURN is added when configured. */
export function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map(s => s.trim()),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS
    });
  }
  return list;
}

/**
 * Who may enter, and who runs the room.
 * Teachers of the course (and admins) host; enrolled students attend.
 */
export function access(user, scope, id) {
  let course = null;
  if (scope === 'course') course = db.courses.byId(id);
  else if (scope === 'quiz') course = db.courses.byId(db.quizzes.byId(id)?.courseId);
  if (!course) return { ok: false, error: 'room_not_found' };

  const isTeacher = course.teacherId === user.id || (course.coTeacherIds || []).includes(user.id);
  if (isTeacher || user.role === 'admin') return { ok: true, host: true, course };

  const enrolled = db.enrollments.findOne({ userId: user.id, courseId: course.id, status: 'active' });
  if (!enrolled) return { ok: false, error: 'not_enrolled' };
  return { ok: true, host: false, course };
}

export function getRoom(scope, id, { create = false, title = '', hostId = null } = {}) {
  const k = key(scope, id);
  let room = rooms.get(k);
  if (!room && create) {
    room = {
      key: k, scope, id, title, hostId,
      participants: new Map(),      // userId -> participant
      spotlight: [],                // userIds pinned to the board, host-controlled
      forceMuted: false,            // host asked everyone to mute
      startedAt: now()
    };
    rooms.set(k, room);
  }
  return room || null;
}

export function join(room, user, socketId, isHost) {
  if (room.participants.size >= MAX_PARTICIPANTS && !room.participants.has(user.id)) {
    return { error: 'room_full', max: MAX_PARTICIPANTS };
  }
  const participant = {
    userId: user.id, socketId, name: user.name, avatar: user.avatar || null,
    role: user.role, host: isHost,
    audio: false, video: false, screen: false, hand: false,
    joinedAt: now()
  };
  room.participants.set(user.id, participant);
  if (isHost && !room.hostId) room.hostId = user.id;
  // The teacher is on the board by default — that is what a class expects.
  if (isHost && !room.spotlight.length) room.spotlight = [user.id];
  return { participant };
}

export function leave(room, userId) {
  room.participants.delete(userId);
  room.spotlight = room.spotlight.filter(u => u !== userId);
  if (!room.participants.size) rooms.delete(room.key);
}

export const isHost = (room, userId) =>
  room.hostId === userId || room.participants.get(userId)?.host === true;

export function setSpotlight(room, userIds) {
  // Only people actually in the room can be on the board, max four tiles.
  room.spotlight = [...new Set(userIds)].filter(u => room.participants.has(u)).slice(0, 4);
  return room.spotlight;
}

export function publicRoom(room) {
  return {
    scope: room.scope, id: room.id, title: room.title,
    hostId: room.hostId, spotlight: room.spotlight, forceMuted: room.forceMuted,
    startedAt: room.startedAt,
    participants: [...room.participants.values()].map(p => ({
      userId: p.userId, name: p.name, avatar: p.avatar, role: p.role, host: p.host,
      audio: p.audio, video: p.video, screen: p.screen, hand: p.hand
    }))
  };
}

/** Live rooms attached to a course, for the "someone is live now" badge. */
export function roomsForCourse(courseId) {
  return [...rooms.values()]
    .filter(r => r.scope === 'course' && r.id === courseId)
    .map(r => ({ scope: r.scope, id: r.id, participants: r.participants.size, startedAt: r.startedAt }));
}

export const activeRooms = () => [...rooms.values()].map(publicRoom);
