/* Wing Digital entity: Zephyr.
 * Floating orb with counter-rotating orbit rings and a blinking lens.
 * Self-contained interactive SVG component. No dependencies.
 * Usage:
 *   <script src="/mascot/wing-mascot.js"></script>
 *   var m = WingMascot.mount(document.getElementById('slot'), { size: 120, intro: true });
 *   m.setState('calm' | 'excited' | 'alert' | 'dim');
 * Behavior: levitates with a breathing glow, blinks its lens on a random timer,
 * rings spin up on hover/tap, brief flare on fast scroll. Honors
 * prefers-reduced-motion (static pose, no timers).
 */
(function () {
  var SVG = '<svg viewBox="0 0 200 200" width="100%" height="100%" aria-hidden="true" style="overflow:visible">' +
    '<defs>' +
    '<radialGradient id="wmCore" cx="42%" cy="34%" r="75%">' +
    '<stop offset="0%" stop-color="#9db4ff"/><stop offset="45%" stop-color="#2757E6"/><stop offset="100%" stop-color="#12245e"/>' +
    '</radialGradient>' +
    '<radialGradient id="wmHalo" cx="50%" cy="50%" r="50%">' +
    '<stop offset="0%" stop-color="#2757E6" stop-opacity=".55"/><stop offset="100%" stop-color="#2757E6" stop-opacity="0"/>' +
    '</radialGradient>' +
    '<linearGradient id="wmComet" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0%" stop-color="#c9d6ff" stop-opacity="0"/><stop offset="70%" stop-color="#9db4ff" stop-opacity=".9"/><stop offset="100%" stop-color="#eaf0ff"/>' +
    '</linearGradient>' +
    '<linearGradient id="wmRing" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0%" stop-color="#c9d6ff"/><stop offset="55%" stop-color="#5f82f5"/><stop offset="100%" stop-color="#2757E6" stop-opacity=".35"/>' +
    '</linearGradient>' +
    '<radialGradient id="wmSheen" cx="50%" cy="50%" r="50%">' +
    '<stop offset="0%" stop-color="#ffffff" stop-opacity=".5"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>' +
    '</radialGradient>' +
    '<radialGradient id="wmAtmo" cx="50%" cy="42%" r="60%">' +
    '<stop offset="72%" stop-color="#7d9bff" stop-opacity="0"/><stop offset="94%" stop-color="#7d9bff" stop-opacity=".5"/><stop offset="100%" stop-color="#c9d6ff" stop-opacity=".8"/>' +
    '</radialGradient>' +
    '</defs>' +
    '<g class="wm-rig">' +
    '<circle class="wm-glow" cx="100" cy="96" r="74" fill="url(#wmHalo)"/>' +
    '<circle class="wm-glow2" cx="100" cy="96" r="52" fill="url(#wmHalo)"/>' +
    '<circle class="wm-core" cx="100" cy="96" r="40" fill="url(#wmCore)"/>' +
    '<circle class="wm-atmo" cx="100" cy="96" r="41.5" fill="url(#wmAtmo)"/>' +
    '<ellipse class="wm-sheenspot" cx="88" cy="80" rx="16" ry="11" fill="url(#wmSheen)" transform="rotate(-24 88 80)"/>' +
    '<g class="wm-eyes">' +
    '<g class="wm-eye-open"><rect x="84" y="82" width="11" height="24" rx="5.5" fill="#eaf0ff"/><rect x="105" y="82" width="11" height="24" rx="5.5" fill="#eaf0ff"/></g>' +
    '<g class="wm-eye-happy" opacity="0"><path d="M84 98 q5.5 -9 11 0" fill="none" stroke="#eaf0ff" stroke-width="5" stroke-linecap="round"/><path d="M105 98 q5.5 -9 11 0" fill="none" stroke="#eaf0ff" stroke-width="5" stroke-linecap="round"/></g>' +
    '</g>' +
    '<g class="wm-ring wm-r1">' +
    '<ellipse cx="100" cy="96" rx="62" ry="20" fill="none" stroke="url(#wmRing)" stroke-width="1.6" opacity=".75" transform="rotate(-18 100 96)"/>' +
    '<circle cx="162" cy="96" r="6" fill="#7d9bff" opacity=".35" transform="rotate(-18 100 96)"/>' +
    '<circle cx="162" cy="96" r="3.6" fill="#eaf0ff" transform="rotate(-18 100 96)"/>' +
    '</g>' +
    '<g class="wm-ring wm-r2">' +
    '<ellipse cx="100" cy="96" rx="56" ry="26" fill="none" stroke="url(#wmRing)" stroke-width="1.2" opacity=".45" transform="rotate(24 100 96)"/>' +
    '<circle cx="44" cy="96" r="4.6" fill="#7d9bff" opacity=".3" transform="rotate(24 100 96)"/>' +
    '<circle cx="44" cy="96" r="2.8" fill="#c9d6ff" transform="rotate(24 100 96)"/>' +
    '</g>' +
    '<g class="wm-comet">' +
    '<circle cx="100" cy="70" r="5.6" fill="#eaf0ff" opacity=".3" transform="rotate(-18 100 96)"/>' +
    '<circle cx="100" cy="70" r="3.2" fill="#ffffff" transform="rotate(-18 100 96)"/>' +
    '</g>' +
    '<g class="wm-props">' +
    '<g class="wm-p wm-p-think">' +
    '<circle cx="128" cy="54" r="3" fill="#7d9bff"/><circle cx="137" cy="43" r="4.5" fill="#9db4ff"/>' +
    '<ellipse cx="154" cy="27" rx="17" ry="11" fill="#dbe4ff" stroke="#7d9bff" stroke-width="1.2"/><ellipse cx="141" cy="31" rx="10" ry="8" fill="#dbe4ff" stroke="#7d9bff" stroke-width="1.2"/><ellipse cx="167" cy="31" rx="10" ry="8" fill="#dbe4ff" stroke="#7d9bff" stroke-width="1.2"/>' +
    '<circle class="wm-td" cx="146" cy="28" r="2.2" fill="#2757E6"/><circle class="wm-td wm-td2" cx="154" cy="28" r="2.2" fill="#2757E6"/><circle class="wm-td wm-td3" cx="162" cy="28" r="2.2" fill="#2757E6"/>' +
    '</g>' +
    '<g class="wm-p wm-p-alert"><circle cx="148" cy="36" r="13" fill="#F5A623"/><rect x="146" y="27.5" width="4" height="11" rx="2" fill="#0B0C10"/><circle cx="148" cy="43.5" r="2.2" fill="#0B0C10"/></g>' +
    '<g class="wm-p wm-p-sleep" fill="#5f82f5" font-family="Inter,system-ui,sans-serif" font-weight="700">' +
    '<text class="wm-z" x="130" y="54" font-size="13">z</text><text class="wm-z wm-z2" x="143" y="42" font-size="17">z</text><text class="wm-z wm-z3" x="158" y="30" font-size="21">z</text>' +
    '</g>' +
    '<g class="wm-p wm-p-party">' +
    '<rect class="wm-cf" x="52" y="18" width="5" height="8" rx="1.5" fill="#F5A623"/>' +
    '<rect class="wm-cf wm-cf2" x="88" y="8" width="5" height="8" rx="1.5" fill="#7d9bff"/>' +
    '<rect class="wm-cf wm-cf3" x="126" y="14" width="5" height="8" rx="1.5" fill="#1E44B8"/>' +
    '<rect class="wm-cf wm-cf4" x="152" y="24" width="5" height="8" rx="1.5" fill="#2757E6"/>' +
    '<circle class="wm-cf wm-cf5" cx="70" cy="12" r="3" fill="#c9d6ff"/>' +
    '<circle class="wm-cf wm-cf6" cx="112" cy="20" r="3" fill="#F5A623"/>' +
    '</g>' +
    '<g class="wm-p wm-p-spark">' +
    '<g transform="translate(48,46)"><path class="wm-sp" d="M0 -6 L1.6 -1.6 L6 0 L1.6 1.6 L0 6 L-1.6 1.6 L-6 0 L-1.6 -1.6 Z" fill="#5f82f5"/></g>' +
    '<g transform="translate(154,40)"><path class="wm-sp wm-sp2" d="M0 -7 L1.8 -1.8 L7 0 L1.8 1.8 L0 7 L-1.8 1.8 L-7 0 L-1.8 -1.8 Z" fill="#2757E6"/></g>' +
    '<g transform="translate(100,22)"><path class="wm-sp wm-sp3" d="M0 -5 L1.4 -1.4 L5 0 L1.4 1.4 L0 5 L-1.4 1.4 L-5 0 L-1.4 -1.4 Z" fill="#9db4ff"/></g>' +
    '</g>' +
    '<g class="wm-p wm-p-dim"><ellipse cx="100" cy="24" rx="20" ry="9" fill="#6b7390"/><ellipse cx="85" cy="28" rx="11" ry="7" fill="#6b7390"/><ellipse cx="115" cy="28" rx="11" ry="7" fill="#6b7390"/></g>' +
    '</g>' +
    '</g></svg>';

  var CSS = '.wm-root{display:inline-block;line-height:0}' +
    '.wm-rig{transform-origin:100px 96px;animation:wm-float 4.2s ease-in-out infinite}' +
    '@keyframes wm-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}' +
    '.wm-glow{transform-origin:100px 96px;animation:wm-pulse 3.2s ease-in-out infinite}' +
    '@keyframes wm-pulse{0%,100%{opacity:.55}50%{opacity:1}}' +
    '.wm-core{transition:filter .4s;transform-origin:100px 96px;animation:wm-breathe 3.2s ease-in-out infinite}' +
    '@keyframes wm-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.035)}}' +
    '.wm-glow2{transform-origin:100px 96px;animation:wm-pulse 3.2s ease-in-out infinite;animation-delay:-1.6s;opacity:.5}' +
    '.wm-atmo{transform-origin:100px 96px;animation:wm-breathe 3.2s ease-in-out infinite;pointer-events:none}' +
    '.wm-sheenspot{pointer-events:none}' +
    '.wm-comet{transform-origin:100px 96px;animation:wm-comet 5.5s linear infinite;opacity:.9}' +
    '@keyframes wm-comet{to{transform:rotate(360deg)}}' +
    '.wm-root:hover .wm-comet,.wm-excited .wm-comet{animation-duration:1.6s}' +
    '.wm-eyes{transform-origin:100px 94px;animation:wm-look 11s ease-in-out infinite}' +
    '@keyframes wm-look{0%,26%,100%{transform:translateX(0)}30%,44%{transform:translateX(-5px)}48%,62%{transform:translateX(4px)}66%{transform:translateX(0)}}' +
    '.wm-eye-open{transform-origin:100px 94px;transition:opacity .15s}' +
    '.wm-eye-happy{transition:opacity .15s}' +
    '.wm-eyes.wm-blink .wm-eye-open{animation:wm-blinkk .3s linear}' +
    '@keyframes wm-blinkk{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.06)}}' +
    '.wm-root:hover .wm-eye-open,.wm-excited .wm-eye-open{opacity:0}' +
    '.wm-root:hover .wm-eye-happy,.wm-excited .wm-eye-happy{opacity:1}' +
    '.wm-ring{transform-origin:100px 96px;animation:wm-orbit 9s linear infinite}' +
    '.wm-r2{animation-duration:14s;animation-direction:reverse}' +
    '@keyframes wm-orbit{to{transform:rotate(360deg)}}' +
    '.wm-root:hover .wm-ring,.wm-excited .wm-ring{animation-duration:2.2s}' +
    '.wm-root:hover .wm-r2,.wm-excited .wm-r2{animation-duration:3.4s}' +
    '.wm-root:hover .wm-core,.wm-excited .wm-core{filter:brightness(1.25)}' +
    /* moods: each changes the MOTION, not just the color */
    '.wm-excited .wm-rig{animation:wm-bounce 1.1s cubic-bezier(.45,0,.55,1) infinite}' +
    '@keyframes wm-bounce{0%,100%{transform:translateY(0) scale(1)}30%{transform:translateY(-11px) scale(1.03)}55%{transform:translateY(-2px) scale(.99)}}' +
    '.wm-dim .wm-core{filter:brightness(.7) saturate(.6)}' +
    '.wm-dim .wm-glow{animation-duration:6s;opacity:.3}' +
    '.wm-dim .wm-rig{animation:wm-sink 6.5s ease-in-out infinite}' +
    '@keyframes wm-sink{0%,100%{transform:translateY(3px)}50%{transform:translateY(0)}}' +
    '.wm-dim .wm-ring{animation-duration:22s}.wm-dim .wm-r2{animation-duration:30s}.wm-dim .wm-comet{opacity:.35;animation-duration:12s}' +
    '.wm-alert .wm-core{filter:brightness(1.15) hue-rotate(160deg) saturate(1.6)}' +
    '.wm-alert .wm-glow{animation-duration:1.1s}' +
    '.wm-alert .wm-rig{animation:wm-jitter .55s linear infinite}' +
    '@keyframes wm-jitter{0%,100%{transform:translate(0,0)}20%{transform:translate(-1.6px,1px)}40%{transform:translate(1.4px,-1.2px)}60%{transform:translate(-1.2px,-1px)}80%{transform:translate(1.6px,1.2px)}}' +
    '.wm-thinking .wm-eyes{animation:none;transform:translate(-5px,-6px)}' +
    '.wm-thinking .wm-rig{animation:wm-ponder 5.6s ease-in-out infinite}' +
    '@keyframes wm-ponder{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-5px) rotate(-4deg)}}' +
    '.wm-thinking .wm-comet{animation-duration:2.8s;opacity:1}' +
    '.wm-sleepy .wm-eye-open{transform:scaleY(.28)}' +
    '.wm-sleepy .wm-eyes{animation:none}' +
    '.wm-sleepy .wm-rig{animation:wm-drowse 8s ease-in-out infinite}' +
    '@keyframes wm-drowse{0%,100%{transform:translateY(4px) rotate(2deg)}50%{transform:translateY(1px) rotate(-1deg)}}' +
    '.wm-sleepy .wm-glow{animation-duration:8s;opacity:.35}.wm-sleepy .wm-ring{animation-duration:26s}.wm-sleepy .wm-r2{animation-duration:34s}.wm-sleepy .wm-comet{opacity:.2;animation-duration:16s}' +
    '.wm-party .wm-rig{animation:wm-spinup 1.4s cubic-bezier(.4,0,.35,1) infinite}' +
    '@keyframes wm-spinup{0%,100%{transform:translateY(0) rotate(0) scale(1)}25%{transform:translateY(-9px) rotate(-9deg) scale(1.05)}50%{transform:translateY(-3px) rotate(0) scale(1)}75%{transform:translateY(-9px) rotate(9deg) scale(1.05)}}' +
    '.wm-party .wm-ring{animation-duration:1.4s}.wm-party .wm-r2{animation-duration:2s}.wm-party .wm-comet{animation-duration:.9s;opacity:1}.wm-party .wm-glow{animation-duration:.9s}' +
    '.wm-party .wm-eye-open{opacity:0}.wm-party .wm-eye-happy{opacity:1}' +
    /* mood props: one little scene element per mood, hidden until its mood is on */
    '.wm-p{opacity:0;transition:opacity .35s}' +
    '.wm-thinking .wm-p-think,.wm-alert .wm-p-alert,.wm-sleepy .wm-p-sleep,.wm-party .wm-p-party,.wm-excited .wm-p-spark,.wm-dim .wm-p-dim{opacity:1}' +
    '.wm-td{animation:wm-tdp 1.4s ease-in-out infinite}.wm-td2{animation-delay:.25s}.wm-td3{animation-delay:.5s}' +
    '@keyframes wm-tdp{0%,100%{opacity:.25}50%{opacity:1}}' +
    '.wm-p-alert{transform-origin:148px 36px;animation:wm-pop 1s ease-in-out infinite}' +
    '@keyframes wm-pop{0%,100%{transform:scale(1)}50%{transform:scale(1.14)}}' +
    '.wm-z{opacity:0;animation:wm-zrise 3s ease-in-out infinite}.wm-z2{animation-delay:1s}.wm-z3{animation-delay:2s}' +
    '@keyframes wm-zrise{0%{transform:translate(0,6px);opacity:0}30%{opacity:.9}100%{transform:translate(6px,-14px);opacity:0}}' +
    '.wm-cf{animation:wm-fall 1.7s linear infinite}' +
    '.wm-cf2{animation-delay:.3s}.wm-cf3{animation-delay:.6s}.wm-cf4{animation-delay:.9s}.wm-cf5{animation-delay:.45s}.wm-cf6{animation-delay:1.1s}' +
    '@keyframes wm-fall{0%{transform:translateY(-4px) rotate(0);opacity:0}15%{opacity:1}100%{transform:translateY(30px) rotate(140deg);opacity:0}}' +
    '.wm-sp{animation:wm-tw 1.5s ease-in-out infinite}.wm-sp2{animation-delay:.5s}.wm-sp3{animation-delay:1s}' +
    '@keyframes wm-tw{0%,100%{opacity:.15;transform:scale(.6) rotate(0)}50%{opacity:1;transform:scale(1.15) rotate(45deg)}}' +
    '.wm-p-dim{animation:wm-cloudbob 7s ease-in-out infinite}' +
    '@keyframes wm-cloudbob{0%,100%{transform:translateY(0)}50%{transform:translateY(3px)}}' +
    '.wm-flare .wm-glow{animation:wm-flarek .6s ease-out}' +
    '@keyframes wm-flarek{0%{opacity:1;transform:scale(1)}40%{opacity:1;transform:scale(1.25)}100%{opacity:.55;transform:scale(1)}}' +
    '.wm-intro{animation:wm-arrive 1.6s cubic-bezier(.22,.9,.3,1) both}' +
    '@keyframes wm-arrive{0%{transform:translateY(-36px) scale(.5);opacity:0}60%{opacity:1}100%{transform:none;opacity:1}}' +
    '@media (prefers-reduced-motion:reduce){.wm-rig,.wm-glow,.wm-glow2,.wm-atmo,.wm-eyes,.wm-eye-open,.wm-ring,.wm-comet,.wm-core,.wm-intro,.wm-flare .wm-glow{animation:none !important}}' +
'@media (prefers-reduced-motion:reduce){.wm-excited .wm-rig,.wm-dim .wm-rig,.wm-alert .wm-rig,.wm-thinking .wm-rig,.wm-sleepy .wm-rig,.wm-party .wm-rig{animation:none !important}' +
'.wm-td,.wm-p-alert,.wm-z,.wm-cf,.wm-sp,.wm-p-dim{animation:none !important}.wm-z,.wm-cf,.wm-sp{opacity:.8}}';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var styleInjected = false;

  function mount(el, opts) {
    opts = opts || {};
    if (!styleInjected) {
      var s = document.createElement('style');
      s.textContent = CSS;
      document.head.appendChild(s);
      styleInjected = true;
    }
    var root = document.createElement('span');
    root.className = 'wm-root' + (opts.intro && !reduced ? ' wm-intro' : '');
    root.style.width = (opts.size || 96) + 'px';
    root.style.height = (opts.size || 96) + 'px';
    root.innerHTML = SVG;
    root.setAttribute('role', 'button');
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-label', 'Zephyr, the Wing Digital assistant');
    root.style.cursor = 'pointer';
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); root.click(); }
    });
    el.appendChild(root);
    var alive = true;

    var eyes = root.querySelector('.wm-eyes');

    function blink() {
      if (reduced) return;
      eyes.classList.add('wm-blink');
      setTimeout(function () { eyes.classList.remove('wm-blink'); }, 320);
    }
    function flare() {
      if (reduced) return;
      root.classList.add('wm-flare');
      setTimeout(function () { root.classList.remove('wm-flare'); }, 650);
    }
    var MOODS = ['excited', 'alert', 'dim', 'thinking', 'sleepy', 'party'];
    /* pinned: a mood the page has committed to (e.g. an honestly dim
     * dashboard). Ambient behavior (autoMood, pulse endings) returns here
     * instead of to calm, so temporary emotions never erase an honest state. */
    var pinned = null;
    function setState(state) {
      MOODS.forEach(function (m) { root.classList.remove('wm-' + m); });
      if (MOODS.indexOf(state) !== -1) root.classList.add('wm-' + state);
    }
    function pin(state) { pinned = MOODS.indexOf(state) !== -1 ? state : null; setState(state); }
    function unpin() { pinned = null; setState('calm'); }

    root.addEventListener('click', flare);

    var onMove = null, onScroll = null;
    if (!reduced) {
      (function blinkLoop() {
        setTimeout(function () {
          if (!alive || !root.isConnected) return;
          blink(); blinkLoop();
        }, 2600 + Math.random() * 4200);
      })();
      if (opts.intro) setTimeout(flare, 1700);
      /* eyes follow the cursor; idle look-around resumes after 3s still */
      var idleTimer = null, raf = 0, mx = 0, my = 0;
      function track() {
        raf = 0;
        var r = root.getBoundingClientRect();
        var cx = r.left + r.width / 2, cy = r.top + r.height * 0.46;
        var dx = mx - cx, dy = my - cy;
        var d = Math.sqrt(dx * dx + dy * dy) || 1;
        var m = Math.min(d / 40, 1);
        eyes.style.animation = 'none';
        eyes.style.transform = 'translate(' + (dx / d * 6 * m).toFixed(1) + 'px,' + (dy / d * 4 * m).toFixed(1) + 'px)';
        clearTimeout(idleTimer);
        idleTimer = setTimeout(function () {
          eyes.style.transform = '';
          eyes.style.animation = '';
        }, 3000);
      }
      onMove = function (e) {
        mx = e.clientX; my = e.clientY;
        if (!raf) raf = requestAnimationFrame(track);
      };
      window.addEventListener('mousemove', onMove, { passive: true });
      var lastY = window.scrollY, busy = false;
      onScroll = function () {
        var dy = Math.abs(window.scrollY - lastY);
        lastY = window.scrollY;
        if (dy > 240 && !busy) {
          busy = true;
          flare();
          setTimeout(function () { busy = false; }, 900);
        }
      };
      window.addEventListener('scroll', onScroll, { passive: true });
    }
    function destroy() {
      alive = false;
      if (onMove) window.removeEventListener('mousemove', onMove);
      if (onScroll) window.removeEventListener('scroll', onScroll);
      root.remove();
    }
    /* pulse: hold a mood for ms, then return to the pinned mood if the page
     * set one, otherwise calm. The timer always fires; a later pulse resets it. */
    var pulseTimer = null;
    function pulse(state, ms) {
      setState(state);
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(function () { setState(pinned || 'calm'); }, ms || 4000);
    }
    /* bubble: a small speech balloon near the orb, for arrival greetings.
     * Plain text only; fades out after ms (default 7s). */
    var bubbleEl = null, bubbleTimer = null;
    function bubble(text, ms) {
      if (!text) return;
      if (!bubbleEl) {
        bubbleEl = document.createElement('div');
        bubbleEl.setAttribute('role', 'status');
        bubbleEl.style.cssText = 'position:fixed;z-index:60;max-width:240px;padding:10px 13px;' +
          'background:rgba(13,15,22,.97);color:#eaf0ff;border:1px solid rgba(125,155,255,.4);' +
          'border-radius:12px 12px 3px 12px;font:13px/1.45 Inter,system-ui,sans-serif;' +
          'box-shadow:0 8px 30px rgba(39,87,230,.3);opacity:0;transition:opacity .4s;pointer-events:none';
        document.body.appendChild(bubbleEl);
      }
      bubbleEl.textContent = text;
      var r = root.getBoundingClientRect();
      bubbleEl.style.visibility = 'hidden';
      bubbleEl.style.opacity = '0';
      bubbleEl.style.left = 'auto';
      bubbleEl.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      bubbleEl.style.bottom = Math.max(8, window.innerHeight - r.top + 10) + 'px';
      bubbleEl.style.visibility = 'visible';
      requestAnimationFrame(function () { bubbleEl.style.opacity = '1'; });
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(function () { bubbleEl.style.opacity = '0'; }, ms || 7000);
    }
    function hideBubble() {
      clearTimeout(bubbleTimer);
      if (bubbleEl) bubbleEl.style.opacity = '0';
    }
    return {
      blink: blink, flare: flare, setState: setState, pin: pin, unpin: unpin,
      pulse: pulse, bubble: bubble, hideBubble: hideBubble, destroy: destroy, el: root,
      getPinned: function () { return pinned; }
    };
  }

  /* autoMood: ambient emotions from real, honest signals.
   * - Sleepy late at night (11pm to 6am local) once the visitor goes quiet.
   * - Sleepy after ~2.5 minutes of no interaction at any hour.
   * - Any activity wakes him: back to calm with a flare.
   * - Tab coming back into view earns a little flare hello.
   * Never invents business emotions; those come from page data via setState/pulse. */
  function autoMood(m) {
    if (!m || !m.setState) return;
    if (m._autoMoodOff) return; // one ambient loop per mascot
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var idleMs = 150000, idleTimer = null, dozing = false;
    function isNight() { var h = new Date().getHours(); return h >= 23 || h < 6; }
    function doze() { dozing = true; m.setState('sleepy'); }
    function armIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(doze, isNight() ? 45000 : idleMs);
    }
    function wake() {
      if (dozing) {
        dozing = false;
        // Waking restores the page's pinned mood (an honest dim stays dim).
        m.setState((m.getPinned && m.getPinned()) || 'calm');
        m.flare();
      }
      armIdle();
    }
    function onVis() { if (!document.hidden) { wake(); m.flare(); } }
    var evs = ['mousemove', 'scroll', 'keydown', 'pointerdown', 'touchstart'];
    evs.forEach(function (ev) { window.addEventListener(ev, wake, { passive: true }); });
    document.addEventListener('visibilitychange', onVis);
    armIdle();
    m._autoMoodOff = function () {
      clearTimeout(idleTimer);
      evs.forEach(function (ev) { window.removeEventListener(ev, wake); });
      document.removeEventListener('visibilitychange', onVis);
      m._autoMoodOff = null;
    };
    var baseDestroy = m.destroy;
    m.destroy = function () {
      if (m._autoMoodOff) m._autoMoodOff();
      baseDestroy();
    };
  }

  window.WingMascot = { mount: mount, autoMood: autoMood };
})();

/* Zephyr assistant panel: a guided, scripted Q&A that makes the entity feel
 * like an AI you can talk to. No backend needed; swap answerFn for a real
 * API route later without touching the UI. */
(function () {
  var PANEL_CSS = '.wmp{position:fixed;right:18px;bottom:96px;z-index:70;width:min(340px,calc(100vw - 36px));' +
    'background:linear-gradient(170deg,#141a30 0%,#0d0f16 34%);border:1px solid rgba(125,155,255,.45);' +
    'border-radius:18px;box-shadow:0 2px 0 rgba(255,255,255,.06) inset,0 18px 60px rgba(39,87,230,.4);color:#eaf0ff;' +
    'font-family:Inter,system-ui,sans-serif;font-size:14px;overflow:hidden;' +
    'opacity:0;pointer-events:none;transition:opacity .35s}' +
    '.wmp.open{opacity:1;pointer-events:auto}' +
    '.wmp-head{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid rgba(125,155,255,.25);' +
    'background:linear-gradient(135deg,rgba(39,87,230,.22),rgba(39,87,230,0) 70%)}' +
    '.wmp-head b{font-weight:600}' +
    '.wmp-head .dot{width:8px;height:8px;border-radius:50%;background:#7d9bff;box-shadow:0 0 8px #7d9bff;animation:wmpulse 2s infinite}' +
    '@keyframes wmpulse{50%{opacity:.4}}' +
    '.wmp-x{margin-left:auto;background:none;border:0;color:#8fa3d8;font-size:16px;cursor:pointer;padding:2px 6px}' +
    '.wmp-body{padding:14px;min-height:72px;line-height:1.55;color:#c9d6ff}' +
    '.wmp-body a{color:#9db4ff}' +
    '.wmp-q{display:flex;flex-direction:column;gap:7px;padding:0 14px 14px}' +
    '.wmp-q button{text-align:left;background:rgba(39,87,230,.14);border:1px solid rgba(125,155,255,.3);' +
    'color:#eaf0ff;border-radius:11px;padding:9px 12px;font:inherit;cursor:pointer;' +
    'transition:background .15s,transform .15s,border-color .15s}' +
    '.wmp-q button:hover{background:rgba(39,87,230,.34);border-color:#7d9bff;transform:translateX(3px)}' +
    '.wmp-body{max-height:190px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(125,155,255,.4) transparent}' +
    '.wmp-ask{display:flex;gap:7px;padding:0 14px 14px}' +
    '.wmp-ask input{flex:1;min-width:0;background:rgba(255,255,255,.07);border:1px solid rgba(125,155,255,.3);' +
    'border-radius:10px;padding:9px 12px;color:#eaf0ff;font:inherit}' +
    '.wmp-ask input::placeholder{color:#8fa3d8}' +
    '.wmp-ask input:focus{outline:none;border-color:#7d9bff}' +
    '.wmp-ask button{background:linear-gradient(135deg,#3D6BF0,#1E44B8);border:0;color:#fff;border-radius:10px;' +
    'padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;transition:filter .15s}' +
    '.wmp-ask button:hover{filter:brightness(1.18)}' +
    '@media(prefers-reduced-motion:reduce){.wmp{transition:none}.wmp-head .dot{animation:none}}';

  function attachChat(mascot, opts) {
    if (mascot.el._wmChat) return mascot.el._wmChat;
    if (!attachChat._css) {
      var s = document.createElement('style');
      s.textContent = PANEL_CSS;
      document.head.appendChild(s);
      attachChat._css = true;
    }
    var p = document.createElement('div');
    p.className = 'wmp';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Zephyr assistant');
    p.innerHTML = '<div class="wmp-head"><span class="dot"></span><b>Zephyr</b>' +
      '<span style="color:#8fa3d8;font-size:12px">Wing Digital</span>' +
      '<button class="wmp-x" aria-label="Close">&times;</button></div>' +
      '<div class="wmp-body"></div><div class="wmp-q"></div>' +
      '<div class="wmp-ask" hidden><input type="text" maxlength="200" placeholder="Ask Zephyr anything..." aria-label="Ask Zephyr">' +
      '<button type="button">Ask</button></div>';
    document.body.appendChild(p);
    var body = p.querySelector('.wmp-body');
    var qwrap = p.querySelector('.wmp-q');
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var typeTimer = null;

    function say(html) {
      clearInterval(typeTimer);
      if (reduced) { body.innerHTML = html; return; }
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var full = tmp.textContent, i = 0;
      body.textContent = '';
      typeTimer = setInterval(function () {
        i += 2;
        body.textContent = full.slice(0, i);
        if (i >= full.length) { clearInterval(typeTimer); body.innerHTML = html; }
      }, 14);
    }
    function renderQuestions() {
      qwrap.innerHTML = '';
      (opts.items || []).forEach(function (item) {
        var b = document.createElement('button');
        b.textContent = item.q;
        b.addEventListener('click', function () {
          mascot.flare();
          say(item.a);
        });
        qwrap.appendChild(b);
      });
    }
    function toggle(force) {
      var open = typeof force === 'boolean' ? force : !p.classList.contains('open');
      p.classList.toggle('open', open);
      if (open) { if (mascot.hideBubble) mascot.hideBubble(); mascot.flare(); say(opts.greeting || 'Hey, I am Zephyr. What do you want to know?'); renderQuestions(); }
    }
    /* Knowledge base: entries of {k:[keywords], a:'answer html'} from opts.kb or
     * window.ZEPHYR_KB. Pure client-side keyword scoring; unknown questions get
     * an honest fallback, never a made-up answer. */
    var kb = opts.kb || window.ZEPHYR_KB || null;
    var askRow = p.querySelector('.wmp-ask');
    if (kb && kb.length) {
      askRow.hidden = false;
      var input = askRow.querySelector('input');
      var askBtn = askRow.querySelector('button');
      function answer() {
        var q = (input.value || '').toLowerCase().trim();
        if (!q) return;
        input.value = '';
        var words = q.replace(/[^a-z0-9$ ]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 2; });
        var best = null, bestScore = 0;
        kb.forEach(function (entry) {
          var score = 0;
          (entry.k || []).forEach(function (key) {
            key = key.toLowerCase();
            if (q.indexOf(key) !== -1) score += key.indexOf(' ') !== -1 ? 3 : 2;
            else words.forEach(function (w) { if (key === w) score += 2; else if (key.indexOf(w) === 0) score += 1; });
          });
          if (score > bestScore) { bestScore = score; best = entry; }
        });
        mascot.setState && mascot.setState('thinking');
        setTimeout(function () {
          mascot.setState && mascot.setState('calm');
          mascot.flare();
          if (best && bestScore >= 2) say(best.a);
          else say(opts.fallback || 'That one is past what I know off the top of my head. The contact form reaches a real person at Wing Digital fast, and they will have the answer.');
        }, 650);
      }
      askBtn.addEventListener('click', answer);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') answer(); });
    }
    p.querySelector('.wmp-x').addEventListener('click', function () { toggle(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && p.classList.contains('open')) toggle(false);
    });
    mascot.el.addEventListener('click', function () { toggle(); });
    mascot.el.style.cursor = 'pointer';
    var api = { toggle: toggle, say: say, el: p };
    mascot.el._wmChat = api;
    return api;
  }
  if (window.WingMascot) window.WingMascot.chat = attachChat;
})();
