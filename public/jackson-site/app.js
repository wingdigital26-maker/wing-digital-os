/* Jackson Roofing — interactions & motion. Vanilla JS, respects reduced-motion. */
(function(){
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Mark reveals so no-JS still shows content */
  document.documentElement.classList.add('js');

  /* Sticky nav shrink + shadow */
  var header = document.querySelector('header.site');
  function onScroll(){ if(header){ header.classList.toggle('scrolled', window.scrollY > 20); } }
  onScroll(); window.addEventListener('scroll', onScroll, {passive:true});

  /* Mobile nav */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('nav');
  if(toggle && nav){
    toggle.addEventListener('click', function(){
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open);
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
    /* Mobile dropdown expand */
    nav.querySelectorAll('li.has-sub > a').forEach(function(a){
      a.addEventListener('click', function(e){
        if(window.innerWidth <= 900){ e.preventDefault(); a.parentElement.classList.toggle('open-sub'); }
      });
    });
    nav.querySelectorAll('a').forEach(function(a){
      a.addEventListener('click', function(){ if(!a.parentElement.classList.contains('has-sub')){ nav.classList.remove('open'); toggle.setAttribute('aria-expanded','false'); } });
    });
  }

  /* Scroll reveal via IntersectionObserver (staggered) */
  var reveals = document.querySelectorAll('.reveal');
  if(reduce || !('IntersectionObserver' in window)){
    reveals.forEach(function(el){ el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){ if(en.isIntersecting){ en.target.classList.add('in'); io.unobserve(en.target); } });
    }, {threshold:0.14, rootMargin:'0px 0px -8% 0px'});
    reveals.forEach(function(el){ io.observe(el); });
    /* Reveal anything already in view on load (covers slow/quirky IO) */
    var inView = function(el){ var r = el.getBoundingClientRect(); return r.top < (window.innerHeight||0) && r.bottom > 0; };
    requestAnimationFrame(function(){ reveals.forEach(function(el){ if(inView(el)){ el.classList.add('in'); io.unobserve(el); } }); });
    /* Safety net: never leave content permanently hidden */
    setTimeout(function(){ reveals.forEach(function(el){ el.classList.add('in'); }); }, 4000);
  }

  /* Count-up stats */
  function fmt(el, n){ var s = el.hasAttribute('data-plain') ? String(n) : n.toLocaleString(); return s + (el.getAttribute('data-suffix') || ''); }
  function countUp(el){
    var target = parseFloat(el.getAttribute('data-count'));
    var dur = 1500, start = null;
    function step(ts){
      if(!start) start = ts;
      var p = Math.min((ts - start)/dur, 1);
      var eased = 1 - Math.pow(1-p, 3);
      el.textContent = fmt(el, Math.floor(eased*target));
      if(p < 1) requestAnimationFrame(step); else el.textContent = fmt(el, target);
    }
    requestAnimationFrame(step);
  }
  var nums = document.querySelectorAll('[data-count]');
  if(reduce || !('IntersectionObserver' in window)){
    nums.forEach(function(el){ el.textContent = fmt(el, parseFloat(el.getAttribute('data-count'))); });
  } else {
    var io2 = new IntersectionObserver(function(entries){
      entries.forEach(function(en){ if(en.isIntersecting){ countUp(en.target); io2.unobserve(en.target); } });
    }, {threshold:0.5});
    nums.forEach(function(el){ el._io=io2; io2.observe(el); });
    /* Fallback: run count-up for any stat already in view */
    var setFinal = function(el){ el.textContent = fmt(el, parseFloat(el.getAttribute('data-count'))); };
    var seen = function(el){ el._done=true; if(el._io) el._io.unobserve(el); countUp(el); };
    var inView2 = function(el){ var r = el.getBoundingClientRect(); return r.top < (window.innerHeight||0)*0.9 && r.bottom > 0; };
    requestAnimationFrame(function(){ nums.forEach(function(el){ if(!el._done && inView2(el)) seen(el); }); });
    /* Safety net: if rAF is throttled (offscreen/background), show the final number outright */
    setTimeout(function(){ nums.forEach(function(el){ if(!el._done && inView2(el)) seen(el); }); }, 4200);
    setTimeout(function(){ nums.forEach(function(el){ setFinal(el); }); }, 6000);
  }

  /* Hero parallax on mouse move */
  var visual = document.querySelector('[data-parallax]');
  if(visual && !reduce){
    var layers = visual.querySelectorAll('[data-depth]');
    visual.addEventListener('mousemove', function(e){
      var r = visual.getBoundingClientRect();
      var x = (e.clientX - r.left)/r.width - .5;
      var y = (e.clientY - r.top)/r.height - .5;
      layers.forEach(function(l){
        var d = parseFloat(l.getAttribute('data-depth'));
        l.style.transform = 'translate('+(x*d*28)+'px,'+(y*d*28)+'px)';
      });
    });
    visual.addEventListener('mouseleave', function(){
      layers.forEach(function(l){ l.style.transform=''; });
    });
  }

  /* Tabs */
  document.querySelectorAll('[data-tabs]').forEach(function(group){
    var btns = group.querySelectorAll('.tab-btn');
    var panels = group.querySelectorAll('.tab-panel');
    btns.forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = btn.getAttribute('data-tab');
        btns.forEach(function(b){ b.classList.toggle('active', b===btn); b.setAttribute('aria-selected', b===btn); });
        panels.forEach(function(p){ p.classList.toggle('active', p.getAttribute('data-panel')===id); });
      });
    });
  });

  /* Testimonial / expectation carousel (auto-advance + controls) */
  document.querySelectorAll('[data-carousel]').forEach(function(car){
    var track = car.querySelector('.car-track');
    var slides = car.querySelectorAll('.car-slide');
    var dots = car.querySelectorAll('.car-dot');
    var i = 0, timer;
    function go(n){
      i = (n + slides.length) % slides.length;
      track.style.transform = 'translateX(' + (-i*100) + '%)';
      dots.forEach(function(d,di){ d.classList.toggle('active', di===i); });
    }
    car.querySelectorAll('[data-car-prev]').forEach(function(b){ b.addEventListener('click', function(){ go(i-1); reset(); }); });
    car.querySelectorAll('[data-car-next]').forEach(function(b){ b.addEventListener('click', function(){ go(i+1); reset(); }); });
    dots.forEach(function(d,di){ d.addEventListener('click', function(){ go(di); reset(); }); });
    function reset(){ if(reduce) return; clearInterval(timer); timer = setInterval(function(){ go(i+1); }, 5500); }
    reset(); go(0);
    car.addEventListener('mouseenter', function(){ clearInterval(timer); });
    car.addEventListener('mouseleave', reset);
  });

  /* Form handler: honeypot + webhook-ready */
  document.querySelectorAll('form.jf').forEach(function(f){
    f.addEventListener('submit', function(e){
      e.preventDefault();
      var hp = f.querySelector('[name="company"]');
      if(hp && hp.value) return;
      var hook = (f.getAttribute('data-webhook')||'').trim();
      function done(msg){ var box=document.createElement('div'); box.className='form-note'; box.style.cssText='padding:1.1rem;background:var(--cyan-soft);border-radius:12px;color:var(--navy);font-weight:600;font-size:1rem'; box.textContent=msg; f.innerHTML=''; f.appendChild(box); }
      if(!hook){ done('Thanks. Your request has been received. On the live site this reaches the Jackson Roofing office instantly, and we call you back fast.'); return; }
      var data = {}; new FormData(f).forEach(function(v,k){ if(k!=='company') data[k]=v; });
      data.source = location.pathname;
      fetch(hook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
        .then(function(r){ if(!r.ok) throw new Error(); done('Thanks. Your request is in, and we will call you back shortly.'); })
        .catch(function(){ done('Something went wrong. Please call us at (469) 323-4626 instead.'); });
    });
  });
})();
