/* Live quiz parties: host console, join flow, question round and podium. */
import { api, store, router, t, i18n, esc, toast, connectSocket, avatar } from '../core.js';
import * as Q from '../questions.js';

export async function partyView(_p, out) {
  const [{ rooms }, { quizzes }, { parties }] = await Promise.all([
    api.get('/parties/live'),
    api.get('/quizzes').catch(() => ({ quizzes: [] })),
    api.get('/parties/history').catch(() => ({ parties: [] }))
  ]);
  const canHost = ['teacher', 'admin'].includes(store.user.role);

  out.innerHTML = `
    <div class="party-hero mb">
      <h1 style="color:#fff">🎉 ${t('party.title')}</h1>
      <p style="opacity:.9">${t('party.subtitle')}</p>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h3>${t('party.join')}</h3>
        <input id="pin" class="pin-input" maxlength="6" placeholder="ABC123">
        <button class="btn btn-primary btn-block btn-lg mt" id="join">${t('party.join')}</button>
      </div>

      <div class="card">
        <h3>${t('party.host')}</h3>
        ${canHost ? `
          <div class="field"><label>${t('nav.quizzes')}</label>
            <select id="quiz">${quizzes.filter(q => q.questionCount > 0).map(q =>
              `<option value="${q.id}">${esc(q.title)} (${q.questionCount})</option>`).join('')}</select></div>
          <div class="row">
            <div class="field" style="flex:1"><label>${t('party.mode')}</label>
              <select id="mode">${['classic', 'team', 'survival', 'marathon'].map(m =>
                `<option value="${m}">${t('party.mode.' + m)}</option>`).join('')}</select></div>
            <div class="field" style="flex:1"><label>${t('party.secondsPerQuestion')}</label>
              <input id="secs" type="number" value="30" min="5" max="180"></div>
          </div>
          <button class="btn btn-primary btn-block" id="host">${t('party.host')}</button>`
          : `<div class="muted small">${t('party.waiting')}</div>`}
      </div>
    </div>

    ${rooms.length ? `<div class="card mt"><h3>${t('party.live')}</h3>
      ${rooms.map(r => `<div class="between" style="padding:.45rem 0">
        <span><strong>${esc(r.title)}</strong> <span class="tiny muted">${esc(r.hostName)} · ${r.playerCount} ${t('party.players')}</span></span>
        <button class="btn btn-sm" data-pin="${r.pin}">${t('party.join')} ${r.pin}</button>
      </div>`).join('')}</div>` : ''}

    ${parties.length ? `<div class="card mt"><h3>${t('party.history')}</h3>
      <div class="table-wrap"><table><tbody>${parties.slice(0, 8).map(p => {
        const me = p.players.find(x => x.userId === store.user.id);
        return `<tr><td>${esc(p.title)}</td><td class="tiny muted">${i18n.date(p.endedAt)}</td>
          <td>${p.players.length} ${t('party.players')}</td>
          <td>${me ? `<span class="badge badge-${me.rank === 1 ? 'success' : 'primary'}">#${me.rank} · ${me.score}</span>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div></div>` : ''}`;

  out.querySelector('#join').onclick = () => {
    const pin = out.querySelector('#pin').value.trim().toUpperCase();
    if (pin.length === 6) router.go('/party/' + pin);
  };
  out.querySelector('#pin').onkeydown = e => { if (e.key === 'Enter') out.querySelector('#join').click(); };
  out.querySelectorAll('[data-pin]').forEach(b => b.onclick = () => router.go('/party/' + b.dataset.pin));

  out.querySelector('#host')?.addEventListener('click', () => {
    const sock = connectSocket();
    sock.emit('party:create', {
      quizId: out.querySelector('#quiz').value,
      options: { mode: out.querySelector('#mode').value, secondsPerQuestion: Number(out.querySelector('#secs').value) }
    }, res => {
      if (res.error) return toast(t('common.error') + ': ' + res.error, 'error');
      router.go('/party/' + res.pin);
    });
  });
}

export async function partyRoomView({ pin }, out) {
  const sock = connectSocket();
  let room = null, isHost = false, me = null, current = null, answered = false, endsAt = 0, ticker = null;

  const cleanup = () => {
    clearInterval(ticker);
    ['party:players', 'party:question', 'party:reveal', 'party:ended', 'party:answered', 'party:reaction']
      .forEach(ev => sock.off(ev));
  };

  sock.emit('party:join', { pin }, res => {
    if (res.error) {
      out.innerHTML = `<div class="empty-state"><span class="ic">🔍</span>${t('party.notFound')}
        <div class="mt"><a class="btn" href="/party">${t('common.back')}</a></div></div>`;
      return;
    }
    room = res.room;
    isHost = res.isHost;
    me = res.player;
    if (res.question) { current = res.question; drawQuestion(); }
    else drawLobby([]);
  });

  sock.on('party:players', ({ players }) => { if (!current) drawLobby(players); });
  sock.on('party:question', ({ question, index, total, seconds, endsAt: e }) => {
    current = question; answered = false; endsAt = e;
    room.questionIndex = index; room.questionCount = total; room.secondsPerQuestion = seconds;
    drawQuestion();
  });
  sock.on('party:reveal', data => drawReveal(data));
  sock.on('party:ended', final => { cleanup(); drawPodium(final); });
  sock.on('party:answered', ({ count, total }) => {
    const el = out.querySelector('#answeredCount');
    if (el) el.textContent = `${count}/${total} ${t('party.answered')}`;
  });
  sock.on('party:reaction', ({ emoji }) => floatEmoji(emoji));

  function drawLobby(players) {
    out.innerHTML = `
      <div class="party-hero mb">
        <div style="opacity:.85">${t('party.pin')}</div>
        <div class="pin-display">${esc(pin)}</div>
        <div class="mt" style="opacity:.9">${esc(room?.title || '')}</div>
      </div>
      <div class="card">
        <div class="between mb">
          <h3>${t('party.players')} (${players.length})</h3>
          ${isHost ? `<button class="btn btn-primary" id="start" ${players.length ? '' : 'disabled'}>${t('party.startGame')}</button>`
                   : `<span class="muted small">${t('party.waiting')}</span>`}
        </div>
        <div class="row">${players.map(p =>
          `<span class="player-tag">${esc(p.name)}${p.team ? ` <span class="badge">${p.team}</span>` : ''}</span>`).join('')
          || `<span class="muted small">${t('common.empty')}</span>`}</div>
      </div>`;
    out.querySelector('#start')?.addEventListener('click', () => sock.emit('party:start', { pin }, () => {}));
  }

  function drawQuestion() {
    const q = current;
    out.innerHTML = `
      <div class="between mb">
        <span class="badge badge-primary">${t('quiz.question')} ${room.questionIndex + 1}/${room.questionCount}</span>
        <span class="row">
          <span id="answeredCount" class="badge"></span>
          <span id="ptimer" class="timer"></span>
        </span>
      </div>
      <div class="q-card">
        <div class="q-prompt" style="font-size:1.3rem">${esc(i18n.pick(q, 'prompt', q.prompt))}</div>
        <div id="pbody"></div>
        <div id="feedback" class="mt"></div>
      </div>
      <div class="row mt" style="justify-content:center">
        ${['🔥', '😂', '😱', '👏'].map(e => `<button class="btn btn-sm" data-react="${e}">${e}</button>`).join('')}
        ${isHost ? `<span style="flex:1"></span>
          <button class="btn" id="skip">${t('party.nextQuestion')} →</button>
          <button class="btn btn-danger" id="end">${t('party.endGame')}</button>` : ''}
      </div>`;

    const body = out.querySelector('#pbody');
    // Choice questions get the big coloured Kahoot-style buttons.
    if (q.type === 'mcq_single' || q.type === 'true_false') {
      const options = q.type === 'true_false' ? [t('q.true'), t('q.false')] : (q.data.options || []);
      body.innerHTML = `<div class="grid grid-2">${options.map((o, i) =>
        `<button class="party-opt po-${i}" data-a="${i}">${esc(o)}</button>`).join('')}</div>`;
      body.querySelectorAll('[data-a]').forEach(b => b.onclick = () =>
        answer(q.type === 'true_false' ? b.dataset.a === '0' : Number(b.dataset.a)));
    } else {
      let value;
      body.innerHTML = Q.render(q, undefined);
      Q.bind(body, q, undefined, v => { value = v; });
      body.insertAdjacentHTML('beforeend',
        `<button class="btn btn-primary btn-block btn-lg mt" id="sendAnswer">${t('common.submit')}</button>`);
      body.querySelector('#sendAnswer').onclick = () => answer(value);
    }

    out.querySelectorAll('[data-react]').forEach(b => b.onclick = () => {
      sock.emit('party:reaction', { pin, emoji: b.dataset.react });
      floatEmoji(b.dataset.react);
    });
    out.querySelector('#skip')?.addEventListener('click', () => sock.emit('party:next', { pin }, () => {}));
    out.querySelector('#end')?.addEventListener('click', () => sock.emit('party:end', { pin }, () => {}));

    clearInterval(ticker);
    ticker = setInterval(() => {
      const el = out.querySelector('#ptimer');
      if (!el) return clearInterval(ticker);
      const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      el.textContent = `⏱ ${left}`;
      el.className = `timer ${left <= 5 ? 'danger' : left <= 10 ? 'warn' : ''}`;
    }, 250);
  }

  function answer(value) {
    if (answered) return;
    answered = true;
    sock.emit('party:answer', { pin, value }, res => {
      const fb = out.querySelector('#feedback');
      if (!fb) return;
      if (res.error) { answered = false; return; }
      fb.innerHTML = `
        <div class="card center" style="border-color:var(--${res.correct ? 'success' : 'danger'})">
          <div style="font-size:2rem">${res.correct ? '✅' : '❌'}</div>
          <div><strong>+${res.points}</strong> ${t('common.points')}</div>
          <div class="tiny muted">${res.base} + ⚡${res.speed}${res.streakBonus ? ` + 🔥${res.streakBonus}` : ''}</div>
          ${res.streak > 1 ? `<span class="badge badge-warning mt">🔥 ${t('party.streak')} ${res.streak}</span>` : ''}
          ${res.lives != null ? `<div class="mt">${'❤️'.repeat(Math.max(0, res.lives))}</div>` : ''}
        </div>`;
      out.querySelectorAll('.party-opt, #sendAnswer').forEach(b => b.disabled = true);
    });
  }

  function drawReveal({ answer: correct, explanation, standings, isLast }) {
    clearInterval(ticker);
    const rows = standings.players;
    out.innerHTML = `
      <div class="card center mb">
        <h2>${t('party.correctAnswer')}</h2>
        <div class="badge badge-success" style="font-size:1rem">${esc(
          Array.isArray(correct) ? correct.join(', ') : String(correct ?? ''))}</div>
        ${explanation ? `<p class="muted small mt">${esc(explanation)}</p>` : ''}
      </div>
      ${standings.teams ? `<div class="card mb"><h3>${t('party.mode.team')}</h3>
        ${standings.teams.map(tm => `<div class="between"><strong>${esc(tm.team)}</strong>
          <span class="badge badge-primary">${tm.score}</span></div>`).join('')}</div>` : ''}
      <div class="card">
        <h3>${t('lb.title')}</h3>
        ${rows.slice(0, 10).map(p => `
          <div class="between" style="padding:.35rem 0;${p.userId === store.user.id ? 'font-weight:700' : ''}">
            <span class="row"><span class="avatar">${p.rank}</span>${esc(p.name)}
              ${p.userId === store.user.id ? `<span class="badge badge-primary">${t('party.you')}</span>` : ''}
              ${p.eliminated ? '<span class="badge badge-danger">✕</span>' : ''}</span>
            <span class="badge">${p.score}</span>
          </div>`).join('')}
      </div>
      ${isHost ? `<div class="center mt">
        <button class="btn btn-primary btn-lg" id="nx">${isLast ? t('party.endGame') : t('party.nextQuestion')} →</button>
      </div>` : `<div class="center muted mt">${t('party.waiting')}</div>`}`;

    out.querySelector('#nx')?.addEventListener('click', () =>
      sock.emit(isLast ? 'party:end' : 'party:next', { pin }, () => {}));
  }

  function drawPodium(final) {
    const top = final.players.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter(Boolean);
    out.innerHTML = `
      <div class="center mb"><h1>🏆 ${t('party.podium')}</h1></div>
      <div class="podium mb">${order.map(p => `
        <div class="podium-step podium-${p.rank}">
          <div style="font-size:1.6rem">${p.rank === 1 ? '🥇' : p.rank === 2 ? '🥈' : '🥉'}</div>
          <strong>${esc(p.name)}</strong>
          <div class="badge badge-primary mt">${p.score}</div>
        </div>`).join('')}</div>
      <div class="card">
        <h3>${t('party.finalScores')}</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>${t('party.rank')}</th><th>${t('lb.student')}</th><th>${t('quiz.correct')}</th>
            <th>🔥</th><th>${t('quiz.score')}</th></tr></thead>
          <tbody>${final.players.map(p => `
            <tr style="${p.userId === store.user.id ? 'font-weight:700' : ''}">
              <td>${p.rank}</td><td>${esc(p.name)}</td>
              <td>${p.correct}/${p.answered}</td><td>${p.bestStreak}</td><td>${p.score}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="center mt"><a class="btn btn-primary" href="/party">${t('common.back')}</a></div>`;
  }

  function floatEmoji(emoji) {
    const el = document.createElement('div');
    el.textContent = emoji;
    el.style.cssText = `position:fixed;inset-block-end:80px;inset-inline-start:${20 + Math.random() * 60}%;
      font-size:2rem;pointer-events:none;z-index:60;transition:all 2s ease-out`;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = 'translateY(-220px)';
      el.style.opacity = '0';
    });
    setTimeout(() => el.remove(), 2100);
  }

  window.addEventListener('popstate', cleanup, { once: true });
}
