/* Decorative background only: carries no data and is not a market display. Skipped under reduced motion. */
(function () {
  var c = document.getElementById('scene');
  if (!c || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) { if (c) c.style.display = 'none'; return; }
  var g = c.getContext('2d'), pts = [], raf = 0;
  function size() { c.width = innerWidth; c.height = innerHeight; pts = []; var n = Math.min(70, Math.floor(c.width * c.height / 24000));
    for (var i = 0; i < n; i++) pts.push({ x: Math.random() * c.width, y: Math.random() * c.height, vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25 }); }
  function tick() {
    g.clearRect(0, 0, c.width, c.height);
    for (var i = 0; i < pts.length; i++) { var p = pts[i]; p.x = (p.x + p.vx + c.width) % c.width; p.y = (p.y + p.vy + c.height) % c.height;
      g.fillStyle = 'rgba(34,211,238,.7)'; g.fillRect(p.x, p.y, 2, 2);
      for (var j = i + 1; j < pts.length; j++) { var q = pts[j], d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < 130) { g.strokeStyle = 'rgba(56,189,248,' + (0.16 * (1 - d / 130)) + ')'; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke(); } } }
    raf = requestAnimationFrame(tick);
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) cancelAnimationFrame(raf); else raf = requestAnimationFrame(tick); });
  addEventListener('resize', size); size(); raf = requestAnimationFrame(tick);
})();
