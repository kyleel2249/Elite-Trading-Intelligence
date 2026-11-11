/* ETI 3D scenes (Three.js r149 global build). The crawler animation and globe nodes only ever reflect real state
   handed in by the page (setState / setNodes). Nothing here simulates activity. */
(function () {
  'use strict';
  const reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;

  function base(canvas, fov, camPos) {
    const T = THREE;
    const renderer = new T.WebGLRenderer({ canvas, antialias: !small, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.25 : 2));
    const scene = new T.Scene();
    const cam = new T.PerspectiveCamera(fov, 1, 0.1, 100);
    cam.position.set(camPos[0], camPos[1], camPos[2]);
    const box = canvas.parentElement;
    const ctx = { T, renderer, scene, cam, box };
    function resize() {
      const w = box.clientWidth || 300, h = box.clientHeight || 200;
      renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
      if (ctx.render) ctx.render();
    }
    new ResizeObserver(resize).observe(box);
    resize();
    return ctx;
  }

  // Renders continuously only while visible (and never when reduced motion is requested: one frame per change).
  function loop(ctx, frame) {
    let visible = true, raf = 0, last = performance.now();
    function step(now) {
      raf = 0;
      if (!visible || document.hidden) return;
      const dt = reduce ? 0.016 : Math.min(0.05, (now - last) / 1000);
      last = now;
      frame(dt, now / 1000);
      ctx.renderer.render(ctx.scene, ctx.cam);
      if (!reduce) kick();
    }
    function kick() { if (!raf) raf = requestAnimationFrame(step); }
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) { last = performance.now(); kick(); } }).observe(ctx.box);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { last = performance.now(); kick(); } });
    ctx.render = kick;
    kick();
  }

  function drag(canvas, onMove, onTap) {
    let down = null, moved = 0;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; moved = 0; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => { if (!down) return; const dx = e.clientX - down.x, dy = e.clientY - down.y; down = { x: e.clientX, y: e.clientY }; moved += Math.abs(dx) + Math.abs(dy); onMove(dx, dy); });
    const up = (e) => { if (down && moved < 5 && onTap) onTap(e); down = null; };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', () => { down = null; });
    return () => !!down;
  }

  // ------------------------------------------------------------------------------------------------ crawler
  const POSE = {
    idle: { speed: 0.35, amp: 0.06, glow: 0.45, beam: 0.0, color: 0x00a8ff },
    initialising: { speed: 0.9, amp: 0.2, glow: 0.8, beam: 0.18, color: 0xffc247 },
    scanning: { speed: 2.4, amp: 0.42, glow: 1.3, beam: 0.3, color: 0x00e5ff },
    error: { speed: 0, amp: 0, glow: 1.0, beam: 0.0, color: 0xff304f },
    paused: { speed: 0, amp: 0, glow: 0.25, beam: 0.0, color: 0x5b6b80 },
  };

  function crawler(canvas) {
    if (!window.THREE || !canvas) return null;
    const ctx = base(canvas, 38, [0, 2.9, 7.4]);
    const { T, scene, cam } = ctx;
    cam.lookAt(0, 0.55, 0);
    scene.add(new T.AmbientLight(0x4a6a8a, 0.9));
    const key = new T.DirectionalLight(0x9fd8ff, 1.3); key.position.set(3, 6, 5); scene.add(key);
    const under = new T.PointLight(0x00a8ff, 2, 14); under.position.set(0, 0.6, 2.5); scene.add(under);
    const metal = new T.MeshStandardMaterial({ color: 0x121b30, metalness: 0.85, roughness: 0.32 });
    const trim = new T.MeshStandardMaterial({ color: 0x1b2a4a, metalness: 0.9, roughness: 0.25 });
    const glow = new T.MeshStandardMaterial({ color: 0x00a8ff, emissive: 0x00a8ff, emissiveIntensity: 1 });

    const grid = new T.GridHelper(16, 32, 0x0a4a80, 0x0a2342); scene.add(grid);
    const root = new T.Group(); root.position.y = 0.65; scene.add(root);
    const body = new T.Group(); root.add(body);
    const torso = new T.Mesh(new T.SphereGeometry(1, small ? 16 : 28, small ? 12 : 20), metal); torso.scale.set(1.5, 0.55, 1.1); body.add(torso);
    const dome = new T.Mesh(new T.SphereGeometry(0.8, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), trim); dome.position.y = 0.3; dome.scale.set(1.2, 0.7, 1); body.add(dome);
    const eyes = [-0.28, 0.28].map((x) => { const m = new T.Mesh(new T.SphereGeometry(0.09, 12, 10), glow); m.position.set(x, 0.12, 0.95); body.add(m); return m; });
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
    const g2 = cv.getContext('2d'); g2.font = 'italic 800 86px sans-serif'; g2.fillStyle = '#e8f6ff'; g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.fillText('ETI', 128, 66);
    const ins = new T.Mesh(new T.PlaneGeometry(1.0, 0.5), new T.MeshBasicMaterial({ map: new T.CanvasTexture(cv), transparent: true }));
    ins.rotation.x = -Math.PI / 2; ins.position.y = 0.64; body.add(ins);

    const seg = (len, r) => { const m = new T.Mesh(new T.CylinderGeometry(r, r * 0.8, len, 8), metal); m.rotation.z = Math.PI / 2; m.position.x = len / 2; return m; };
    const legs = [];
    for (let i = 0; i < 8; i++) {
      const side = i < 4 ? 1 : -1, idx = i % 4;
      const hip = new T.Group(); hip.position.set((idx - 1.5) * 0.55, -0.05, side * 0.78);
      hip.rotation.y = side > 0 ? -Math.PI / 2 + (idx - 1.5) * 0.35 : Math.PI / 2 - (idx - 1.5) * 0.35;
      hip.add(seg(1.0, 0.07));
      const knee = new T.Group(); knee.position.x = 1.0; hip.add(knee);
      knee.add(new T.Mesh(new T.SphereGeometry(0.1, 10, 8), glow));
      const lower = seg(1.35, 0.055); knee.add(lower);
      body.add(hip);
      legs.push({ hip, knee, phase: (idx % 2 ? Math.PI : 0) + (side > 0 ? 0 : Math.PI / 2) + idx * 0.4 });
    }
    const beamGroup = new T.Group(); beamGroup.position.set(0, 0.05, 1.05); beamGroup.rotation.x = -0.9; body.add(beamGroup);
    const beamMat = new T.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide });
    const beam = new T.Mesh(new T.ConeGeometry(0.9, 2.2, 24, 1, true), beamMat); beam.position.y = -1.1; beamGroup.add(beam);

    let cur = Object.assign({}, POSE.idle), tgt = POSE.idle, name = 'idle';
    const col = new T.Color(POSE.idle.color), tcol = new T.Color(POSE.idle.color);
    let ph = 0, yaw = 0;
    const dragging = drag(canvas, (dx) => { yaw += dx * 0.01; ctx.render(); });

    loop(ctx, (dt, t) => {
      const k = reduce ? 1 : 1 - Math.exp(-dt * 4);
      for (const f of ['speed', 'amp', 'glow', 'beam']) cur[f] += (tgt[f] - cur[f]) * k;
      col.lerp(tcol, k);
      ph += dt * cur.speed * 2;
      for (const L of legs) {
        const p = ph + L.phase;
        L.hip.rotation.z = 0.55 + Math.sin(p) * cur.amp;
        L.knee.rotation.z = -1.55 + Math.max(0, Math.cos(p)) * cur.amp * 1.3;
      }
      body.position.y = reduce ? 0 : Math.sin(t * 0.9) * 0.03;
      const pulse = name === 'error' ? 0.6 + 0.4 * Math.sin(t * 6) : 1;
      glow.color.copy(col); glow.emissive.copy(col); glow.emissiveIntensity = cur.glow * pulse;
      under.color.copy(col);
      beamMat.color.copy(col); beamMat.opacity = cur.beam * (reduce ? 1 : 0.75 + 0.25 * Math.sin(t * 5));
      root.rotation.y = yaw + (dragging() || reduce ? 0 : Math.sin(t * 0.25) * 0.3);
    });

    return {
      setState(s) {
        name = POSE[s] ? s : 'idle'; tgt = POSE[name]; tcol.set(tgt.color);
        if (reduce) { cur = Object.assign({}, tgt); col.copy(tcol); }
        ctx.render();
      },
    };
  }

  // ------------------------------------------------------------------------------------------------ globe
  const NODE_COLOR = { ok: 0x00e676, warn: 0xffc247, bad: 0xff304f, off: 0x5b6b80 };

  function globe(canvas, opts) {
    if (!window.THREE || !canvas) return null;
    const onSelect = (opts && opts.onSelect) || function () {};
    const ctx = base(canvas, 40, [0, 0, 3.1]);
    const { T, scene, cam } = ctx;
    const g = new T.Group(); scene.add(g);
    g.add(new T.Mesh(new T.SphereGeometry(0.985, 32, 24), new T.MeshBasicMaterial({ color: 0x030d1c })));
    g.add(new T.Mesh(new T.SphereGeometry(1, 24, 16), new T.MeshBasicMaterial({ color: 0x0b6fc0, wireframe: true, transparent: true, opacity: 0.35 })));
    scene.add(new T.Mesh(new T.SphereGeometry(1.08, 32, 24), new T.MeshBasicMaterial({ color: 0x00a8ff, transparent: true, opacity: 0.08, side: T.BackSide, blending: T.AdditiveBlending, depthWrite: false })));
    const nodes = new T.Group(); g.add(nodes);
    let list = [], yaw = 0.5, pitch = 0.25;
    const place = (lat, lon, r) => { const phi = (90 - lat) * Math.PI / 180, th = (lon + 180) * Math.PI / 180; return new T.Vector3(-r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th)); };

    function setNodes(arr) {
      nodes.clear(); list = arr || [];
      list.forEach((n, i) => {
        const c = NODE_COLOR[n.status] || NODE_COLOR.off;
        const m = new T.Mesh(new T.SphereGeometry(0.035, 12, 10), new T.MeshBasicMaterial({ color: c }));
        m.position.copy(place(n.lat, n.lon, 1.01)); m.userData.i = i; nodes.add(m);
        const ring = new T.Mesh(new T.RingGeometry(0.05, 0.062, 24), new T.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.6, side: T.DoubleSide }));
        ring.position.copy(m.position); ring.lookAt(m.position.clone().multiplyScalar(2)); nodes.add(ring);
      });
      ctx.render();
    }
    const rc = new T.Raycaster(), v2 = new T.Vector2();
    const isDragging = drag(canvas, (dx, dy) => { yaw += dx * 0.008; pitch = Math.max(-1.2, Math.min(1.2, pitch + dy * 0.008)); ctx.render(); }, (e) => {
      const r = canvas.getBoundingClientRect();
      v2.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      rc.setFromCamera(v2, cam);
      const hit = rc.intersectObjects(nodes.children.filter((o) => o.userData.i !== undefined))[0];
      if (hit) onSelect(list[hit.object.userData.i]);
    });
    canvas.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); zoom(e.deltaY > 0 ? 0.15 : -0.15); }, { passive: false });
    function zoom(d) { cam.position.z = Math.max(1.9, Math.min(4.2, cam.position.z + d)); ctx.render(); }

    loop(ctx, (dt) => {
      if (!reduce && !isDragging()) yaw += dt * 0.12;
      g.rotation.y = yaw; g.rotation.x = pitch;
    });
    return { setNodes, zoom };
  }

  window.ETIScenes = { crawler, globe };
})();
