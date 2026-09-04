/**
 * Live classroom: microphone, camera and screen sharing.
 *
 * Media is a peer-to-peer mesh — one RTCPeerConnection per other participant.
 * Whoever joins last sends the offers, so there is never a glare collision.
 * The server only relays SDP/ICE and owns the participant list and spotlight.
 */
import { store, t, esc, toast, connectSocket, avatar, initials } from './core.js';

const RECONNECT_KINDS = ['offer', 'answer', 'ice'];

export class LiveRoom {
  constructor({ scope, id, mount }) {
    this.scope = scope;
    this.id = id;
    this.mount = mount;
    this.sock = connectSocket();
    this.peers = new Map();        // userId -> { pc, stream }
    this.streams = new Map();      // userId -> MediaStream
    this.local = null;             // camera/mic stream
    this.screen = null;            // screen stream
    this.room = null;
    this.isHost = false;
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.state = { audio: false, video: false, screen: false, hand: false };
    this.joined = false;
  }

  /* ------------------------------------------------------------- joining */

  async join() {
    return new Promise(resolve => {
      this.sock.emit('live:join', { scope: this.scope, id: this.id }, res => {
        if (res.error) {
          this.renderError(res.error);
          return resolve({ error: res.error });
        }
        this.room = res.room;
        this.isHost = res.isHost;
        this.iceServers = res.iceServers || this.iceServers;
        this.joined = true;
        this.wire();
        this.render();
        // Offer to everyone already here.
        for (const p of this.room.participants) {
          if (p.userId !== store.user.id) this.connectTo(p.userId, true);
        }
        resolve({ ok: true });
      });
    });
  }

  wire() {
    const on = (ev, fn) => { this.sock.off(ev); this.sock.on(ev, fn); };

    on('live:joined', ({ room }) => { this.room = room; this.render(); });

    on('live:left', ({ userId, room }) => {
      this.closePeer(userId);
      if (room) this.room = room;
      this.render();
    });

    on('live:room', room => { this.room = room; this.render(); });

    on('live:signal', ({ from, kind, payload }) => {
      if (RECONNECT_KINDS.includes(kind)) this.onSignal(from, kind, payload);
    });

    on('live:muted', ({ by }) => {
      if (this.state.audio) this.setAudio(false);
      toast(`🔇 ${esc(by)} — ${t('live.mutedAll')}`);
    });

    on('live:removed', () => {
      toast(t('live.removed'), 'error');
      this.leave();
    });
  }

  /* ------------------------------------------------------------ WebRTC */

  peer(userId) {
    if (this.peers.has(userId)) return this.peers.get(userId);

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    pc.onicecandidate = e => {
      if (e.candidate) this.signal(userId, 'ice', e.candidate);
    };
    pc.ontrack = e => {
      // One stream per peer carries whatever they are currently sending.
      this.streams.set(userId, e.streams[0]);
      this.render();
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.closePeer(userId);
    };

    // Publish whatever we already have.
    for (const track of this.tracksToSend()) pc.addTrack(track.track, track.stream);

    const entry = { pc, making: false };
    this.peers.set(userId, entry);
    return entry;
  }

  tracksToSend() {
    const out = [];
    const src = this.screen || this.local;
    if (this.screen) {
      for (const track of this.screen.getVideoTracks()) out.push({ track, stream: this.screen });
      // Keep the microphone alive while the screen is shared.
      if (this.local) for (const track of this.local.getAudioTracks()) out.push({ track, stream: this.local });
    } else if (src) {
      for (const track of src.getTracks()) out.push({ track, stream: src });
    }
    return out;
  }

  async connectTo(userId, initiator) {
    const { pc } = this.peer(userId);
    if (!initiator) return;
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    this.signal(userId, 'offer', offer);
  }

  async onSignal(from, kind, payload) {
    const { pc } = this.peer(from);
    try {
      if (kind === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(payload));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal(from, 'answer', answer);
      } else if (kind === 'answer') {
        if (pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription(payload));
        }
      } else if (kind === 'ice') {
        await pc.addIceCandidate(new RTCIceCandidate(payload));
      }
    } catch (err) {
      console.warn('live signal', kind, err.message);
    }
  }

  signal(to, kind, payload) {
    this.sock.emit('live:signal', { to, kind, payload });
  }

  closePeer(userId) {
    const entry = this.peers.get(userId);
    if (entry) { try { entry.pc.close(); } catch {} }
    this.peers.delete(userId);
    this.streams.delete(userId);
  }

  /** Re-negotiate with everyone after the local tracks change. */
  async republish() {
    for (const [userId, { pc }] of this.peers) {
      for (const sender of pc.getSenders()) pc.removeTrack(sender);
      for (const { track, stream } of this.tracksToSend()) pc.addTrack(track, stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signal(userId, 'offer', offer);
    }
  }

  /* ------------------------------------------------------ device control */

  async ensureLocal(want = { audio: true, video: false }) {
    if (this.local) return this.local;
    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: want.video ? { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' } : false
      });
      // Start with everything off; the buttons turn tracks on explicitly.
      this.local.getTracks().forEach(tr => { tr.enabled = false; });
      return this.local;
    } catch (err) {
      toast(t('live.permissionDenied'), 'error');
      return null;
    }
  }

  async setAudio(on) {
    const stream = await this.ensureLocal({ audio: true, video: false });
    if (!stream) return;
    let track = stream.getAudioTracks()[0];
    if (!track && on) {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: true });
      track = fresh.getAudioTracks()[0];
      stream.addTrack(track);
      await this.republish();
    }
    if (track) track.enabled = on;
    this.state.audio = on;
    this.push();
  }

  async setVideo(on) {
    let stream = await this.ensureLocal({ audio: true, video: true });
    if (!stream) return;
    let track = stream.getVideoTracks()[0];
    if (!track && on) {
      const fresh = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' }
      });
      track = fresh.getVideoTracks()[0];
      stream.addTrack(track);
      await this.republish();
    }
    if (track) track.enabled = on;
    this.state.video = on;
    this.push();
  }

  async setScreen(on) {
    if (on) {
      try {
        this.screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } catch { return; }
      // The browser's own "stop sharing" bar must switch our state back too.
      this.screen.getVideoTracks()[0].addEventListener('ended', () => this.setScreen(false));
    } else {
      this.screen?.getTracks().forEach(tr => tr.stop());
      this.screen = null;
    }
    this.state.screen = on;
    await this.republish();
    this.push();
  }

  toggleHand() {
    this.state.hand = !this.state.hand;
    this.push();
  }

  push() {
    this.sock.emit('live:state', this.state);
    this.render();
  }

  spotlight(userIds) {
    this.sock.emit('live:spotlight', { userIds }, res => {
      if (res?.error) toast(t('common.error'), 'error');
    });
  }

  muteAll() { this.sock.emit('live:muteAll', {}, () => {}); }
  remove(userId) { this.sock.emit('live:remove', { userId }, () => {}); }

  leave() {
    this.sock.emit('live:leave');
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.local?.getTracks().forEach(tr => tr.stop());
    this.screen?.getTracks().forEach(tr => tr.stop());
    this.local = this.screen = null;
    this.joined = false;
    this.mount.innerHTML = '';
    this.onLeave?.();
  }

  /* ----------------------------------------------------------- rendering */

  renderError(code) {
    this.mount.innerHTML = `<div class="empty-state"><span class="ic">🎥</span>${
      esc(t('live.error.' + code) !== 'live.error.' + code ? t('live.error.' + code) : t('common.error'))}</div>`;
  }

  render() {
    if (!this.joined || !this.room) return;
    const me = store.user.id;
    const parts = this.room.participants;
    const spot = this.room.spotlight.length
      ? this.room.spotlight
      : [parts.find(p => p.host)?.userId].filter(Boolean);

    const onBoard = spot.map(uid => parts.find(p => p.userId === uid)).filter(Boolean);
    const others = parts.filter(p => !spot.includes(p.userId));

    this.mount.innerHTML = `
      <div class="live">
        <div class="live-stage ${onBoard.length > 1 ? 'multi' : ''}">
          ${onBoard.length
            ? onBoard.map(p => this.tile(p, true)).join('')
            : `<div class="live-placeholder">${t('live.nobodyOnBoard')}</div>`}
        </div>

        ${others.length ? `<div class="live-strip">${others.map(p => this.tile(p, false)).join('')}</div>` : ''}

        <div class="live-bar">
          <button class="live-btn ${this.state.audio ? 'on' : 'off'}" data-act="audio"
                  title="${t('live.mic')}">${this.state.audio ? '🎤' : '🔇'}</button>
          <button class="live-btn ${this.state.video ? 'on' : 'off'}" data-act="video"
                  title="${t('live.cam')}">${this.state.video ? '📹' : '📵'}</button>
          <button class="live-btn ${this.state.screen ? 'on' : ''}" data-act="screen"
                  title="${t('live.screen')}">🖥️</button>
          <button class="live-btn ${this.state.hand ? 'on' : ''}" data-act="hand"
                  title="${t('live.hand')}">✋</button>
          ${this.isHost ? `<button class="live-btn" data-act="muteAll" title="${t('live.muteAll')}">🔕</button>` : ''}
          <span class="live-count">👥 ${parts.length}</span>
          <button class="live-btn danger" data-act="leave" title="${t('live.leave')}">✕</button>
        </div>

        ${this.isHost ? `
          <details class="live-host">
            <summary>🎛️ ${t('live.whoOnBoard')}</summary>
            <div class="live-host-list">
              ${parts.map(p => `
                <label class="live-host-row">
                  <input type="checkbox" data-spot="${p.userId}" ${spot.includes(p.userId) ? 'checked' : ''}>
                  <span>${esc(p.name)}</span>
                  ${p.host ? `<span class="badge badge-primary">${t('auth.role.teacher')}</span>` : ''}
                  ${p.hand ? '<span class="badge badge-warning">✋</span>' : ''}
                  ${p.screen ? '<span class="badge badge-success">🖥️</span>' : ''}
                  ${!p.host && p.userId !== me
                    ? `<button class="btn btn-sm btn-danger" data-remove="${p.userId}">✕</button>` : ''}
                </label>`).join('')}
            </div>
          </details>` : ''}
      </div>`;

    this.attachStreams();
    this.bindControls();
  }

  tile(p, big) {
    const isMe = p.userId === store.user.id;
    return `
      <div class="live-tile ${big ? 'big' : ''} ${p.hand ? 'hand' : ''}" data-tile="${p.userId}">
        <video data-video="${p.userId}" ${isMe ? 'muted' : ''} autoplay playsinline
               class="${p.video || p.screen ? '' : 'hidden'}"></video>
        ${p.video || p.screen ? '' : `<div class="live-avatar">${esc(initials(p.name))}</div>`}
        <div class="live-name">
          ${p.audio ? '🎤' : '🔇'} ${esc(p.name)}${isMe ? ` (${t('party.you')})` : ''}
          ${p.screen ? ' 🖥️' : ''}${p.hand ? ' ✋' : ''}
        </div>
      </div>`;
  }

  attachStreams() {
    for (const el of this.mount.querySelectorAll('[data-video]')) {
      const uid = el.dataset.video;
      const stream = uid === store.user.id
        ? (this.screen || this.local)
        : this.streams.get(uid);
      if (stream && el.srcObject !== stream) el.srcObject = stream;
      el.play?.().catch(() => {});
    }
  }

  bindControls() {
    const acts = {
      audio: () => this.setAudio(!this.state.audio),
      video: () => this.setVideo(!this.state.video),
      screen: () => this.setScreen(!this.state.screen),
      hand: () => this.toggleHand(),
      muteAll: () => this.muteAll(),
      leave: () => this.leave()
    };
    this.mount.querySelectorAll('[data-act]').forEach(b =>
      b.onclick = () => acts[b.dataset.act]?.());

    this.mount.querySelectorAll('[data-spot]').forEach(cb => cb.onchange = () => {
      const picked = [...this.mount.querySelectorAll('[data-spot]:checked')].map(x => x.dataset.spot);
      this.spotlight(picked);
    });
    this.mount.querySelectorAll('[data-remove]').forEach(b => b.onclick = e => {
      e.preventDefault();
      this.remove(b.dataset.remove);
    });
    // Double-tapping a tile promotes it to the board (host only).
    if (this.isHost) {
      this.mount.querySelectorAll('[data-tile]').forEach(el => el.ondblclick = () =>
        this.spotlight([el.dataset.tile]));
    }
  }
}

/** Convenience: mount a live room into `host`, with a join button first. */
export function liveSection(host, { scope, id }) {
  const supported = !!(navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection);
  if (!supported) {
    host.innerHTML = `<div class="card muted small">${t('live.unsupported')}</div>`;
    return null;
  }

  host.innerHTML = `
    <div class="card live-invite">
      <div>
        <strong>🎥 ${t('live.title')}</strong>
        <div class="small muted">${t('live.hint')}</div>
      </div>
      <button class="btn btn-primary" id="liveJoin">${t('live.join')}</button>
    </div>
    <div id="liveMount"></div>`;

  const mount = host.querySelector('#liveMount');
  const invite = host.querySelector('.live-invite');

  host.querySelector('#liveJoin').onclick = async () => {
    const room = new LiveRoom({ scope, id, mount });
    room.onLeave = () => { invite.classList.remove('hidden'); };
    const res = await room.join();
    if (!res.error) {
      invite.classList.add('hidden');
      // Nudge the mic on so people can talk immediately.
      room.setAudio(true);
    }
  };
  return mount;
}
