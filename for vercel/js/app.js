/**
 * ============================================================================
 * FRONTEND: APP.JS - Main Standalone Application Controller (PackGuard AI)
 * ============================================================================
 * Fitur Utama:
 * 1. Otentikasi Petugas Packing via OTP Email & Audit Trail
 * 2. Hands-Free Continuous Auto-Cut Packing Mode (Rekam beruntun tanpa sentuh laptop)
 * 3. Watermark Real-time Bersih: RESI | TANGGAL JAM WIB (Tanpa nama petugas di video)
 * 4. Scanner Cerdas Universal (Native BarcodeDetector + ZXing TryHarder Center-Crop)
 * 5. Ekstraksi Otomatis Resi (AI Vision / Database Match tanpa harus upload Excel)
 * 6. Pencatatan Petugas Packing ke Google Sheets Admin
 * ============================================================================
 */

// ============================================================================
// STATE GLOBAL APLIKASI
// ============================================================================
const STORAGE_PACKER_KEY = 'packguard_packer_session';
let currentPacker = null;

// Kamera & Media Stream
let currentStream = null;
let currentFacingMode = 'environment';
let availableVideoDevices = [];
let isScanningActive = true;
let barcodeScanInterval = null;
let nativeBarcodeDetector = null;
let zxingMultiReader = null;
let scanCanvas = null;
let isScanningFrame = false;

// Perekaman Video Standar (Manual)
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordTimerInterval = null;
let recordSeconds = 0;

// Mode Packing Beruntun (Hands-Free Continuous Auto-Cut)
let isContinuousMode = false;
let continuousPackageCount = 0;
let isProcessingAutoCut = false;
let activeContinuousResi = '';

// Order Data & Dashboard
let currentOrderData = null;
let parsedExcelData = [];
let dashboardCache = [];

// Audio Synthesizer (Beep & Chime tanpa file eksternal)
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playBeep(freq = 880, duration = 0.12) {
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {
    console.log('Audio feedback error', e);
  }
}

function playSuccessChime() {
  playBeep(523.25, 0.1);
  setTimeout(() => playBeep(659.25, 0.1), 100);
  setTimeout(() => playBeep(783.99, 0.2), 200);
}

// ============================================================================
// 1. INISIALISASI & TAB NAVIGATION
// ============================================================================
document.addEventListener('DOMContentLoaded', function() {
  initBarcodeEngines();
  initApiSettingsInput();
  initPackerAuth();
  checkInitialCameraState();
  startWatermarkClock();
  setupKeyboardShortcuts();
});

function initBarcodeEngines() {
  if ('BarcodeDetector' in window) {
    try {
      nativeBarcodeDetector = new BarcodeDetector({
        formats: ['code_128', 'qr_code', 'ean_13', 'code_39', 'upc_a', 'data_matrix']
      });
      console.log('✓ Native BarcodeDetector aktif');
    } catch (e) {
      console.warn('Native BarcodeDetector init error:', e);
    }
  }

  if (typeof ZXing !== 'undefined') {
    try {
      const hints = new Map();
      const formats = [
        ZXing.BarcodeFormat.CODE_128,
        ZXing.BarcodeFormat.QR_CODE,
        ZXing.BarcodeFormat.EAN_13,
        ZXing.BarcodeFormat.CODE_39,
        ZXing.BarcodeFormat.UPC_A,
        ZXing.BarcodeFormat.DATA_MATRIX
      ];
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      zxingMultiReader = new ZXing.BrowserMultiFormatReader(hints);
      console.log('✓ ZXing MultiFormatReader siap dengan TryHarder');
    } catch (e) {
      console.warn('ZXing init error, fallback default:', e);
      try {
        zxingMultiReader = new ZXing.BrowserMultiFormatReader();
      } catch (err) {}
    }
  }
}

function switchTab(tabId, btnElement) {
  document.querySelectorAll('.tab-pane').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));

  const targetTab = document.getElementById(tabId);
  if (targetTab) targetTab.classList.add('active');
  if (btnElement) btnElement.classList.add('active');

  if (tabId === 'packing-tab') {
    if (!currentStream) checkInitialCameraState();
  } else if (tabId === 'dashboard-tab') {
    loadDashboardData();
  } else if (tabId === 'system-tab') {
    checkSystemStatus();
  }
}

// ============================================================================
// 2. OTENTIKASI PETUGAS PACKING & EMAIL OTP
// ============================================================================

function initPackerAuth() {
  const saved = localStorage.getItem(STORAGE_PACKER_KEY);
  if (saved) {
    try {
      currentPacker = JSON.parse(saved);
      if (currentPacker && currentPacker.nama && currentPacker.email) {
        updatePackerHeaderUi();
        hidePackerModal();
        return;
      }
    } catch (e) {}
  }

  // Jika belum login, tampilkan modal otentikasi
  showPackerModal();
}

function showPackerModal() {
  const modal = document.getElementById('packerModalBackdrop');
  if (modal) modal.style.display = 'flex';
  const badge = document.getElementById('packerHeaderBadge');
  if (badge) badge.style.display = 'none';
}

function hidePackerModal() {
  const modal = document.getElementById('packerModalBackdrop');
  if (modal) modal.style.display = 'none';
}

function updatePackerHeaderUi() {
  const badge = document.getElementById('packerHeaderBadge');
  const nameSpan = document.getElementById('packerBadgeName');
  if (badge && nameSpan && currentPacker) {
    nameSpan.innerText = currentPacker.nama;
    badge.style.display = 'inline-flex';
  }
}

async function submitRequestOtp() {
  const nameInput = document.getElementById('packerNameInput');
  const emailInput = document.getElementById('packerEmailInput');
  const btn = document.getElementById('btnSendOtp');

  const nama = nameInput ? nameInput.value.trim() : '';
  const email = emailInput ? emailInput.value.trim().toLowerCase() : '';

  if (!nama) {
    showToast('Harap masukkan Nama Lengkap Petugas', 'error');
    return;
  }
  if (!email || email.indexOf('@') === -1 || email.indexOf('.') === -1) {
    showToast('Harap masukkan alamat Email yang valid untuk menerima OTP', 'error');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Mengirim Kode OTP...</span>';
  }

  try {
    const res = await api.sendOtp(nama, email);
    if (res && res.success) {
      playSuccessChime();
      showToast(res.message, 'success');

      // Tampilkan Step 2 (Input OTP)
      document.getElementById('packerStep1').style.display = 'none';
      document.getElementById('packerStep2').style.display = 'block';
      document.getElementById('displayTargetEmail').innerText = email;
      const otpInput = document.getElementById('packerOtpInput');
      if (otpInput) {
        otpInput.value = '';
        otpInput.focus();
      }
    } else {
      showToast('Gagal: ' + (res ? res.message : 'Terjadi kesalahan saat kirim email OTP'), 'error');
    }
  } catch (err) {
    showToast('Error koneksi: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg><span>Kirim Kode OTP</span>`;
    }
  }
}

async function submitVerifyOtp() {
  const email = document.getElementById('packerEmailInput').value.trim().toLowerCase();
  const otp = document.getElementById('packerOtpInput').value.trim();
  const btn = document.getElementById('btnVerifyOtp');

  if (!otp || otp.length < 6) {
    showToast('Masukkan 6 digit kode OTP yang dikirim ke email Anda', 'error');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Memverifikasi...</span>';
  }

  try {
    const res = await api.verifyOtp(email, otp);
    if (res && res.success) {
      playSuccessChime();
      currentPacker = res.packer;
      localStorage.setItem(STORAGE_PACKER_KEY, JSON.stringify(currentPacker));

      updatePackerHeaderUi();
      hidePackerModal();
      showToast(res.message, 'success');
    } else {
      showToast('Verifikasi Gagal: ' + (res ? res.message : 'Kode OTP salah atau kedaluwarsa'), 'error');
    }
  } catch (err) {
    showToast('Error server: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Verifikasi & Buka Meja Packing</span>`;
    }
  }
}

function backToPackerStep1() {
  document.getElementById('packerStep2').style.display = 'none';
  document.getElementById('packerStep1').style.display = 'block';
}

function logoutPacker() {
  if (isContinuousMode) {
    toggleContinuousPackingMode(); // Hentikan mode beruntun jika sedang aktif
  }
  if (confirm('Apakah Anda yakin ingin keluar dari sesi petugas packing?')) {
    localStorage.removeItem(STORAGE_PACKER_KEY);
    currentPacker = null;
    showPackerModal();
    document.getElementById('packerStep2').style.display = 'none';
    document.getElementById('packerStep1').style.display = 'block';
    showToast('Berhasil logout.', 'success');
  }
}

// ============================================================================
// 3. KAMERA UNIVERSAL (STANDALONE)
// ============================================================================

async function checkInitialCameraState() {
  showCameraPromptOverlay();
}

function showCameraPromptOverlay() {
  const overlay = document.getElementById('cameraPermissionPrompt');
  if (overlay) {
    overlay.style.display = 'flex';
    document.getElementById('permTitle').innerText = 'Nyalakan Kamera Meja Packing';
    document.getElementById('permDesc').innerText = 'Klik tombol di bawah untuk mengaktifkan kamera bawaan Laptop, HP Android, atau iPhone Anda.';
    document.getElementById('permIconBox').className = 'perm-icon-wrapper';
  }
  const select = document.getElementById('cameraSelect');
  if (select) select.innerHTML = '<option value="">Menunggu Izin Kamera...</option>';
}

function showCameraDeniedOverlay() {
  const overlay = document.getElementById('cameraPermissionPrompt');
  if (overlay) {
    overlay.style.display = 'flex';
    document.getElementById('permTitle').innerText = 'Izin Kamera Belum Diberikan';
    document.getElementById('permDesc').innerHTML = 'Klik ikon <strong>Gembok (🔒)</strong> di samping URL atas, ubah Kamera menjadi <strong>Izinkan</strong>, lalu klik tombol di bawah:';
    document.getElementById('permIconBox').className = 'perm-icon-wrapper denied';
  }
  const select = document.getElementById('cameraSelect');
  if (select) select.innerHTML = '<option value="">Izin Kamera Ditolak</option>';
}

async function requestCameraAccess(showFeedback = true) {
  const btn = document.getElementById('btnRequestCamera');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Menghubungkan Kamera...</span>';
  }

  try {
    currentStream = await getBestMediaStream(null, currentFacingMode);
    
    const videoElement = document.getElementById('webcamVideo');
    videoElement.muted = true;
    videoElement.setAttribute('playsinline', 'true');
    videoElement.setAttribute('webkit-playsinline', 'true');
    videoElement.srcObject = currentStream;

    videoElement.onloadedmetadata = () => {
      videoElement.play().catch(e => console.warn('Play warn:', e));
    };

    try {
      await videoElement.play();
    } catch (e) {}

    const overlay = document.getElementById('cameraPermissionPrompt');
    if (overlay) overlay.style.display = 'none';

    await refreshCameraDeviceList();
    startBarcodeScanningLoop();

    if (showFeedback) {
      playSuccessChime();
      showToast('Kamera meja packing berhasil aktif!', 'success');
    }
  } catch (err) {
    console.error('Gagal menyalakan kamera:', err);
    handleCameraError(err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Izinkan & Nyalakan Kamera</span>`;
    }
  }
}

async function getBestMediaStream(preferredDeviceId, facingPreference) {
  const attempts = [
    {
      video: {
        ...(preferredDeviceId ? { deviceId: { exact: preferredDeviceId } } : {}),
        ...(!preferredDeviceId && facingPreference ? { facingMode: { ideal: facingPreference } } : {}),
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    },
    {
      video: facingPreference ? { facingMode: facingPreference } : true,
      audio: false
    },
    { video: true, audio: false }
  ];

  let lastError = null;
  for (let i = 0; i < attempts.length; i++) {
    try {
      return await navigator.mediaDevices.getUserMedia(attempts[i]);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function refreshCameraDeviceList() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    availableVideoDevices = devices.filter(d => d.kind === 'videoinput');

    const select = document.getElementById('cameraSelect');
    if (!select) return;

    select.innerHTML = '';
    if (availableVideoDevices.length === 0) {
      select.innerHTML = '<option value="">Kamera Default Aktif</option>';
      return;
    }

    let activeDeviceId = '';
    if (currentStream) {
      const activeTrack = currentStream.getVideoTracks()[0];
      if (activeTrack) {
        const settings = activeTrack.getSettings();
        activeDeviceId = settings.deviceId;
      }
    }

    availableVideoDevices.forEach((dev, index) => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.text = dev.label || `Kamera ${index + 1}`;
      if (dev.deviceId === activeDeviceId) opt.selected = true;
      select.appendChild(opt);
    });
  } catch (err) {}
}

async function changeCameraDevice(deviceId) {
  if (!deviceId) return;
  stopBarcodeScanningLoop();
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }

  try {
    currentStream = await getBestMediaStream(deviceId, null);
    const video = document.getElementById('webcamVideo');
    video.srcObject = currentStream;
    await video.play();
    startBarcodeScanningLoop();
    showToast('Beralih ke kamera pilihan', 'success');
  } catch (err) {
    showToast('Gagal beralih kamera: ' + err.message, 'error');
  }
}

async function switchCameraFacing() {
  currentFacingMode = (currentFacingMode === 'environment') ? 'user' : 'environment';
  stopBarcodeScanningLoop();
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }

  try {
    currentStream = await getBestMediaStream(null, currentFacingMode);
    const video = document.getElementById('webcamVideo');
    video.srcObject = currentStream;
    await video.play();
    await refreshCameraDeviceList();
    startBarcodeScanningLoop();
    showToast(`Beralih ke kamera ${currentFacingMode === 'environment' ? 'Belakang' : 'Depan'}`, 'success');
  } catch (err) {
    showToast('Gagal membalik kamera: ' + err.message, 'error');
  }
}

function handleCameraError(err) {
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    showCameraDeniedOverlay();
    showToast('Izin kamera ditolak. Silakan izinkan akses kamera di ikon gembok browser.', 'error');
  } else if (err.name === 'NotFoundError') {
    showToast('Kamera tidak ditemukan pada perangkat ini.', 'error');
  } else if (err.name === 'NotReadableError') {
    showToast('Kamera sedang digunakan oleh aplikasi lain. Tutup aplikasi lain dan coba lagi.', 'error');
  } else {
    showToast('Gagal mengakses kamera: ' + err.message, 'error');
  }
}

// ============================================================================
// 4. SCANNER RESI CERDAS (NATIVE + ZXING TRY-HARDER CENTER-CROP)
// ============================================================================

function startBarcodeScanningLoop() {
  if (barcodeScanInterval) clearInterval(barcodeScanInterval);
  isScanningActive = true;
  document.getElementById('scanBtnText').innerText = "Scanner Aktif";
  document.getElementById('scannerGuide').style.display = 'flex';

  barcodeScanInterval = setInterval(() => {
    scanCurrentVideoFrame();
  }, 160);
}

function stopBarcodeScanningLoop() {
  if (barcodeScanInterval) {
    clearInterval(barcodeScanInterval);
    barcodeScanInterval = null;
  }
  isScanningActive = false;
  document.getElementById('scanBtnText').innerText = "Scan Ulang Resi";
}

function toggleBarcodeScanner() {
  if (isScanningActive) {
    stopBarcodeScanningLoop();
    showToast('Scanner dihentikan sementara', 'error');
  } else {
    startBarcodeScanningLoop();
    showToast('Scanner barcode aktif', 'success');
  }
}

async function scanCurrentVideoFrame() {
  if (!isScanningActive || isScanningFrame || isProcessingAutoCut) return;
  const video = document.getElementById('webcamVideo');
  if (!video || video.readyState < 2 || video.paused || video.ended) return;

  isScanningFrame = true;

  try {
    // 1. Prioritaskan Native BarcodeDetector (Sangat cepat di HP Android / iOS / Safari)
    if (nativeBarcodeDetector) {
      try {
        const barcodes = await nativeBarcodeDetector.detect(video);
        if (barcodes && barcodes.length > 0) {
          const rawValue = barcodes[0].rawValue;
          if (rawValue && rawValue.trim()) {
            handleBarcodeFound(rawValue);
            return;
          }
        }
      } catch (err) {}
    }

    // 2. Fallback ZXing Reader (Universal Engine untuk semua Laptop/PC yang tidak didukung BarcodeDetector)
    if (zxingMultiReader) {
      if (!scanCanvas) {
        scanCanvas = document.createElement('canvas');
      }

      const vw = video.videoWidth || 640;
      const vh = video.videoHeight || 480;

      // Pass 1: Zoom ke area tengah (viewfinder) untuk mengatasi kamera laptop fixed-focus
      const cropW = Math.floor(vw * 0.7);
      const cropH = Math.floor(vh * 0.55);
      const cropX = Math.floor((vw - cropW) / 2);
      const cropY = Math.floor((vh - cropH) / 2);

      scanCanvas.width = cropW;
      scanCanvas.height = cropH;
      const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      try {
        const result = zxingMultiReader.decodeFromCanvas(scanCanvas);
        if (result && result.getText()) {
          handleBarcodeFound(result.getText());
          return;
        }
      } catch (zxErr) {
        // Pass 2: Jika di area tengah belum ketemu, coba scan full-frame
        try {
          scanCanvas.width = vw;
          scanCanvas.height = vh;
          ctx.drawImage(video, 0, 0, vw, vh);
          const fullResult = zxingMultiReader.decodeFromCanvas(scanCanvas);
          if (fullResult && fullResult.getText()) {
            handleBarcodeFound(fullResult.getText());
            return;
          }
        } catch (fullErr) {}
      }
    }
  } finally {
    isScanningFrame = false;
  }
}

function handleBarcodeFound(decodedText) {
  const cleanResi = decodedText.trim().toUpperCase();
  if (!cleanResi) return;

  // JIKA MODE PACKING BERUNTUN AKTIF: JALANKAN AUTO-CUT!
  if (isContinuousMode) {
    triggerAutoCutContinuous(cleanResi);
    return;
  }

  // JIKA MODE MANUAL:
  if (isRecording) return; // Jangan ganti resi di tengah rekaman manual

  playBeep(987.77, 0.15);
  stopBarcodeScanningLoop();

  document.getElementById('wmResiText').innerText = 'RESI: ' + cleanResi;
  showToast('Barcode Terdeteksi: ' + cleanResi, 'success');

  fetchResiDetails(cleanResi);
}

function searchResiManual() {
  const input = document.getElementById('manualResiInput');
  const resi = input.value.trim().toUpperCase();
  if (!resi) {
    showToast('Masukkan no resi terlebih dahulu', 'error');
    return;
  }

  if (isContinuousMode) {
    triggerAutoCutContinuous(resi);
    input.value = '';
    return;
  }

  document.getElementById('wmResiText').innerText = 'RESI: ' + resi;
  fetchResiDetails(resi);
}

// ============================================================================
// 5. DETAIL RESI & CHECKLIST
// ============================================================================

async function fetchResiDetails(noResi) {
  const statusBadge = document.getElementById('packingStatusBadge');
  statusBadge.className = 'badge';
  statusBadge.style.background = '#0284c7';
  statusBadge.style.color = '#fff';
  statusBadge.innerText = 'Mencari Data...';

  try {
    const response = await api.searchResi(noResi);

    if (response && response.success && response.data) {
      currentOrderData = response;
      renderActiveOrder(response.data, response.items || []);
      playSuccessChime();
    } else {
      // Jika resi belum terdaftar di pre-upload Excel, buatkan kartu instan (No-Excel flow)
      currentOrderData = {
        data: {
          noResi: noResi,
          namaPembeli: '-',
          ekspedisi: '-',
          statusPacking: 'BELUM'
        },
        items: [
          { namaProduk: 'Paket Pesanan Resi ' + noResi, variasi: '-', qty: 1 }
        ]
      };
      renderActiveOrder(currentOrderData.data, currentOrderData.items);
      showToast('Resi baru terdeteksi! Siap dipacking.', 'success');
    }
  } catch (err) {
    showToast('Pencarian data resi offline: ' + err.message, 'error');
  }
}

function renderActiveOrder(orderMeta, items) {
  document.getElementById('emptyChecklistState').style.display = 'none';
  document.getElementById('activeOrderContainer').style.display = 'block';

  document.getElementById('activeResiText').innerText = orderMeta.noResi;
  document.getElementById('activeBuyerText').innerText = orderMeta.namaPembeli || '-';
  document.getElementById('activeCourierText').innerText = orderMeta.ekspedisi || '-';

  const statusBadge = document.getElementById('packingStatusBadge');
  if (orderMeta.statusPacking === 'SELESAI') {
    statusBadge.className = 'badge';
    statusBadge.style.background = '#dcfce7';
    statusBadge.style.color = '#15803d';
    statusBadge.innerText = 'SUDAH DIPACKING';
  } else {
    statusBadge.className = 'badge';
    statusBadge.style.background = '#fef3c7';
    statusBadge.style.color = '#b45309';
    statusBadge.innerText = 'SIAP DIPACKING';
  }

  const listContainer = document.getElementById('itemsChecklistList');
  listContainer.innerHTML = '';

  if (items && items.length > 0) {
    items.forEach((it, idx) => {
      const itemRow = document.createElement('div');
      itemRow.className = 'checklist-item';
      itemRow.id = `checkItem_${idx}`;

      itemRow.innerHTML = `
        <input type="checkbox" class="checklist-checkbox" id="chk_${idx}" onchange="toggleItemCheck(${idx})">
        <div class="checklist-item-info">
          <div class="checklist-item-title">${it.namaProduk}</div>
          <div class="checklist-item-variant">Varian: ${it.variasi || '-'} | Qty: ${it.qty || 1} pcs</div>
        </div>
        <div class="checklist-item-qty">x${it.qty || 1}</div>
      `;
      listContainer.appendChild(itemRow);
    });
  }
}

function toggleItemCheck(idx) {
  const chk = document.getElementById(`chk_${idx}`);
  const row = document.getElementById(`checkItem_${idx}`);
  if (chk && row) {
    if (chk.checked) {
      row.classList.add('checked');
      playBeep(880, 0.08);
    } else {
      row.classList.remove('checked');
    }
  }
}

function resetPackingState() {
  currentOrderData = null;
  document.getElementById('emptyChecklistState').style.display = 'block';
  document.getElementById('activeOrderContainer').style.display = 'none';
  document.getElementById('wmResiText').innerText = 'RESI: [BELUM SCAN]';

  const statusBadge = document.getElementById('packingStatusBadge');
  statusBadge.className = 'badge';
  statusBadge.style.background = '#334155';
  statusBadge.style.color = '#94a3b8';
  statusBadge.innerText = 'Menunggu Scan';

  startBarcodeScanningLoop();
}

// ============================================================================
// 6. ENGINE WATERMARK CANVAS (RESI + WAKTU WIB - TANPA NAMA PETUGAS DI VIDEO)
// ============================================================================

function startWatermarkClock() {
  setInterval(() => {
    const wmTimeText = document.getElementById('wmTimeText');
    if (wmTimeText) {
      wmTimeText.innerText = getWibTimeString();
    }
  }, 1000);
}

function getWibTimeString() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toTimeString().split(' ')[0];
  return `${dateStr} ${timeStr} WIB`;
}

function captureResiSnapshot() {
  const video = document.getElementById('webcamVideo');
  if (!video || !video.videoWidth) return '';
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

// ============================================================================
// 7. HANDS-FREE CONTINUOUS AUTO-CUT PACKING ENGINE (MODE BERUNTUN)
// ============================================================================

function toggleContinuousPackingMode() {
  if (!currentPacker) {
    showToast('Harap verifikasi identitas petugas packing terlebih dahulu.', 'error');
    showPackerModal();
    return;
  }

  if (!isContinuousMode) {
    // Mulai Mode Beruntun
    if (!currentStream) {
      requestCameraAccess(true).then(() => {
        setTimeout(startContinuousModeSession, 600);
      });
      return;
    }
    startContinuousModeSession();
  } else {
    // Hentikan Mode Beruntun
    stopContinuousModeSession();
  }
}

function startContinuousModeSession() {
  isContinuousMode = true;
  continuousPackageCount = 0;
  isProcessingAutoCut = false;
  activeContinuousResi = '';

  const btn = document.getElementById('btnToggleContinuous');
  if (btn) {
    btn.classList.add('active');
    btn.innerHTML = `<span>⏹ Selesai Shift Packing</span>`;
  }

  const badge = document.getElementById('continuousBadge');
  if (badge) {
    badge.style.display = 'inline-flex';
    badge.className = 'continuous-status-badge recording';
    badge.innerText = '🔴 Merekam Paket ke-1 (Hands-Free)';
  }

  playSuccessChime();
  showToast('Mode Beruntun Aktif! Video merekam non-stop. Sodorkan resi saat paket selesai.', 'success');

  // Mulai irisan video pertama
  startContinuousSliceRecorder();
}

function stopContinuousModeSession() {
  isContinuousMode = false;
  isProcessingAutoCut = false;

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  const btn = document.getElementById('btnToggleContinuous');
  if (btn) {
    btn.classList.remove('active');
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Mulai Mode Beruntun (Hands-Free)</span>`;
  }

  const badge = document.getElementById('continuousBadge');
  if (badge) badge.style.display = 'none';

  document.getElementById('recIndicator').style.display = 'none';
  document.getElementById('wmResiText').innerText = 'RESI: [BELUM SCAN]';

  showToast(`Mode Beruntun Dihentikan. Total ${continuousPackageCount} paket berhasil diselesaikan!`, 'success');
}

function startContinuousSliceRecorder() {
  const video = document.getElementById('webcamVideo');
  const canvas = document.getElementById('watermarkCanvas');
  if (!video || !video.videoWidth) return;

  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d');

  recordedChunks = [];

  function drawContinuousFrame() {
    if (!isContinuousMode) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Banner Watermark Bawah (Bersih: Hanya No Resi & Waktu WIB)
    const bannerHeight = 44;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(0, canvas.height - bannerHeight, canvas.width, bannerHeight);

    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(0, canvas.height - bannerHeight, canvas.width, 2);

    const timeStr = getWibTimeString();
    const displayResi = activeContinuousResi || '[PROSES PACKING BARANG]';

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px monospace';
    ctx.fillText(`RESI: ${displayResi}`, 18, canvas.height - 15);

    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'right';
    ctx.fillText(timeStr, canvas.width - 18, canvas.height - 15);
    ctx.textAlign = 'left';

    // Indikator REC di kiri atas canvas rekaman
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(28, 28, 9, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(`REC - PKG #${continuousPackageCount + 1}`, 44, 33);

    requestAnimationFrame(drawContinuousFrame);
  }

  drawContinuousFrame();

  const canvasStream = canvas.captureStream(24);
  const mimeType = getOptimalMimeType();

  try {
    const options = { videoBitsPerSecond: 1400000 };
    if (mimeType) options.mimeType = mimeType;
    mediaRecorder = new MediaRecorder(canvasStream, options);
  } catch (e) {
    mediaRecorder = new MediaRecorder(canvasStream);
  }

  mediaRecorder.ondataavailable = function(e) {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  mediaRecorder.start(1000);
  document.getElementById('recIndicator').style.display = 'inline-flex';
}

/**
 * AUTO-CUT: Dipicu otomatis saat resi disodorkan ke kamera di mode beruntun
 */
function triggerAutoCutContinuous(noResi) {
  if (isProcessingAutoCut) return; // Cooldown sedang aktif
  isProcessingAutoCut = true;

  // 1. Efek visual flash & suara konfirmasi
  const flash = document.getElementById('autocutFlashOverlay');
  if (flash) {
    flash.classList.add('flash');
    setTimeout(() => flash.classList.remove('flash'), 300);
  }
  playSuccessChime();

  // 2. Kunci nomor resi untuk watermark irisan ini
  activeContinuousResi = noResi;
  document.getElementById('wmResiText').innerText = 'RESI: ' + noResi;

  // 3. Ambil foto resi untuk AI OCR teks (motif, qty, nama pembeli)
  const labelSnapshot = captureResiSnapshot();

  // 4. Potong video paket ini dan simpan ke GDrive di latar belakang
  setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();

      mediaRecorder.onstop = function() {
        const mimeType = mediaRecorder ? (mediaRecorder.mimeType || 'video/webm') : 'video/webm';
        const videoBlob = new Blob(recordedChunks, { type: mimeType });

        // Unggah di latar belakang (Asynchronous) tanpa memblokir meja packing
        uploadContinuousVideoInBackground(noResi, videoBlob, mimeType, labelSnapshot);

        continuousPackageCount++;

        // Jika mode beruntun masih aktif: Mulai irisan video paket berikutnya!
        if (isContinuousMode) {
          activeContinuousResi = '';
          document.getElementById('wmResiText').innerText = 'RESI: [BELUM SCAN]';

          const badge = document.getElementById('continuousBadge');
          if (badge) {
            badge.innerText = `🔴 Merekam Paket ke-${continuousPackageCount + 1} (Hands-Free)`;
          }

          // Mulai rekam paket baru seketika
          startContinuousSliceRecorder();

          // Cooldown 3 detik agar resi yang sama tidak ter-scan dua kali
          setTimeout(() => {
            isProcessingAutoCut = false;
          }, 3000);
        }
      };
    }
  }, 400);
}

async function uploadContinuousVideoInBackground(noResi, videoBlob, mimeType, labelSnapshot) {
  const packer = currentPacker || { nama: 'Petugas', email: '-' };

  // Baca blob menjadi Base64
  const reader = new FileReader();
  reader.onloadend = async function() {
    let base64Data = reader.result;
    if (typeof base64Data === 'string') {
      const idx = base64Data.indexOf('base64,');
      if (idx !== -1) base64Data = base64Data.substring(idx + 7);
      base64Data = base64Data.replace(/\s+/g, '');
    }

    const payload = {
      noResi: noResi,
      namaPetugas: packer.nama,
      emailPetugas: packer.email,
      namaPembeli: '-',
      motif: '-',
      qty: 1,
      videoBase64: base64Data,
      mimeType: mimeType
    };

    try {
      // 1. Ekstraksi AI Vision dari foto resi jika ada snapshot
      if (labelSnapshot) {
        try {
          const aiRes = await api.parseResiImage(labelSnapshot, noResi);
          if (aiRes && aiRes.success && aiRes.data) {
            payload.namaPembeli = aiRes.data.namaPembeli || '-';
            payload.motif = aiRes.data.motif || aiRes.data.namaProduk || '-';
            payload.qty = aiRes.data.qty || 1;
            payload.ekspedisi = aiRes.data.ekspedisi || '-';
          }
        } catch (e) {}
      }

      // 2. Simpan Video ke Google Drive + Catat Petugas ke Google Sheets
      const response = await api.saveVideo(payload);
      if (response && response.success) {
        showToast(`✓ Video resi ${noResi} berhasil disimpan ke GDrive! (Petugas: ${packer.nama})`, 'success');
      } else {
        showToast(`Gagal simpan resi ${noResi}: ` + (response ? response.message : 'Error'), 'error');
      }
    } catch (err) {
      showToast(`Error upload resi ${noResi}: ` + err.message, 'error');
    }
  };
  reader.readAsDataURL(videoBlob);
}

// ============================================================================
// 8. PEREKAMAN VIDEO MANUAL (OPSI STANDAR)
// ============================================================================

function startPackingRecording() {
  if (!currentPacker) {
    showToast('Harap verifikasi identitas petugas packing terlebih dahulu.', 'error');
    showPackerModal();
    return;
  }

  if (!currentOrderData) {
    showToast('Scan resi terlebih dahulu sebelum merekam', 'error');
    return;
  }

  const video = document.getElementById('webcamVideo');
  const canvas = document.getElementById('watermarkCanvas');
  if (!video || !video.videoWidth) {
    showToast('Kamera belum siap merekam', 'error');
    return;
  }

  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d');

  isRecording = true;
  recordedChunks = [];

  function drawFrame() {
    if (!isRecording) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Watermark Bawah (Bersih: Hanya No Resi & Waktu WIB)
    const bannerHeight = 44;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(0, canvas.height - bannerHeight, canvas.width, bannerHeight);

    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(0, canvas.height - bannerHeight, canvas.width, 2);

    const timeStr = getWibTimeString();
    const noResi = currentOrderData.data.noResi;

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px monospace';
    ctx.fillText(`RESI: ${noResi}`, 18, canvas.height - 15);

    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'right';
    ctx.fillText(timeStr, canvas.width - 18, canvas.height - 15);
    ctx.textAlign = 'left';

    // Indikator REC di kiri atas canvas
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(28, 28, 9, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('REC', 44, 33);

    requestAnimationFrame(drawFrame);
  }

  drawFrame();

  const canvasStream = canvas.captureStream(24);
  const mimeType = getOptimalMimeType();

  try {
    const options = { videoBitsPerSecond: 1400000 };
    if (mimeType) options.mimeType = mimeType;
    mediaRecorder = new MediaRecorder(canvasStream, options);
  } catch (e) {
    mediaRecorder = new MediaRecorder(canvasStream);
  }

  mediaRecorder.ondataavailable = function(e) {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  mediaRecorder.start(1000);

  document.getElementById('recIndicator').style.display = 'inline-flex';
  document.getElementById('btnStartRecord').style.display = 'none';
  document.getElementById('btnStopRecord').style.display = 'inline-flex';

  recordSeconds = 0;
  updateRecTimerDisplay();
  recordTimerInterval = setInterval(() => {
    recordSeconds++;
    updateRecTimerDisplay();
  }, 1000);

  playBeep(440, 0.15);
  showToast('Mulai merekam proses packing...', 'success');
}

function stopPackingRecording() {
  if (!isRecording) return;
  isRecording = false;

  if (recordTimerInterval) {
    clearInterval(recordTimerInterval);
    recordTimerInterval = null;
  }

  document.getElementById('recIndicator').style.display = 'none';
  const btnStop = document.getElementById('btnStopRecord');
  btnStop.disabled = true;
  btnStop.innerHTML = `<span>Menyimpan & Mengunggah ke GDrive...</span>`;

  mediaRecorder.stop();

  setTimeout(async () => {
    const mimeType = mediaRecorder ? (mediaRecorder.mimeType || 'video/webm') : 'video/webm';
    const videoBlob = new Blob(recordedChunks, { type: mimeType });
    
    const reader = new FileReader();
    reader.onloadend = async function() {
      let base64Data = reader.result;
      if (typeof base64Data === 'string') {
        const base64Idx = base64Data.indexOf('base64,');
        if (base64Idx !== -1) {
          base64Data = base64Data.substring(base64Idx + 7);
        }
        base64Data = base64Data.replace(/\s+/g, '');
      }
      await uploadVideoToGoogleDrive(base64Data, mimeType);
    };
    reader.readAsDataURL(videoBlob);
  }, 300);
}

async function uploadVideoToGoogleDrive(videoBase64, mimeType) {
  const packer = currentPacker || { nama: 'Petugas', email: '-' };
  const noResi = currentOrderData.data.noResi;
  const buyerName = currentOrderData.data.namaPembeli || '-';
  const items = currentOrderData.items || [];
  const primaryItem = items.length > 0 ? items[0] : {};

  const payload = {
    noResi: noResi,
    namaPetugas: packer.nama,
    emailPetugas: packer.email,
    namaPembeli: buyerName,
    namaProduk: primaryItem.namaProduk || '-',
    motif: primaryItem.variasi || '-',
    qty: primaryItem.qty || 1,
    ekspedisi: currentOrderData.data.ekspedisi || '-',
    videoBase64: videoBase64,
    mimeType: mimeType
  };

  const btnStop = document.getElementById('btnStopRecord');

  try {
    const response = await api.saveVideo(payload);
    btnStop.disabled = false;
    btnStop.innerHTML = `<span>Selesai & Unggah ke GDrive</span>`;

    if (response && response.success) {
      playSuccessChime();
      showToast(`Berhasil! Video resi ${noResi} tersimpan di Google Drive.`, 'success');
      resetPackingState();
    } else {
      showToast('Gagal upload: ' + (response ? response.message : 'Error'), 'error');
    }
  } catch (err) {
    btnStop.disabled = false;
    btnStop.innerHTML = `<span>Selesai & Unggah ke GDrive</span>`;
    showToast('Error server: ' + err.message, 'error');
  }
}

function updateRecTimerDisplay() {
  const mins = String(Math.floor(recordSeconds / 60)).padStart(2, '0');
  const secs = String(recordSeconds % 60).padStart(2, '0');
  const timerElem = document.getElementById('recTimer');
  if (timerElem) timerElem.innerText = `${mins}:${secs}`;
}

function getOptimalMimeType() {
  const types = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4'
  ];
  for (let t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function setupKeyboardShortcuts() {
  window.addEventListener('keydown', function(e) {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      if (isContinuousMode) {
        toggleContinuousPackingMode();
      } else if (isRecording) {
        stopPackingRecording();
      } else if (currentOrderData) {
        startPackingRecording();
      }
    }
  });
}

// ============================================================================
// 9. DASHBOARD, DISPUTE GENERATOR & EXCEL
// ============================================================================

async function loadDashboardData() {
  const tbody = document.getElementById('dashboardTableBody');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:2rem; color:var(--text-muted);">Mengambil data riwayat packing...</td></tr>`;

  try {
    const res = await api.getDashboard();
    if (res && res.success) {
      dashboardCache = res.recentRows || [];
      document.getElementById('statTotalOrders').innerText = res.summary.total || 0;
      document.getElementById('statTotalSelesai').innerText = res.summary.selesai || 0;
      document.getElementById('statTotalBelum').innerText = res.summary.belum || 0;
      renderDashboardTable(dashboardCache);
    } else {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:2rem; color:#ef4444;">Gagal memuat data dashboard.</td></tr>`;
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:2rem; color:#ef4444;">Error: ${err.message}</td></tr>`;
  }
}

function renderDashboardTable(rows) {
  const tbody = document.getElementById('dashboardTableBody');
  tbody.innerHTML = '';

  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:2rem; color:var(--text-muted);">Belum ada riwayat packing.</td></tr>`;
    return;
  }

  rows.forEach(r => {
    const tr = document.createElement('tr');
    const isSelesai = r.statusPacking === 'SELESAI';
    const statusHtml = isSelesai
      ? `<span class="badge" style="background:#dcfce7; color:#15803d; font-weight:700;">SELESAI</span>`
      : `<span class="badge" style="background:#fef3c7; color:#b45309; font-weight:700;">BELUM</span>`;

    const videoBtn = r.videoUrl
      ? `<a href="${r.videoUrl}" target="_blank" class="btn btn-secondary" style="font-size:0.75rem; padding:0.25rem 0.55rem;">Lihat Video</a>`
      : `<span style="color:var(--text-muted); font-size:0.75rem;">-</span>`;

    const disputeBtn = `<button class="btn btn-secondary" style="font-size:0.75rem; padding:0.25rem 0.55rem;" onclick='openDisputeModal(${JSON.stringify(r)})'>Banding</button>`;

    tr.innerHTML = `
      <td><strong>${r.noResi}</strong></td>
      <td>${r.namaPembeli || '-'}</td>
      <td>${r.namaProduk || r.variasi || '-'}</td>
      <td>${r.ekspedisi || '-'}</td>
      <td>${statusHtml}</td>
      <td style="font-size:0.8rem; color:var(--text-muted);">${r.waktuPacking || '-'}</td>
      <td><span style="font-size:0.78rem; color:#38bdf8;">${r.namaPetugas || '-'}</span></td>
      <td>${videoBtn}</td>
      <td>${disputeBtn}</td>
    `;
    tbody.appendChild(tr);
  });
}

function filterDashboardTable() {
  const search = document.getElementById('dashboardSearch').value.toUpperCase();
  const filter = document.getElementById('statusFilter').value;

  const filtered = dashboardCache.filter(r => {
    const matchSearch = String(r.noResi).toUpperCase().includes(search) || String(r.namaPembeli).toUpperCase().includes(search);
    const matchFilter = (filter === 'ALL') || (r.statusPacking === filter);
    return matchSearch && matchFilter;
  });

  renderDashboardTable(filtered);
}

function openDisputeModal(record) {
  const modal = document.getElementById('disputeModal');
  const textarea = document.getElementById('disputeTextContent');

  const text = 
`Yth. Tim Resolusi Marketplace (Shopee / Tokopedia / TikTok Shop),

Sehubungan dengan pengajuan komplain/retur pesanan dengan rincian berikut:
- Nomor Resi / AWB : ${record.noResi}
- Nama Penerima    : ${record.namaPembeli || '-'}
- Produk / Variasi : ${record.namaProduk || record.variasi || '-'}
- Waktu Packing    : ${record.waktuPacking || '-'} WIB

Bersama ini kami lampirkan BUKTI VIDEO REKAMAN ASLI proses packing dari meja packing toko kami:
Tautan Video Google Drive: ${record.videoUrl || '[Link Video Belum Diunggah]'}

Pada rekaman video terlihat jelas:
1. Barang dalam kondisi baru, utuh, dan sesuai pesanan pembeli.
2. Proses pembungkusan aman menggunakan polymailer/bubble wrap berstandar SOP.
3. Label resi ditempelkan secara sah di atas kemasan paket.

Oleh karena itu, kami memohon agar dana pesanan dapat segera diteruskan ke saldo penjual dan klaim retur ditolak. Terima kasih atas kerja samanya.`;

  textarea.value = text;
  modal.style.display = 'flex';
}

function closeDisputeModal() {
  document.getElementById('disputeModal').style.display = 'none';
}

function copyDisputeText() {
  const textarea = document.getElementById('disputeTextContent');
  textarea.select();
  document.execCommand('copy');
  const btn = document.getElementById('btnCopyText');
  btn.innerText = 'Tersalin!';
  setTimeout(() => btn.innerText = 'Salin Teks Banding', 2000);
  showToast('Teks banding berhasil disalin ke clipboard!', 'success');
}

// ============================================================================
// 10. TAB SETTINGS: URL API & KONEKSI
// ============================================================================

function initApiSettingsInput() {
  const input = document.getElementById('gasApiUrlInput');
  if (input) {
    input.value = api.getUrl();
  }
}

function saveApiUrlFromInput() {
  const input = document.getElementById('gasApiUrlInput');
  const url = input.value.trim();
  if (!url) {
    showToast('Harap masukkan URL Web App Google Apps Script', 'error');
    return;
  }

  if (url.includes('googleusercontent.com')) {
    showToast('URL SALAH: Anda menyalin dari address bar browser! Salin URL asli dari jendela Deploy Apps Script yang berakhiran /exec', 'error');
    return;
  }

  if (!url.includes('script.google.com/macros/s/')) {
    showToast('Format URL tidak dikenali. URL harus diawali https://script.google.com/macros/s/.../exec', 'error');
    return;
  }

  api.setUrl(url);
  showToast('URL Google Apps Script berhasil disimpan!', 'success');
  checkSystemStatus();
}

/**
 * Salin Magic Link untuk Karyawan (Langsung Auto-Connect di HP Karyawan)
 */
function copyEmployeeWhatsAppLink() {
  const currentUrl = api.getUrl();
  if (!currentUrl) {
    showToast('Harap masukkan dan simpan URL Apps Script terlebih dahulu di atas.', 'error');
    return;
  }

  const baseUrl = window.location.origin + window.location.pathname;
  const magicLink = `${baseUrl}?gas=${encodeURIComponent(currentUrl)}`;

  function fallbackCopy(text) {
    const tempInput = document.createElement('input');
    tempInput.value = text;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand('copy');
    document.body.removeChild(tempInput);
    showToast('✓ Link WhatsApp disalin! Kirimkan link ini ke HP karyawan.', 'success');
    playSuccessChime();
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(magicLink).then(() => {
      showToast('✓ Link WhatsApp disalin! Kirimkan link ini ke HP karyawan.', 'success');
      playSuccessChime();
    }).catch(() => fallbackCopy(magicLink));
  } else {
    fallbackCopy(magicLink);
  }
}

async function checkSystemStatus() {
  const url = api.getUrl();
  if (!url) {
    showToast('Masukkan URL Apps Script di tab Pengaturan terlebih dahulu', 'error');
    return;
  }

  showToast('Memeriksa koneksi ke Google Apps Script...', 'success');
  try {
    const status = await api.checkStatus();
    if (status && status.success) {
      const link = document.getElementById('systemFolderLink');
      if (link && status.rootFolderUrl) {
        link.href = status.rootFolderUrl;
        link.innerText = `Buka Folder Master (${status.rootFolderName})`;
      }
      const sheetLink = document.getElementById('systemSheetLink');
      if (sheetLink && status.spreadsheetUrl) {
        sheetLink.href = status.spreadsheetUrl;
        sheetLink.innerText = status.spreadsheetName;
      }
      playSuccessChime();
      showToast('Koneksi Normal! Terhubung ke Google Drive 5 TB & Spreadsheet.', 'success');
    }
  } catch (err) {
    showToast('Koneksi Gagal: ' + err.message, 'error');
  }
}

async function triggerManualCleanup() {
  if (!confirm('Apakah Anda yakin ingin menjalankan pengecekan & pembersihan video yang berusia lebih dari 45 hari sekarang?')) {
    return;
  }

  showToast('Menjalankan pembersihan video > 45 hari...', 'success');
  try {
    const res = await api.manualCleanup();
    if (res && res.success) {
      showToast(`Pembersihan selesai! ${res.deletedCount} folder expired dipindahkan ke Sampah GDrive.`, 'success');
      loadDashboardData();
    } else {
      showToast('Gagal: ' + (res ? res.message : 'Error'), 'error');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// ============================================================================
// 11. TOAST NOTIFICATION UTILITY
// ============================================================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  let icon = 'ℹ️';
  if (type === 'success') icon = '✓';
  if (type === 'error') icon = '⚠️';

  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
