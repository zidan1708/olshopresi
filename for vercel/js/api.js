/**
 * ============================================================================
 * FRONTEND: API.JS - Jembatan Komunikasi Standalone Web ke Google Apps Script
 * ============================================================================
 */

/**
 * ============================================================================
 * PENGATURAN URL GOOGLE APPS SCRIPT BAWAAN (DEFAULT)
 * ============================================================================
 * Masukkan URL Web App Google Apps Script toko Anda di bawah ini SATU KALI SAJA.
 * Semua HP karyawan atau laptop packing yang membuka link web ini akan
 * LANGSUNG OTOMATIS TERHUBUNG ke Google Drive & Spreadsheet Anda!
 * (Format: https://script.google.com/macros/s/.../exec)
 */
const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbwf7yZvXXYlazmtMkeowzYrIMW0DjXjdRS7ziIqGrslNKgE10gqEKunRp5GAGHiowHWnw/exec';

const API_STORAGE_KEY = 'packguard_gas_api_url';

const api = {
  /**
   * Mengambil URL Google Apps Script:
   * 1. Cek dari Query Parameter URL (?gas=... atau ?api=...) yang dikirim via WhatsApp
   * 2. Cek dari LocalStorage HP/Laptop yang pernah tersimpan
   * 3. Fallback ke DEFAULT_GAS_URL (URL Bawaan toko)
   */
  getUrl() {
    // 1. Cek dari Query Parameter URL (Magic Link WhatsApp)
    try {
      if (typeof window !== 'undefined' && window.location && window.location.search) {
        const urlParams = new URLSearchParams(window.location.search);
        const queryGas = urlParams.get('gas') || urlParams.get('api');
        if (queryGas && queryGas.includes('script.google.com/macros/s/')) {
          const cleanParam = decodeURIComponent(queryGas).trim();
          localStorage.setItem(API_STORAGE_KEY, cleanParam);
          return cleanParam;
        }
      }
    } catch (e) {}

    // 2. Cek dari LocalStorage
    const saved = localStorage.getItem(API_STORAGE_KEY);
    if (saved && saved.trim()) {
      return saved.trim();
    }

    // 3. Fallback ke URL bawaan sistem
    return DEFAULT_GAS_URL.trim();
  },

  /**
   * Menyimpan URL Google Apps Script ke LocalStorage
   */
  setUrl(url) {
    const cleanUrl = String(url || '').trim();
    localStorage.setItem(API_STORAGE_KEY, cleanUrl);
    return cleanUrl;
  },

  /**
   * Mengirim request POST ke Google Apps Script API
   */
  async post(action, data = {}) {
    const apiUrl = this.getUrl();
    if (!apiUrl) {
      throw new Error('URL Google Apps Script belum disetel. Buka tab "Pengaturan" dan tempel URL Web App Anda.');
    }

    const payload = { action, ...data };

    try {
      // Browser fetch dengan redirect: 'follow' otomatis mengikuti 302 redirect Google Apps Script
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8' // Hindari preflight CORS strict di GAS
        },
        body: JSON.stringify(payload),
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      return result;
    } catch (err) {
      console.error('API Error:', err);
      throw new Error(err.message || 'Gagal menghubungi Google Apps Script.');
    }
  },

  /**
   * Mengirim request GET ke Google Apps Script API
   */
  async get(action, params = {}) {
    const apiUrl = this.getUrl();
    if (!apiUrl) {
      throw new Error('URL Google Apps Script belum disetel.');
    }

    const urlObj = new URL(apiUrl);
    urlObj.searchParams.set('action', action);
    for (const key in params) {
      urlObj.searchParams.set(key, params[key]);
    }

    try {
      const response = await fetch(urlObj.toString(), {
        method: 'GET',
        redirect: 'follow'
      });
      return await response.json();
    } catch (err) {
      console.error('API GET Error:', err);
      throw err;
    }
  },

  // ==========================================
  // METODE API PACKGUARD
  // ==========================================

  // 1. Kirim OTP ke Email Petugas
  async sendOtp(nama, email) {
    return await this.post('sendOtp', { nama, email });
  },

  // 2. Verifikasi OTP Petugas
  async verifyOtp(email, otp) {
    return await this.post('verifyOtp', { email, otp });
  },

  // 3. Simpan Video Packing ke GDrive (1 Resi 1 Folder)
  async saveVideo(payload) {
    return await this.post('saveVideo', payload);
  },

  // 4. Analisis & Baca Foto Resi (AI OCR)
  async parseResiImage(imageBase64, noResi = '') {
    return await this.post('parseResiImage', { imageBase64, noResi });
  },

  // 5. Upload Batch Resi Excel/CSV
  async uploadBatch(batchName, items) {
    return await this.post('uploadBatch', { batchName, items });
  },

  // 6. Pencarian Data Resi
  async searchResi(noResi) {
    return await this.post('searchResi', { noResi });
  },

  // 7. Ambil Data Dashboard & Statistik
  async getDashboard() {
    return await this.post('getDashboard');
  },

  // 8. Cek Status Koneksi Google Drive & Sheets
  async checkStatus() {
    return await this.post('checkStatus');
  },

  // 9. Jalankan Pembersihan Manual 45 Hari
  async manualCleanup() {
    return await this.post('manualCleanup');
  }
};
