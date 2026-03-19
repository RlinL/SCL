/**
 * MGSM-guided RPL Construction Animation
 *
 * Visualizes the progressive construction process:
 * 1. PTM extracts features Z_init
 * 2. Candidate random bases are sampled from N(0, xi^2)
 * 3. MGSM evaluates each candidate against the acceptance criterion
 * 4. Accepted bases are appended to the RPL; rejected ones fade out
 * 5. Residual ||E|| decreases as more bases are accepted
 * 6. Process terminates when residual < epsilon
 */

(function () {
  const canvas = document.getElementById('mgsm-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // High-DPI support
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    W = rect.width;
    H = rect.height;
  }

  let W, H;
  resize();
  window.addEventListener('resize', resize);

  // Colors
  const COL = {
    bg: '#0D1B2A',
    grid: 'rgba(255,255,255,0.03)',
    text: 'rgba(255,255,255,0.8)',
    textDim: 'rgba(255,255,255,0.45)',
    primary: '#4A7FD4',
    primaryGlow: 'rgba(74,127,212,0.3)',
    accepted: '#27AE60',
    acceptedGlow: 'rgba(39,174,96,0.35)',
    rejected: '#E74C3C',
    rejectedGlow: 'rgba(231,76,60,0.3)',
    candidate: '#F39C12',
    candidateGlow: 'rgba(243,156,18,0.35)',
    ptm: '#8E44AD',
    ptmGlow: 'rgba(142,68,173,0.3)',
    rpl: '#2E5AA8',
    rplGlow: 'rgba(46,90,168,0.25)',
    residualLine: '#E8593E',
    residualFill: 'rgba(232,89,62,0.15)',
    axisLine: 'rgba(255,255,255,0.12)',
  };

  // ===== State =====
  let playing = true;
  let time = 0;
  let phase = 0; // 0=init, 1=sampling, 2=evaluating, 3=decided, 4=pause, 5=done
  let phaseTimer = 0;

  const MAX_ACCEPTED = 14;
  const acceptedBases = [];
  const candidateBases = [];
  let currentBatch = [];
  let batchDecisions = []; // {accepted: bool, base: obj}
  let residualHistory = [];
  let currentResidual = 1.0;
  let iterCount = 0;
  let xiValue = 0.5;

  // Easing
  function ease(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Random helpers
  function rand(a, b) { return Math.random() * (b - a) + a; }
  function randGauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  // Generate a candidate basis point in 2D feature space
  function genCandidate() {
    return {
      x: 0.5 + randGauss() * xiValue * 0.25,
      y: 0.5 + randGauss() * xiValue * 0.25,
      opacity: 0,
      scale: 0,
      status: 'candidate', // candidate, evaluating, accepted, rejected
      evalProgress: 0,
      angle: rand(0, Math.PI * 2),
      speed: rand(0.2, 0.6),
    };
  }

  // Decide acceptance: biased toward accepting early (low residual needs fewer)
  function shouldAccept(base) {
    const distFromCenter = Math.sqrt((base.x - 0.5) ** 2 + (base.y - 0.5) ** 2);
    // Prefer bases that are spread out and not too close to existing ones
    let minDist = Infinity;
    for (const ab of acceptedBases) {
      const d = Math.sqrt((base.x - ab.x) ** 2 + (base.y - ab.y) ** 2);
      if (d < minDist) minDist = d;
    }
    // Higher chance if diverse and reasonably far from center
    const diversity = minDist > 0.08 ? 0.7 : 0.2;
    const alignment = distFromCenter < 0.35 ? 0.6 : 0.3;
    return Math.random() < diversity * alignment + 0.15;
  }

  // Reset animation
  function reset() {
    time = 0;
    phase = 0;
    phaseTimer = 0;
    acceptedBases.length = 0;
    candidateBases.length = 0;
    currentBatch.length = 0;
    batchDecisions.length = 0;
    residualHistory = [{ iter: 0, val: 1.0 }];
    currentResidual = 1.0;
    iterCount = 0;
    xiValue = 0.5;
  }

  // ===== Drawing Helpers =====

  function drawRoundedRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawGlowDot(cx, cy, r, color, glowColor, opacity) {
    ctx.save();
    ctx.globalAlpha = opacity;
    // Glow
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 3);
    grad.addColorStop(0, glowColor);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - r * 3, cy - r * 3, r * 6, r * 6);
    // Core
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  // ===== Layout Regions =====
  // Left: Feature space visualization
  // Right top: RPL bar chart
  // Right bottom: Residual curve

  function getLayout() {
    const pad = 24;
    const featureSize = Math.min(W * 0.48, H - 80);
    return {
      feature: { x: pad, y: 40, w: featureSize, h: H - 80 },
      rpl: { x: featureSize + pad * 2, y: 40, w: W - featureSize - pad * 3, h: (H - 100) * 0.38 },
      residual: { x: featureSize + pad * 2, y: 40 + (H - 100) * 0.42, w: W - featureSize - pad * 3, h: (H - 100) * 0.52 },
      statusBar: { x: pad, y: H - 32, w: W - pad * 2, h: 24 },
    };
  }

  // ===== Draw Feature Space =====
  function drawFeatureSpace(region) {
    const { x, y, w, h } = region;

    // Background panel
    ctx.save();
    drawRoundedRect(x, y, w, h, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Grid lines
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 8; i++) {
      const gx = x + (w * i) / 8;
      const gy = y + (h * i) / 8;
      ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); ctx.stroke();
    }

    // Title
    ctx.fillStyle = COL.text;
    ctx.font = '600 12px Inter';
    ctx.textAlign = 'left';
    ctx.fillText('Feature Space (Z_init projected)', x + 8, y + 16);

    // Xi label
    ctx.fillStyle = COL.textDim;
    ctx.font = '11px Inter';
    ctx.textAlign = 'right';
    ctx.fillText(`\u03BE = ${xiValue.toFixed(2)}`, x + w - 8, y + 16);

    // Draw accepted bases
    for (const base of acceptedBases) {
      const bx = x + base.x * w;
      const by = y + base.y * h;
      drawGlowDot(bx, by, 5, COL.accepted, COL.acceptedGlow, base.opacity);
    }

    // Draw current batch candidates
    for (const base of currentBatch) {
      const bx = x + base.x * w;
      const by = y + base.y * h;
      let color, glow;
      if (base.status === 'candidate') {
        color = COL.candidate; glow = COL.candidateGlow;
      } else if (base.status === 'evaluating') {
        // Pulsing during evaluation
        const pulse = 0.6 + 0.4 * Math.sin(time * 6 + base.angle);
        color = COL.candidate; glow = COL.candidateGlow;
        // Draw evaluation ring
        ctx.beginPath();
        ctx.arc(bx, by, 12 * base.evalProgress, 0, Math.PI * 2 * base.evalProgress);
        ctx.strokeStyle = `rgba(74,127,212,${0.6 * pulse})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (base.status === 'accepted') {
        color = COL.accepted; glow = COL.acceptedGlow;
      } else {
        color = COL.rejected; glow = COL.rejectedGlow;
      }
      drawGlowDot(bx, by, 5 * base.scale, color, glow, base.opacity);

      // Draw X for rejected
      if (base.status === 'rejected' && base.opacity > 0.3) {
        ctx.save();
        ctx.globalAlpha = base.opacity * 0.8;
        ctx.strokeStyle = COL.rejected;
        ctx.lineWidth = 2;
        const s = 4;
        ctx.beginPath(); ctx.moveTo(bx - s, by - s); ctx.lineTo(bx + s, by + s); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx + s, by - s); ctx.lineTo(bx - s, by + s); ctx.stroke();
        ctx.restore();
      }

      // Checkmark for accepted in current batch
      if (base.status === 'accepted' && base.opacity > 0.5) {
        ctx.save();
        ctx.globalAlpha = base.opacity * 0.9;
        ctx.strokeStyle = COL.accepted;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx - 4, by); ctx.lineTo(bx - 1, by + 3); ctx.lineTo(bx + 5, by - 3);
        ctx.stroke();
        ctx.restore();
      }
    }

    ctx.restore();
  }

  // ===== Draw RPL Bar Chart =====
  function drawRPL(region) {
    const { x, y, w, h } = region;

    ctx.save();
    drawRoundedRect(x, y, w, h, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = COL.text;
    ctx.font = '600 12px Inter';
    ctx.textAlign = 'left';
    ctx.fillText('RPL Bases (W_RPL)', x + 8, y + 16);

    ctx.fillStyle = COL.textDim;
    ctx.font = '11px Inter';
    ctx.textAlign = 'right';
    ctx.fillText(`L = ${acceptedBases.length}`, x + w - 8, y + 16);

    // Draw bars
    const barArea = { x: x + 12, y: y + 28, w: w - 24, h: h - 40 };
    const maxBars = MAX_ACCEPTED;
    const barW = Math.min(20, (barArea.w - (maxBars - 1) * 3) / maxBars);
    const gap = 3;
    const startX = barArea.x + (barArea.w - maxBars * (barW + gap)) / 2;

    for (let i = 0; i < maxBars; i++) {
      const bx = startX + i * (barW + gap);
      // Empty slot
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      drawRoundedRect(bx, barArea.y, barW, barArea.h, 3);
      ctx.fill();

      if (i < acceptedBases.length) {
        const base = acceptedBases[i];
        const barH = barArea.h * base.opacity * (0.4 + 0.6 * Math.abs(Math.sin(base.x * 5 + base.y * 3)));
        const grad = ctx.createLinearGradient(bx, barArea.y + barArea.h - barH, bx, barArea.y + barArea.h);
        grad.addColorStop(0, COL.primary);
        grad.addColorStop(1, '#1a3a6c');
        ctx.fillStyle = grad;
        drawRoundedRect(bx, barArea.y + barArea.h - barH, barW, barH, 3);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  // ===== Draw Residual Curve =====
  function drawResidual(region) {
    const { x, y, w, h } = region;

    ctx.save();
    drawRoundedRect(x, y, w, h, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.02)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = COL.text;
    ctx.font = '600 12px Inter';
    ctx.textAlign = 'left';
    ctx.fillText('Residual ||E||_F', x + 8, y + 16);

    const chartArea = { x: x + 40, y: y + 28, w: w - 56, h: h - 52 };

    // Axes
    ctx.strokeStyle = COL.axisLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartArea.x, chartArea.y);
    ctx.lineTo(chartArea.x, chartArea.y + chartArea.h);
    ctx.lineTo(chartArea.x + chartArea.w, chartArea.y + chartArea.h);
    ctx.stroke();

    // Y-axis labels
    ctx.fillStyle = COL.textDim;
    ctx.font = '10px Source Code Pro';
    ctx.textAlign = 'right';
    for (let v = 0; v <= 1; v += 0.25) {
      const ly = chartArea.y + chartArea.h * (1 - v);
      ctx.fillText(v.toFixed(2), chartArea.x - 4, ly + 3);
      // Grid line
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.beginPath(); ctx.moveTo(chartArea.x, ly); ctx.lineTo(chartArea.x + chartArea.w, ly); ctx.stroke();
    }

    // Epsilon threshold line
    const epsilon = 0.08;
    const epsY = chartArea.y + chartArea.h * (1 - epsilon);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(39,174,96,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(chartArea.x, epsY); ctx.lineTo(chartArea.x + chartArea.w, epsY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(39,174,96,0.7)';
    ctx.font = '10px Inter';
    ctx.textAlign = 'left';
    ctx.fillText('\u03B5', chartArea.x + chartArea.w + 4, epsY + 3);

    // X-axis label
    ctx.fillStyle = COL.textDim;
    ctx.font = '10px Inter';
    ctx.textAlign = 'center';
    ctx.fillText('Iteration', chartArea.x + chartArea.w / 2, chartArea.y + chartArea.h + 18);

    // Plot residual curve
    if (residualHistory.length > 1) {
      const maxIter = Math.max(MAX_ACCEPTED, residualHistory[residualHistory.length - 1].iter);

      // Filled area
      ctx.beginPath();
      ctx.moveTo(chartArea.x, chartArea.y + chartArea.h);
      for (const pt of residualHistory) {
        const px = chartArea.x + (pt.iter / maxIter) * chartArea.w;
        const py = chartArea.y + chartArea.h * (1 - pt.val);
        ctx.lineTo(px, py);
      }
      ctx.lineTo(chartArea.x + (residualHistory[residualHistory.length - 1].iter / maxIter) * chartArea.w, chartArea.y + chartArea.h);
      ctx.closePath();
      ctx.fillStyle = COL.residualFill;
      ctx.fill();

      // Line
      ctx.beginPath();
      for (let i = 0; i < residualHistory.length; i++) {
        const pt = residualHistory[i];
        const px = chartArea.x + (pt.iter / maxIter) * chartArea.w;
        const py = chartArea.y + chartArea.h * (1 - pt.val);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = COL.residualLine;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Current point
      const lastPt = residualHistory[residualHistory.length - 1];
      const lastPx = chartArea.x + (lastPt.iter / maxIter) * chartArea.w;
      const lastPy = chartArea.y + chartArea.h * (1 - lastPt.val);
      drawGlowDot(lastPx, lastPy, 4, COL.residualLine, 'rgba(232,89,62,0.4)', 1);

      // Value label
      ctx.fillStyle = COL.text;
      ctx.font = '600 11px Source Code Pro';
      ctx.textAlign = 'left';
      ctx.fillText(lastPt.val.toFixed(3), lastPx + 8, lastPy - 4);
    }

    ctx.restore();
  }

  // ===== Draw Status Bar =====
  function drawStatus(region) {
    const { x, y, w } = region;
    ctx.fillStyle = COL.textDim;
    ctx.font = '11px Inter';
    ctx.textAlign = 'left';

    let statusText = '';
    if (phase === 0) statusText = 'Initializing: PTM feature extraction...';
    else if (phase === 1) statusText = `Sampling ${currentBatch.length} candidate bases from N(0, \u03BE\u00B2)...`;
    else if (phase === 2) statusText = 'Evaluating MGSM acceptance criterion...';
    else if (phase === 3) {
      const accepted = batchDecisions.filter(d => d.accepted).length;
      const rejected = batchDecisions.filter(d => !d.accepted).length;
      statusText = `Batch result: ${accepted} accepted, ${rejected} rejected`;
    }
    else if (phase === 5) statusText = `\u2714 RPL construction complete! L = ${acceptedBases.length} bases, ||E||_F < \u03B5`;

    ctx.fillText(statusText, x, y + 6);

    // Iteration counter on right
    ctx.textAlign = 'right';
    ctx.fillText(`Iter: ${iterCount}`, x + w, y + 6);
  }

  // ===== Phase Logic =====
  const PHASE_DURATIONS = [1.5, 1.2, 2.0, 1.2, 0.5]; // seconds per phase

  function updatePhase(dt) {
    phaseTimer += dt;

    if (phase === 0) {
      // Init phase - just wait
      if (phaseTimer > PHASE_DURATIONS[0]) {
        phase = 1;
        phaseTimer = 0;
        spawnBatch();
      }
    }
    else if (phase === 1) {
      // Animate candidates appearing
      for (const b of currentBatch) {
        b.opacity = Math.min(1, b.opacity + dt * 3);
        b.scale = Math.min(1, b.scale + dt * 3);
      }
      if (phaseTimer > PHASE_DURATIONS[1]) {
        phase = 2;
        phaseTimer = 0;
        for (const b of currentBatch) b.status = 'evaluating';
      }
    }
    else if (phase === 2) {
      // Evaluation phase - ring animation
      for (const b of currentBatch) {
        b.evalProgress = Math.min(1, b.evalProgress + dt * 1.2);
      }
      if (phaseTimer > PHASE_DURATIONS[2]) {
        phase = 3;
        phaseTimer = 0;
        decideBatch();
      }
    }
    else if (phase === 3) {
      // Show decisions, fade out rejected
      for (const b of currentBatch) {
        if (b.status === 'rejected') {
          b.opacity = Math.max(0, b.opacity - dt * 2);
          b.scale = Math.max(0, b.scale - dt * 1.5);
        }
      }
      if (phaseTimer > PHASE_DURATIONS[3]) {
        // Move accepted to permanent list
        for (const b of currentBatch) {
          if (b.status === 'accepted') {
            acceptedBases.push({ ...b });
          }
        }
        // Update residual
        iterCount++;
        currentResidual = Math.max(0.02, currentResidual * (0.65 + Math.random() * 0.2));
        residualHistory.push({ iter: iterCount, val: currentResidual });

        // Update xi occasionally
        if (iterCount % 3 === 0) {
          xiValue = Math.min(1.2, xiValue + 0.1);
        }

        currentBatch.length = 0;
        batchDecisions.length = 0;

        if (acceptedBases.length >= MAX_ACCEPTED || currentResidual < 0.08) {
          phase = 5; // done
          phaseTimer = 0;
        } else {
          phase = 4; // pause
          phaseTimer = 0;
        }
      }
    }
    else if (phase === 4) {
      if (phaseTimer > PHASE_DURATIONS[4]) {
        phase = 1;
        phaseTimer = 0;
        spawnBatch();
      }
    }
    else if (phase === 5) {
      // Done - blink accepted bases gently
      if (phaseTimer > 4) {
        reset();
      }
    }
  }

  function spawnBatch() {
    currentBatch.length = 0;
    const batchSize = 3 + Math.floor(Math.random() * 3); // 3-5 candidates
    for (let i = 0; i < batchSize; i++) {
      currentBatch.push(genCandidate());
    }
  }

  function decideBatch() {
    batchDecisions.length = 0;
    let anyAccepted = false;
    for (const b of currentBatch) {
      const accepted = shouldAccept(b);
      b.status = accepted ? 'accepted' : 'rejected';
      batchDecisions.push({ accepted, base: b });
      if (accepted) anyAccepted = true;
    }
    // Ensure at least one accepted to keep animation moving
    if (!anyAccepted && currentBatch.length > 0) {
      const idx = Math.floor(Math.random() * currentBatch.length);
      currentBatch[idx].status = 'accepted';
      batchDecisions[idx].accepted = true;
    }
  }

  // ===== Main Loop =====
  let lastTime = performance.now();

  function frame(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    if (playing) {
      time += dt;
      updatePhase(dt);
    }

    // Clear
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);

    const layout = getLayout();
    drawFeatureSpace(layout.feature);
    drawRPL(layout.rpl);
    drawResidual(layout.residual);
    drawStatus(layout.statusBar);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // ===== Controls =====
  const btnPlay = document.getElementById('btn-play');
  const btnRestart = document.getElementById('btn-restart');

  if (btnPlay) {
    btnPlay.addEventListener('click', () => {
      playing = !playing;
      btnPlay.innerHTML = playing ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    });
  }

  if (btnRestart) {
    btnRestart.addEventListener('click', () => {
      reset();
      playing = true;
      if (btnPlay) btnPlay.innerHTML = '<i class="fas fa-pause"></i>';
    });
  }
})();
