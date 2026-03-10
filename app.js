const boardWrapper = document.getElementById("boardWrapper");
const board = document.getElementById("board");
const centerStage = document.getElementById("centerStage");
const camera = document.getElementById("camera");
const captureBtn = document.getElementById("captureBtn");
const flipBtn = document.getElementById("flipBtn");
const torchBtn = document.getElementById("torchBtn");
const uploadBtn = document.getElementById("uploadBtn");
const uploadInput = document.getElementById("uploadInput");
const recenterBtn = document.getElementById("recenterBtn");
const statusText = document.getElementById("statusText");

const lightbox = document.getElementById("lightbox");
const closeLightboxBtn = document.getElementById("closeLightboxBtn");
const lightboxImage = document.getElementById("lightboxImage");
const downloadBtn = document.getElementById("downloadBtn");

const snaps = [];
let stream = null;
let videoTrack = null;
let imageCapture = null;
let facingMode = "environment";
let torchEnabled = false;
let refreshTimer = null;
let currentDeviceId = null;
let videoInputDevices = [];
let preferredBackDeviceId = null;
let preferredFrontDeviceId = null;
let cameraRequestSeq = 0;

const REFRESH_INTERVAL_MS = 8000;
const RECENTER_THRESHOLD_PX = 180;
const IS_ANDROID = /android/i.test(navigator.userAgent || "");

function apiUrl(path) {
  if (path === "/api/snaps") {
    return "./api/snaps.php";
  }

  return path;
}

function getViewportCenterDistance() {
  const currentCenterX = boardWrapper.scrollLeft + boardWrapper.clientWidth / 2;
  const currentCenterY = boardWrapper.scrollTop + boardWrapper.clientHeight / 2;
  const targetCenterX = board.clientWidth / 2;
  const targetCenterY = board.clientHeight / 2;

  return Math.hypot(currentCenterX - targetCenterX, currentCenterY - targetCenterY);
}

function updateRecenterVisibility() {
  const distance = getViewportCenterDistance();
  recenterBtn.classList.toggle("visible", distance > RECENTER_THRESHOLD_PX);
}

function centerViewport(behavior = "auto") {
  const x = board.clientWidth / 2 - boardWrapper.clientWidth / 2;
  const y = board.clientHeight / 2 - boardWrapper.clientHeight / 2;
  boardWrapper.scrollTo({ left: x, top: y, behavior });

  window.setTimeout(updateRecenterVisibility, 80);
}

function setStatus(message) {
  statusText.textContent = message;
}

function setTorchButton() {
  torchBtn.textContent = torchEnabled ? "Blitz An" : "Blitz Aus";
}

function setFlipButton() {
  flipBtn.textContent = facingMode === "environment" ? "Selfie" : "Back";
}

function inferFacingFromCurrentTrack() {
  if (!videoTrack) {
    return null;
  }

  const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
  if (settings.facingMode === "user" || settings.facingMode === "environment") {
    return settings.facingMode;
  }

  if (settings.deviceId) {
    const chosen = videoInputDevices.find((device) => device.deviceId === settings.deviceId);
    const inferred = chosen ? detectFacingFromLabel(chosen.label) : null;
    return inferred || null;
  }

  return null;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function refreshVideoDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    videoInputDevices = [];
    return;
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  videoInputDevices = devices.filter((device) => device.kind === "videoinput");
}

function detectFacingFromLabel(label) {
  const text = (label || "").toLowerCase();
  if (!text) {
    return null;
  }

  if (text.includes("front") || text.includes("user") || text.includes("facetime") || text.includes("selfie")) {
    return "user";
  }

  if (text.includes("back") || text.includes("rear") || text.includes("environment") || text.includes("wide")) {
    return "environment";
  }

  return null;
}

function scoreDeviceForFacing(label, targetFacing) {
  const text = (label || "").toLowerCase();

  if (!text) {
    return 1;
  }

  if (targetFacing === "user") {
    let score = 0;
    if (text.includes("front") || text.includes("facetime") || text.includes("user") || text.includes("selfie")) {
      score += 120;
    }
    if (text.includes("back") || text.includes("rear") || text.includes("tele") || text.includes("ultra")) {
      score -= 80;
    }
    return score;
  }

  let score = 0;
  if (text.includes("back") || text.includes("rear") || text.includes("environment")) {
    score += 90;
  }
  if (text === "back camera" || text.includes("main")) {
    score += 80;
  }
  if (text.includes("wide") && !text.includes("ultra")) {
    score += 55;
  }
  if (text.includes("ultra")) {
    score -= 35;
  }
  if (text.includes("tele")) {
    score -= 85;
  }
  if (text.includes("front") || text.includes("facetime") || text.includes("user")) {
    score -= 120;
  }
  return score;
}

function getDeviceCandidatesForFacing(targetFacing, excludedId = null) {
  if (!videoInputDevices.length) {
    return [];
  }

  const ranked = [...videoInputDevices]
    .filter((device) => device.deviceId !== excludedId)
    .map((device) => ({
      device,
      score: scoreDeviceForFacing(device.label, targetFacing)
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.device);

  return ranked;
}

function refreshPreferredDeviceIds() {
  const backCandidates = getDeviceCandidatesForFacing("environment");
  const frontCandidates = getDeviceCandidatesForFacing("user");

  preferredBackDeviceId = backCandidates[0]?.deviceId || preferredBackDeviceId;
  preferredFrontDeviceId = frontCandidates[0]?.deviceId || preferredFrontDeviceId;
}

function pickDeviceIdForFacing(targetFacing, excludedId = null) {
  if (!videoInputDevices.length) {
    return null;
  }

  const labeled = videoInputDevices.find((device) =>
    device.deviceId !== excludedId && detectFacingFromLabel(device.label) === targetFacing
  );
  if (labeled) {
    return labeled.deviceId;
  }

  if (videoInputDevices.length > 1) {
    if (targetFacing === "user") {
      return videoInputDevices.find((device) => device.deviceId !== excludedId)?.deviceId || null;
    }
    return [...videoInputDevices].reverse().find((device) => device.deviceId !== excludedId)?.deviceId || null;
  }

  return null;
}

async function waitForUsableVideo(timeoutMs = 1400) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (camera.readyState >= 2 && camera.videoWidth > 0 && camera.videoHeight > 0) {
      return;
    }
    await delay(60);
  }

  throw new Error("Video stream not ready");
}

async function applyTrackQualityConstraints(track) {
  if (!track || !track.applyConstraints || !track.getCapabilities) {
    return;
  }

  const capabilities = track.getCapabilities() || {};
  const advanced = [];

  if (capabilities.focusMode) {
    advanced.push({ focusMode: "continuous" });
  }
  if (capabilities.exposureMode) {
    advanced.push({ exposureMode: "continuous" });
  }
  if (capabilities.whiteBalanceMode) {
    advanced.push({ whiteBalanceMode: "continuous" });
  }

  if (advanced.length) {
    try {
      await track.applyConstraints({ advanced });
    } catch (_error) {
      // Some browsers reject unsupported advanced keys even when advertised.
    }
  }
}

function clearSnapNodes() {
  for (const node of board.querySelectorAll(".snap-item")) {
    node.remove();
  }
}

function getSpiralPosition(index) {
  if (index === 0) {
    return { x: 0, y: -240, r: -6 };
  }

  const step = 210;
  const angle = index * 0.9;
  const radius = 230 + Math.sqrt(index) * step;
  const jitterX = ((index * 37) % 35) - 17;
  const jitterY = ((index * 53) % 35) - 17;
  return {
    x: Math.cos(angle) * radius + jitterX,
    y: Math.sin(angle) * radius + jitterY,
    r: ((index * 19) % 20) - 10
  };
}

function renderSnaps() {
  clearSnapNodes();

  const centerX = board.clientWidth / 2;
  const centerY = board.clientHeight / 2;

  snaps.forEach((snap, index) => {
    const pos = getSpiralPosition(index + 1);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "snap-item";
    item.style.left = `${centerX + pos.x}px`;
    item.style.top = `${centerY + pos.y}px`;
    item.style.transform = `translate(-50%, -50%) rotate(${pos.r}deg)`;
    item.style.zIndex = String(2 + index);

    const img = document.createElement("img");
    img.src = snap.url;
    img.alt = `Foto ${index + 1}`;
    img.loading = "lazy";
    item.appendChild(img);

    item.addEventListener("click", () => openLightbox(snap));
    board.appendChild(item);
  });

  board.appendChild(centerStage);
}

function syncSnaps(nextSnaps) {
  const normalized = [...nextSnaps].sort((a, b) => a.createdAt - b.createdAt);
  const currentIds = snaps.map((snap) => snap.id).join("|");
  const nextIds = normalized.map((snap) => snap.id).join("|");

  if (currentIds === nextIds) {
    return false;
  }

  snaps.splice(0, snaps.length, ...normalized);
  return true;
}

function stopCamera() {
  if (!stream) {
    return;
  }

  stream.getTracks().forEach((track) => track.stop());
  stream = null;
  videoTrack = null;
  imageCapture = null;
}

async function startCamera() {
  const requestId = ++cameraRequestSeq;

  stopCamera();
  camera.pause();
  camera.srcObject = null;
  await delay(80);

  torchEnabled = false;
  setTorchButton();

  const requestedFacing = facingMode;
  await refreshVideoDevices();
  refreshPreferredDeviceIds();

  const preferredDeviceId = requestedFacing === "environment"
    ? preferredBackDeviceId
    : preferredFrontDeviceId;

  const candidateIds = getDeviceCandidatesForFacing(requestedFacing)
    .filter((device) => {
      if (requestedFacing !== "environment") {
        return true;
      }
      return scoreDeviceForFacing(device.label, "environment") >= 0;
    })
    .map((device) => device.deviceId)
    .filter(Boolean);

  const prioritizedDeviceIds = Array.from(new Set([
    preferredDeviceId,
    ...candidateIds,
    pickDeviceIdForFacing(requestedFacing, currentDeviceId)
  ].filter(Boolean)));

  const attempts = [
    ...prioritizedDeviceIds.map((deviceId) => ({ deviceId })),
    { facing: requestedFacing, strict: false },
    ...(IS_ANDROID ? [] : [{ facing: requestedFacing, strict: true }]),
    { facing: null, strict: false }
  ];

  for (const attempt of attempts) {
    if (attempt.deviceId === null) {
      continue;
    }

    try {
      const video = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 60 }
      };

      if (attempt.deviceId) {
        video.deviceId = { exact: attempt.deviceId };
      } else if (attempt.facing) {
        video.facingMode = attempt.strict
          ? { exact: attempt.facing }
          : { ideal: attempt.facing };
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video
      });

      if (requestId !== cameraRequestSeq) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      camera.srcObject = null;
      await delay(120);
      camera.srcObject = stream;
      camera.playsInline = true;
      camera.muted = true;

      await Promise.race([
        camera.play().catch(() => undefined),
        delay(600)
      ]);
      await waitForUsableVideo();

      videoTrack = stream.getVideoTracks()[0] || null;
      await applyTrackQualityConstraints(videoTrack);
      if (window.ImageCapture && videoTrack) {
        imageCapture = new ImageCapture(videoTrack);
      } else {
        imageCapture = null;
      }

      const settings = videoTrack && videoTrack.getSettings ? videoTrack.getSettings() : {};
      currentDeviceId = settings.deviceId || attempt.deviceId || currentDeviceId;
      if (settings.facingMode === "user" || settings.facingMode === "environment") {
        facingMode = settings.facingMode;
      } else if (attempt.deviceId) {
        const chosen = videoInputDevices.find((device) => device.deviceId === attempt.deviceId);
        const inferred = chosen ? detectFacingFromLabel(chosen.label) : null;
        facingMode = inferred || requestedFacing;
      } else if (attempt.facing) {
        facingMode = attempt.facing;
      }

      if (facingMode === "environment" && currentDeviceId) {
        preferredBackDeviceId = preferredBackDeviceId || currentDeviceId;
      }
      if (facingMode === "user" && currentDeviceId) {
        preferredFrontDeviceId = preferredFrontDeviceId || currentDeviceId;
      }

      setFlipButton();
      setStatus("Kamera bereit.");
      return;
    } catch (error) {
      stopCamera();
      camera.pause();
      camera.srcObject = null;
      await delay(140);
    }
  }

  setFlipButton();
  setStatus("Kamera konnte nicht gestartet werden. Bitte Berechtigungen prüfen.");
}

async function forceStartCameraForFacing(targetFacing) {
  facingMode = targetFacing;
  stopCamera();
  camera.pause();
  camera.srcObject = null;
  await delay(160);

  const sequence = [
    { strict: true },
    { strict: false },
    { strict: false, generic: true }
  ];

  for (const step of sequence) {
    try {
      const video = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 60 }
      };

      if (!step.generic) {
        video.facingMode = step.strict
          ? { exact: targetFacing }
          : { ideal: targetFacing };
      }

      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video
      });

      stream = nextStream;
      camera.srcObject = stream;
      await Promise.race([camera.play().catch(() => undefined), delay(700)]);
      await waitForUsableVideo();

      videoTrack = stream.getVideoTracks()[0] || null;
      await applyTrackQualityConstraints(videoTrack);
      imageCapture = window.ImageCapture && videoTrack ? new ImageCapture(videoTrack) : null;

      const currentFacing = inferFacingFromCurrentTrack();
      if (currentFacing === targetFacing || step.generic) {
        facingMode = currentFacing || targetFacing;
        setFlipButton();
        setStatus("Kamera bereit.");
        return true;
      }

      stopCamera();
      await delay(120);
    } catch (_error) {
      stopCamera();
      await delay(120);
    }
  }

  return false;
}

async function toggleFacingMode() {
  const targetFacing = facingMode === "environment" ? "user" : "environment";
  facingMode = targetFacing;
  flipBtn.disabled = true;
  setFlipButton();
  await startCamera();

  const activeFacing = inferFacingFromCurrentTrack();
  if (activeFacing !== targetFacing) {
    await forceStartCameraForFacing(targetFacing);
  }

  flipBtn.disabled = false;
}

async function toggleTorch() {
  if (!videoTrack) {
    setStatus("Keine aktive Kamera.");
    return;
  }

  const capabilities = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
  if (!capabilities.torch) {
    setStatus("Blitz wird auf diesem Gerät/Browser nicht unterstützt.");
    return;
  }

  try {
    torchEnabled = !torchEnabled;
    await videoTrack.applyConstraints({ advanced: [{ torch: torchEnabled }] });
    setTorchButton();
    setStatus(torchEnabled ? "Blitz erzwungen: AN" : "Blitz erzwungen: AUS");
  } catch (error) {
    setStatus("Blitz konnte nicht umgeschaltet werden.");
  }
}

function captureFromVideo() {
  const canvas = document.createElement("canvas");
  const width = camera.videoWidth || 1280;
  const height = camera.videoHeight || 960;
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  context.drawImage(camera, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("No image blob created"));
        return;
      }
      resolve(blob);
    }, "image/jpeg", 0.92);
  });
}

async function grabPhotoBlob() {
  if (imageCapture) {
    try {
      return await imageCapture.takePhoto();
    } catch (error) {
      return captureFromVideo();
    }
  }

  return captureFromVideo();
}

async function uploadPhoto(blob) {
  const formData = new FormData();
  formData.append("photo", blob, `snap-${Date.now()}.jpg`);

  const response = await fetch(apiUrl("/api/snaps"), {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw new Error("Upload failed");
  }

  return response.json();
}

async function captureAndSave() {
  if (!stream) {
    setStatus("Kamera ist nicht aktiv.");
    return;
  }

  try {
    setStatus("Speichere nach /snaps ...");
    // Short settle delay reduces hand-shake blur right after button tap.
    await delay(120);
    const blob = await grabPhotoBlob();
    await uploadPhoto(blob);
    await loadSnaps({ silent: true });
    setStatus("Foto gespeichert.");
  } catch (error) {
    setStatus("Foto konnte nicht gespeichert werden.");
  }
}

async function loadSnaps(options = {}) {
  const { silent = false } = options;

  try {
    const response = await fetch(apiUrl("/api/snaps"));
    if (!response.ok) {
      throw new Error("Failed");
    }

    const data = await response.json();
    const hasChanges = syncSnaps(data);
    if (hasChanges) {
      renderSnaps();
      if (!silent) {
        setStatus("Galerie aktualisiert.");
      }
    } else if (!snaps.length && !silent) {
      setStatus("Noch keine Bilder gespeichert.");
    }
  } catch (error) {
    setStatus("Bisherige Bilder konnten nicht geladen werden.");
  }
}

async function uploadSelectedFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
  if (!files.length) {
    return;
  }

  uploadBtn.disabled = true;
  setStatus(`Lade ${files.length} Bild${files.length > 1 ? "er" : ""} hoch ...`);

  try {
    for (const file of files) {
      await uploadPhoto(file);
    }
    await loadSnaps({ silent: true });
    setStatus("Upload abgeschlossen.");
  } catch (error) {
    setStatus("Upload fehlgeschlagen.");
  } finally {
    uploadBtn.disabled = false;
    uploadInput.value = "";
  }
}

function startRefreshLoop() {
  stopRefreshLoop();
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      loadSnaps({ silent: true });
    }
  }, REFRESH_INTERVAL_MS);
}

function stopRefreshLoop() {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function openLightbox(snap) {
  lightboxImage.src = snap.url;
  downloadBtn.href = snap.url;
  downloadBtn.download = snap.id || "snap.jpg";
  if (!lightbox.open) {
    lightbox.showModal();
  }
}

function closeLightbox() {
  if (lightbox.open) {
    lightbox.close();
  }
}

captureBtn.addEventListener("click", captureAndSave);
flipBtn.addEventListener("click", toggleFacingMode);
torchBtn.addEventListener("click", toggleTorch);
uploadBtn.addEventListener("click", () => uploadInput.click());
uploadInput.addEventListener("change", () => uploadSelectedFiles(uploadInput.files));
recenterBtn.addEventListener("click", () => centerViewport("smooth"));
closeLightboxBtn.addEventListener("click", closeLightbox);
lightbox.addEventListener("click", (event) => {
  if (event.target === lightbox) {
    closeLightbox();
  }
});

boardWrapper.addEventListener("scroll", updateRecenterVisibility, { passive: true });
window.addEventListener("resize", () => {
  centerViewport("auto");
});
window.addEventListener("beforeunload", () => {
  stopRefreshLoop();
  stopCamera();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    loadSnaps({ silent: true });
  }
});

(async function init() {
  requestAnimationFrame(() => centerViewport("auto"));
  window.setTimeout(() => centerViewport("auto"), 180);
  setTorchButton();
  setFlipButton();
  await loadSnaps({ silent: true });
  startRefreshLoop();
  await startCamera();
})();
