'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * `worker.start()` hanya boleh dipanggil SEKALI per halaman.
 *
 * React 19 StrictMode sengaja mount -> unmount -> remount setiap effect
 * di mode dev. Tanpa penjaga di bawah, `worker.start()` terpanggil dua kali
 * dan MSW melempar `Invariant Violation: cannot configure an already enabled
 * network` yang tidak tertangkap. Menjaga promise di level modul membuat
 * pemanggilan kedua ikut menunggu hasil yang sama, bukan memulai worker lagi.
 */
let startPromise: Promise<void> | null = null;

function startMockWorkerOnce(): Promise<void> {
  startPromise ??= (async () => {
    const { worker } = await import('@/mocks/browser');
    await worker.start({ onUnhandledRequest: 'bypass' });
  })();
  return startPromise;
}

/**
 * Gerbang mock API dev-only (MSW v2).
 *
 * `msw/browser` hanya boleh masuk bundel klien lewat dynamic `import()` di
 * bawah — import statis akan menyeret klien service-worker ke bundel server.
 * Render `null` sampai worker siap agar paint pertama tidak berpacu dengan
 * registrasi service worker.
 *
 * GERBANG PENTING: `process.env.NODE_ENV` di-substitusi Next.js saat build
 * (`'production'` pada build produksi), sehingga bundel bisa membuang seluruh
 * cabang ini beserta chunk msw-nya. JANGAN hanya bergantung pada
 * `NEXT_PUBLIC_API_MOCKING`: variabel `NEXT_PUBLIC_*` ikut di-inline, jadi
 * nilainya ikut ter-bake dan cabangnya tidak pernah ter-eliminasi — mock
 * lalu ikut terkirim ke produksi.
 */
export default function MswProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function init(): Promise<void> {
      const isDev = process.env.NODE_ENV === 'development';
      const isMockEnabled = process.env.NEXT_PUBLIC_API_MOCKING === 'enabled';
      if (!isDev || !isMockEnabled) {
        if (!cancelled) {
          setReady(true);
        }
        return;
      }
      try {
        await startMockWorkerOnce();
      } catch (error) {
        // Mock gagal start = devs tetap harus bisa membuka aplikasi, hanya
        // saja tanpa data. Diam-diamkan supaya tidak jadi unhandled rejection.
        console.warn('[msw] mock API gagal diaktifkan:', error);
      }
      if (!cancelled) {
        setReady(true);
      }
    }

    void init();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return null;
  }
  return <>{children}</>;
}
